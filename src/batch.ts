#!/usr/bin/env node

import fs from 'fs-extra';
import path from 'path';
import dotenv from 'dotenv';
import { Logger } from './lib/log';
import { SessionManager, SessionConfig } from './lib/session';
import { PageScanner } from './lib/pageScan';
import { UrlResolver } from './lib/resolver';
import { FileDownloader } from './lib/downloader';
import { ManifestManager } from './lib/manifest';

dotenv.config();

interface BatchConfig {
  chromeProfile?: string;
  cookieTank?: string;
  headless: boolean;
  hookMs: number;
  maxRetries: number;
  logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  dryRun: boolean;
  urlsFile: string;
  outputDir: string;
}

class BatchCollector {
  private config: BatchConfig;
  private logger: Logger;
  private sessionManager: SessionManager;
  private pageScanner: PageScanner;
  private urlResolver: UrlResolver;
  private manifestManager: ManifestManager;

  constructor(config: BatchConfig) {
    this.config = config;
    this.logger = new Logger(config.logLevel);
    
    const sessionConfig: SessionConfig = {
      chromeProfile: config.chromeProfile,
      cookieTank: config.cookieTank,
      headless: config.headless
    };
    
    this.sessionManager = new SessionManager(sessionConfig, this.logger);
    this.pageScanner = new PageScanner(this.logger);
    this.urlResolver = new UrlResolver(this.logger, config.hookMs);
    this.manifestManager = new ManifestManager(this.logger);
  }

