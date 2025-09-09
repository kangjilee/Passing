import { Config } from '../index';
import { TankAuctionVendor, debugDump } from '../vendors/tankauction';
import { RateLimiter } from '../utils/rate';
import { Downloader } from '../utils/download';
import { Manifest, Attachment } from '../utils/manifest';
import { ensureDir } from '../utils/fs';
import { createSafeFilename } from '../utils/slug';
import { extractSummary } from '../parsers/notice';
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
          console.error(`💥 [${i + 1}/${urls.length}] ${url} - ${error instanceof Error ? error.message : String(error)}`);
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

    // 3. 매니페스트 초기화 및 요약 추출
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
      
      // 로그인 리다이렉트 탐지
      const urlBefore = url;
      await page.waitForTimeout(500);
      const urlAfter = page.url();
      if (/login|member|signin/i.test(urlAfter) || new URL(urlAfter).hostname !== 'www.tankauction.com') {
        console.warn(`[AUTH] Redirected to login? before=${urlBefore} after=${urlAfter}`);
      }
      
      // Extract summary from detail page
      try {
        const summary = await extractSummary(page);
        manifest.setSummary(summary);
        
        // Save summary as JSON file
        if (!config.dryRun) {
          const summaryPath = path.join(caseOutputDir, `${visitResult.prefix}__NOI_02_summary.json`);
          await ensureDir(path.dirname(summaryPath));
          require('fs').writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
        }
      } catch (error) {
        manifest.addLog(`Summary extraction failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      // 4.5) Enhanced link collection
      const collectionResult = await vendor.collectLinksV2(page, visitResult.prefix, outputBaseDir);
      
      if (collectionResult.softEmpty) {
        // Treat as success but with missing codes
        const missing = config.codes.filter(code => ['AP', 'REG', 'BLD', 'ZON', 'RS'].includes(code));
        
        if (config.logLevel === 'debug') {
          console.log(`⚠️ ${visitResult.prefix}: No links found, treating as soft empty`);
        }
        
        await manifest.save(caseOutputDir);
        return {
          success: true,
          fileCount: 0,
          missingCodes: missing
        };
      }

      const filteredCandidates = vendor.filterAndMap(collectionResult.anchors, config.codes);

      if (config.logLevel === 'debug') {
        console.log(`🔍 ${filteredCandidates.length}개 후보 발견 (전체: ${collectionResult.anchors.length}개): ${filteredCandidates.map(c => c.label).join(', ')}`);
      }

      // 5. 처리: 링크별 종류에 따른 다운로드/기록
      for (let seq = 0; seq < filteredCandidates.length; seq++) {
        const candidate = filteredCandidates[seq];
        
        try {
          if (candidate.kind === 'link') {
            // MAP/PORTAL - 링크만 기록, 다운로드 안함
            manifest.add({
              kind: 'link',
              code: candidate.code || 'UNK',
              label: candidate.label,
              url: candidate.href,
              success: true
            });
            
            if (config.logLevel === 'debug') {
              console.log(`📋 [LINK] ${candidate.code}: ${candidate.label} -> ${candidate.href}`);
            }
            continue;
          }

          // File processing - 특수 처리가 필요한 코드들
          if (candidate.code === 'NOI') {
            // NOI: 페이지 캡처 (HTML/PNG/PDF)
            const noiResult = await vendor.captureNOI(page, visitResult.prefix, outputBaseDir);
            for (const filePath of noiResult.paths) {
              const stats = require('fs').statSync(filePath);
              manifest.add({
                kind: 'file',
                code: 'NOI',
                label: candidate.label,
                url: candidate.href,
                path: filePath,
                size: stats.size,
                ext: path.extname(filePath),
                success: true
              });
            }
            
            if (!noiResult.success) {
              manifest.add({
                kind: 'file',
                code: 'NOI',
                label: candidate.label,
                url: candidate.href,
                success: false,
                error: 'Page capture failed'
              });
            }
            continue;
          }

          if (candidate.code === 'IMG') {
            // IMG: 사진/앨범 다운로드
            const imgResult = await vendor.downloadIMG(page, candidate, visitResult.prefix, outputBaseDir, config.maxItems);
            for (const filePath of imgResult.paths) {
              const stats = require('fs').statSync(filePath);
              manifest.add({
                kind: 'file',
                code: 'IMG',
                label: candidate.label,
                url: candidate.href,
                path: filePath,
                size: stats.size,
                ext: path.extname(filePath),
                success: true
              });
            }
            
            if (!imgResult.success) {
              manifest.add({
                kind: 'file',
                code: 'IMG',
                label: candidate.label,
                url: candidate.href,
                success: false,
                error: 'Image download failed'
              });
            }
            continue;
          }

          if (candidate.code === 'RTR') {
            // RTR: 실거래 테이블/파일 다운로드
            const rtrResult = await vendor.downloadRTR(page, candidate, visitResult.prefix, outputBaseDir);
            for (const filePath of rtrResult.paths) {
              const stats = require('fs').statSync(filePath);
              manifest.add({
                kind: 'file',
                code: 'RTR',
                label: candidate.label,
                url: candidate.href,
                path: filePath,
                size: stats.size,
                ext: path.extname(filePath),
                success: true
              });
            }
            
            if (!rtrResult.success) {
              manifest.add({
                kind: 'file',
                code: 'RTR',
                label: candidate.label,
                url: candidate.href,
                success: false,
                error: 'RTR download failed'
              });
            }
            continue;
          }

          // 일반 파일 다운로드 (AP, REG, BLD, ZON, RS, TEN, NT)
          const filename = createSafeFilename(
            visitResult.prefix,
            candidate.code || 'UNK',
            String(seq + 1).padStart(2, '0'),
            candidate.label,
            '' // extension will be determined by content-type
          );
          
          const saveBase = path.join(caseOutputDir, filename);

          if (dryRun) {
            console.log(`🔄 [DRY] ${filename}.<ext> <- ${candidate.href}`);
            manifest.add({
              kind: 'file',
              code: candidate.code || 'UNK',
              label: candidate.label,
              url: candidate.href,
              path: saveBase + '.pdf', // Default for dry run
              hash: 'dry-run',
              size: 0,
              ext: 'pdf',
              success: true
            });
          } else {
            const downloadResult = await vendor.downloadFile(candidate, page, saveBase);

            if (downloadResult.success && downloadResult.path) {
              manifest.add({
                kind: 'file',
                code: candidate.code || 'UNK',
                label: candidate.label,
                url: candidate.href,
                path: downloadResult.path,
                hash: downloadResult.hash || '',
                size: downloadResult.size || 0,
                ext: downloadResult.ext || 'pdf',
                success: true
              });

              if (config.logLevel === 'debug') {
                console.log(`✅ ${path.basename(downloadResult.path)} (${downloadResult.size} bytes)`);
              }
            } else {
              // Failed to download file - treat as link only
              console.warn(`[SKIP] ${candidate.code} ${candidate.label} → ${downloadResult.error || 'HTML response'}. 링크로만 기록`);
              manifest.add({
                kind: 'link',
                code: 'PORTAL',
                label: candidate.label,
                url: candidate.href,
                success: true
              });
            }
          }

        } catch (error) {
          manifest.add({
            kind: 'file',
            code: candidate.code || 'UNK',
            label: candidate.label,
            url: candidate.href,
            success: false,
            error: error instanceof Error ? error.message : String(error)
          });

          if (config.logLevel === 'debug') {
            console.warn(`⚠️ ${candidate.label} - ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      // Check for missing BLD/ZON and warn
      const missingRequired = config.codes.filter(code => 
        ['BLD', 'ZON'].includes(code) && !manifest.getData().stats.codes.includes(code)
      );
      
      if (missingRequired.length > 0) {
        console.warn(`[MISSING] no ${missingRequired.join('/')} link on page, skip external issuance`);
        manifest.addLog(`Missing required codes: ${missingRequired.join(', ')} - external issuance may be needed`);
      }

      // 5.5) Final debug dump
      if (collectionResult.debugDir) {
        try {
          await debugDump(page, collectionResult.debugDir, '03_after');
        } catch (error) {
          // Debug dump is optional, continue on failure
        }
      }

      // 6. 매니페스트 저장
      manifest.finish();
      await manifest.save(caseOutputDir);

      const stats = manifest.getStats();
      const missing = manifest.getMissing();

      if (config.logLevel !== 'debug') {
        console.log(`✅ ${visitResult.prefix}: ${manifest.getSummary()}`);
      }

      return {
        success: true,
        fileCount: stats.ok,
        missingCodes: missing
      };

    } finally {
      await page.close();
    }

  } catch (error) {
    return {
      success: false,
      fileCount: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}