import { Config } from '../index';
import { TankAuctionVendor } from '../vendors/tankauction';
import { RateLimiter } from '../utils/rate';
import { Downloader } from '../utils/download';
import { Manifest, Attachment } from '../utils/manifest';
import { ensureDir } from '../utils/fs';
import { createSafeFilename } from '../utils/slug';
import path from 'path';

export interface PipelineOptions {
  urls: string[];
  config: Config;
  onProgress?: (current: number, total: number, url: string) => void;
}

export interface PipelineResult {
  success: number;
  failed: number;
  totalFiles: number;
  missingCodes: string[];
  failedUrls: string[];
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { urls, config, onProgress } = options;
  
  const result: PipelineResult = {
    success: 0,
    failed: 0,
    totalFiles: 0,
    missingCodes: [],
    failedUrls: []
  };

  // 출력 디렉토리 준비
  const outputBaseDir = path.resolve(config.outDir);
  await ensureDir(outputBaseDir);

  // 벤더 및 다운로더 초기화
  const vendor = new TankAuctionVendor();
  const rateLimiter = new RateLimiter(config.concurrency, config.qps);
  
  let context;
  try {
    context = await vendor.initializeSession(
      config.chromeProfile, 
      config.cookieTank, 
      config.headless
    );
    
    const downloader = new Downloader(context, rateLimiter, config.timeoutMs);
    
    // URL별 처리
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      
      if (onProgress) {
        onProgress(i + 1, urls.length, url);
      }

      try {
        const jobResult = await processUrl(url, {
          vendor,
          downloader,
          config,
          outputBaseDir,
          dryRun: config.dryRun
        });

        if (jobResult.success) {
          result.success++;
          result.totalFiles += jobResult.fileCount;
          
          // 누락 코드 수집
          if (jobResult.missingCodes) {
            for (const code of jobResult.missingCodes) {
              if (!result.missingCodes.includes(code)) {
                result.missingCodes.push(code);
              }
            }
          }
        } else {
          result.failed++;
          result.failedUrls.push(url);
          
          if (config.logLevel === 'debug') {
            console.error(`❌ [${i + 1}/${urls.length}] ${url} - ${jobResult.error}`);
          }
        }

      } catch (error) {
        result.failed++;
        result.failedUrls.push(url);
        
        if (config.logLevel === 'debug') {
          console.error(`💥 [${i + 1}/${urls.length}] ${url} - ${error.message}`);
        }
      }

      // QPS 준수를 위한 간격 조정 (5개마다 추가 대기)
      if ((i + 1) % 5 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // 남은 요청 완료 대기
    await rateLimiter.waitForCompletion();

  } finally {
    await vendor.close();
  }

  return result;
}

interface ProcessJobOptions {
  vendor: TankAuctionVendor;
  downloader: Downloader;
  config: Config;
  outputBaseDir: string;
  dryRun: boolean;
}

interface JobResult {
  success: boolean;
  fileCount: number;
  missingCodes?: string[];
  error?: string;
}

async function processUrl(url: string, options: ProcessJobOptions): Promise<JobResult> {
  const { vendor, downloader, config, outputBaseDir, dryRun } = options;
  
  try {
    // 1. 페이지 방문 및 사건 식별
    const visitResult = await vendor.open(url);
    if (!visitResult.success) {
      throw new Error(visitResult.error || 'Page visit failed');
    }

    // 2. 출력 디렉토리 생성
    const caseOutputDir = path.join(outputBaseDir, visitResult.prefix);
    await ensureDir(caseOutputDir);

    // 3. 매니페스트 초기화
    const manifest = new Manifest(
      url, 
      visitResult.title, 
      visitResult.prefix, 
      config.codes.filter(code => ['AP', 'REG', 'BLD', 'ZON', 'RS'].includes(code))
    );

    // 4. 링크 수집 (새로운 페이지에서 실행)
    const context = vendor.getContext();
    if (!context) {
      throw new Error('Browser context not available');
    }

    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      // 다시 섹션 찾기 (새 페이지에서)
      const sectionSelectors = [
        'text*="참고자료"', 'text*="자료"', 'text*="첨부"', 'text*="다운로드"',
        'text*="지도자료"', 'text*="지도"', 'text*="기타참고자료"', 'text*="기타"'
      ];

      let sectionHandle = null;
      for (const selector of sectionSelectors) {
        try {
          const element = page.locator(selector).first();
          if (await element.isVisible({ timeout: 2000 })) {
            const parent = element.locator('xpath=ancestor-or-self::*[contains(@class, "section") or contains(@class, "panel") or self::table or self::div][1]');
            sectionHandle = await parent.count() > 0 ? parent.first() : element;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!sectionHandle) {
        throw new Error('Section not found');
      }

      const candidates = await vendor.collectLinks(sectionHandle, config.maxItems);
      const filteredCandidates = vendor.filterAndMap(candidates, config.codes);

      if (config.logLevel === 'debug') {
        console.log(`🔍 ${filteredCandidates.length}개 후보 발견: ${filteredCandidates.map(c => c.label).join(', ')}`);
      }

      // 5. URL 해석 및 다운로드
      for (let seq = 0; seq < filteredCandidates.length; seq++) {
        const candidate = filteredCandidates[seq];
        
        try {
          // URL 해석
          const resolved = await vendor.resolveTargets(candidate, page);
          if (!resolved.success) {
            manifest.add({
              code: candidate.code || 'UNK',
              label: candidate.label,
              url: candidate.href,
              path: '',
              hash: '',
              size: 0,
              success: false,
              error: resolved.error
            });
            continue;
          }

          // 파일명 생성
          const extension = downloader.getFileExtension(
            undefined, 
            resolved.finalUrl, 
            candidate.code
          );
          const filename = createSafeFilename(
            visitResult.prefix,
            candidate.code || 'UNK',
            String(seq + 1).padStart(2, '0'),
            candidate.label,
            extension
          );

          // 다운로드
          if (dryRun) {
            console.log(`🔄 [DRY] ${filename} <- ${resolved.finalUrl}`);
            manifest.add({
              code: candidate.code || 'UNK',
              label: candidate.label,
              url: resolved.finalUrl,
              path: path.join(caseOutputDir, filename),
              hash: 'dry-run',
              size: 0,
              success: true
            });
          } else {
            const downloadResult = await downloader.download({
              url: resolved.finalUrl,
              outputPath: caseOutputDir,
              filename,
              referer: url,
              timeout: config.timeoutMs
            });

            manifest.add({
              code: candidate.code || 'UNK',
              label: candidate.label,
              url: resolved.finalUrl,
              path: downloadResult.path || '',
              hash: downloadResult.hash || '',
              size: downloadResult.size,
              success: downloadResult.success,
              error: downloadResult.error
            });

            if (downloadResult.success && config.logLevel === 'debug') {
              console.log(`✅ ${filename} (${downloadResult.size} bytes)`);
            }
          }

        } catch (error) {
          manifest.add({
            code: candidate.code || 'UNK',
            label: candidate.label,
            url: candidate.href,
            path: '',
            hash: '',
            size: 0,
            success: false,
            error: error.message
          });

          if (config.logLevel === 'debug') {
            console.warn(`⚠️ ${candidate.label} - ${error.message}`);
          }
        }
      }

      // 6. 매니페스트 저장
      await manifest.save(caseOutputDir);

      const stats = manifest.getStats();
      const missing = manifest.getMissing();

      if (config.logLevel !== 'debug') {
        console.log(`✅ ${visitResult.prefix}: ${manifest.getSummary()}`);
      }

      return {
        success: true,
        fileCount: stats.success,
        missingCodes: missing
      };

    } finally {
      await page.close();
    }

  } catch (error) {
    return {
      success: false,
      fileCount: 0,
      error: error.message
    };
  }
}