  async run(): Promise<void> {
    this.logger.info('=== 배치 수집기 시작 ===');
    this.logger.info('설정 확인', {
      dryRun: this.config.dryRun,
      headless: this.config.headless,
      hookMs: this.config.hookMs
    });

    try {
      const urls = await this.loadUrls();
      if (urls.length === 0) {
        throw new Error('처리할 URL이 없습니다.');
      }

      this.logger.info('URL 로드 완료', { count: urls.length });

      const context = await this.sessionManager.initialize();
      
      let totalSuccess = 0;
      let totalMissingCodes: Set<string> = new Set();
      let totalFailedUrls = 0;

      for (const [index, url] of urls.entries()) {
        this.logger.info(`처리 중 (${index + 1}/${urls.length})`, { url });
        
        try {
          const result = await this.processUrl(context, url);
          
          if (result.success) {
            totalSuccess++;
            if (result.missingCodes) {
              result.missingCodes.forEach(code => totalMissingCodes.add(code));
            }
          } else {
            totalFailedUrls++;
          }
          
        } catch (error) {
          this.logger.error('URL 처리 실패', { url, error: error.message });
          totalFailedUrls++;
        }

        if ((index + 1) % 5 === 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      this.logger.summary({
        total: urls.length,
        success: totalSuccess,
        missingCodes: Array.from(totalMissingCodes),
        failedUrls: totalFailedUrls
      });

    } catch (error) {
      this.logger.error('배치 처리 중 치명적 오류', { error: error.message });
      throw error;
    } finally {
      await this.sessionManager.close();
      this.logger.info('=== 배치 수집기 종료 ===');
    }
  }

  private async processUrl(context: any, url: string): Promise<{
    success: boolean;
    missingCodes?: string[];
  }> {
    
    try {
      const page = await context.newPage();
      
      try {
        this.logger.debug('페이지 로드 시작', { url });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        const scanResult = await this.pageScanner.scanPage(page);
        this.logger.info('페이지 스캔 완료', {
          prefix: scanResult.caseInfo.prefix,
          candidates: scanResult.candidates.length
        });

        if (scanResult.candidates.length === 0) {
          this.logger.warn('후보 문서가 없습니다', { url });
          return { success: false };
        }

        const outputDir = path.join(this.config.outputDir, scanResult.caseInfo.prefix);
        await fs.ensureDir(outputDir);

        const existingManifest = await this.manifestManager.loadExistingManifest(outputDir);

        const resolvedUrls = [];
        for (const candidate of scanResult.candidates) {
          this.logger.debug('URL 해석 시작', { text: candidate.text });
          const resolved = await this.urlResolver.resolveCandidate(page, context, candidate);
          resolvedUrls.push(resolved);
        }

        const downloader = new FileDownloader(
          context, 
          outputDir, 
          this.logger, 
          this.config.maxRetries
        );

        const downloadResults = [];
        for (let i = 0; i < scanResult.candidates.length; i++) {
          const candidate = scanResult.candidates[i];
          const resolved = resolvedUrls[i];
          
          if (!resolved.success) {
            downloadResults.push({
              filename: `FAILED_${candidate.text.substring(0, 20)}`,
              filepath: '',
              size: 0,
              success: false,
              error: resolved.error
            });
            continue;
          }

          const extension = downloader.getFileExtension(resolved.contentType, resolved.finalUrl) ||
                           downloader.getDefaultExtensionForCode(candidate.code);
          
          const filename = this.manifestManager.generateUniqueFilename(
            candidate, resolved, extension, outputDir
          );

          const downloadResult = await downloader.downloadFile(
            resolved, filename, this.config.dryRun
          );
          downloadResults.push(downloadResult);
        }

        const newManifest = await this.manifestManager.createManifest(
          scanResult.caseInfo.prefix,
          scanResult.candidates,
          resolvedUrls,
          downloadResults,
          [url],
          outputDir
        );

        const finalManifest = existingManifest 
          ? await this.manifestManager.mergeManifests(existingManifest, newManifest)
          : newManifest;

        await fs.writeFile(
          path.join(outputDir, 'MANIFEST.json'),
          JSON.stringify(finalManifest, null, 2)
        );

        const validation = this.manifestManager.validateManifest(finalManifest);
        if (!validation.isValid) {
          this.logger.warn('매니페스트 검증 실패', { issues: validation.issues });
        }

        this.logger.info('URL 처리 완료', {
          prefix: scanResult.caseInfo.prefix,
          success: finalManifest.summary.successCount,
          missing: finalManifest.missing.length
        });

        return {
          success: true,
          missingCodes: finalManifest.missing
        };

      } finally {
        await page.close();
        this.urlResolver.clearCapturedRequests();
        this.manifestManager.clearFileCache();
      }

    } catch (error) {
      this.logger.error('URL 처리 중 오류', { url, error: error.message });
      return { success: false };
    }
  }

  private async loadUrls(): Promise<string[]> {
    try {
      if (!await fs.pathExists(this.config.urlsFile)) {
        throw new Error(`URLs 파일이 없습니다: ${this.config.urlsFile}`);
      }

      const content = await fs.readFile(this.config.urlsFile, 'utf8');
      const urls = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && line.startsWith('http'));

      return urls;
    } catch (error) {
      this.logger.error('URLs 로드 실패', { error: error.message });
      throw error;
    }
  }
}

function parseArgs(): BatchConfig {
  const args = process.argv.slice(2);
  
  const config: BatchConfig = {
    chromeProfile: process.env.CHROME_PROFILE,
    cookieTank: process.env.COOKIE_TANK,
    headless: process.env.HEADLESS !== 'false',
    hookMs: parseInt(process.env.HOOK_MS || '600'),
    maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
    logLevel: (process.env.LOG_LEVEL as any) || 'INFO',
    dryRun: false,
    urlsFile: 'urls.txt',
    outputDir: 'out'
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
        config.dryRun = true;
        break;
      case '--headless':
        config.headless = args[i + 1] !== 'false';
        i++;
        break;
      case '--urls':
        config.urlsFile = args[i + 1];
        i++;
        break;
      case '--output':
        config.outputDir = args[i + 1];
        i++;
        break;
      case '--log-level':
        config.logLevel = args[i + 1] as any;
        i++;
        break;
      case '--help':
        console.log(`
사용법: node dist/batch.js [옵션]

옵션:
  --dry-run          다운로드 생략, 분석만 수행
  --headless false   브라우저 UI 표시
  --urls <file>      URLs 파일 경로 (기본: urls.txt)
  --output <dir>     출력 디렉토리 (기본: out)
  --log-level <level> 로그 레벨: DEBUG, INFO, WARN, ERROR
  --help             이 도움말 표시

환경변수:
  CHROME_PROFILE     Chrome 프로필 경로
  COOKIE_TANK        쿠키 파일 경로
  HOOK_MS            클릭 후 대기시간 (ms)
  MAX_RETRIES        최대 재시도 횟수
        `);
        process.exit(0);
        break;
    }
  }

  return config;
}

async function main() {
  try {
    const config = parseArgs();
    const collector = new BatchCollector(config);
    await collector.run();
    process.exit(0);
  } catch (error) {
    console.error('프로그램 실행 실패:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { BatchCollector };