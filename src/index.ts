#!/usr/bin/env node

import fs from 'fs-extra';
import path from 'path';
import minimist from 'minimist';
import dotenv from 'dotenv';
import { runPipeline } from './pipeline/run';

dotenv.config();

interface Config {
  urls: string;
  outDir: string;
  dryRun: boolean;
  headless: boolean;
  logLevel: string;
  maxItems: number;
  codes: string[];
  chromeProfile?: string;
  cookieTank?: string;
  concurrency: number;
  qps: number;
  timeoutMs: number;
}

function parseArgs(): Config {
  const argv = minimist(process.argv.slice(2), {
    string: ['urls', 'out-dir', 'log-level', 'codes', 'chrome-profile', 'cookie-tank'],
    boolean: ['dry-run', 'headless', 'help'],
    alias: {
      h: 'help',
      u: 'urls',
      o: 'out-dir',
      d: 'dry-run',
      l: 'log-level',
      m: 'max-items',
      c: 'codes'
    },
    default: {
      urls: process.env.URLS_FILE || './urls.txt',
      'out-dir': process.env.OUT_DIR || 'out',
      'dry-run': false,
      headless: process.env.HEADLESS !== 'false',
      'log-level': process.env.LOG_LEVEL || 'info',
      'max-items': parseInt(process.env.MAX_ITEMS || '16'),
      codes: process.env.CODES || 'AP,REG,BLD,ZON,RS,TEN,RTR,NT,NOI,IMG',
      'chrome-profile': process.env.CHROME_PROFILE,
      'cookie-tank': process.env.COOKIE_TANK,
      concurrency: parseInt(process.env.CONCURRENCY || '2'),
      qps: parseInt(process.env.QPS || '2'),
      'timeout-ms': parseInt(process.env.TIMEOUT_MS || '120000')
    }
  });

  if (argv.help) {
    console.log(`
사용법: npm run dev [옵션]

옵션:
  -u, --urls <file>          URLs 파일 경로 (기본: ./urls.txt)
  -o, --out-dir <dir>        출력 디렉토리 (기본: out)
  -d, --dry-run              실제 다운로드 없이 분석만 수행
  --headless                 헤드리스 모드 (기본: true)
  -l, --log-level <level>    로그 레벨: debug|info|warn|error (기본: info)
  -m, --max-items <num>      최대 수집 항목 수 (기본: 16)
  -c, --codes <codes>        대상 코드 (기본: AP,REG,BLD,ZON,RS,TEN,RTR,NT,NOI,IMG)
  --chrome-profile <path>    Chrome 프로필 경로
  --cookie-tank <file>       쿠키 파일 경로
  --concurrency <num>        동시 실행 수 (기본: 2)
  --qps <num>                초당 요청 수 (기본: 2)
  --timeout-ms <ms>          타임아웃 (기본: 120000)
  -h, --help                 도움말 표시

환경변수:
  CHROME_PROFILE, COOKIE_TANK, OUT_DIR, CONCURRENCY, QPS, TIMEOUT_MS,
  MAX_ITEMS, CODES, LOG_LEVEL, HEADLESS

예시:
  npm run dev -- --urls ./test-urls.txt --dry-run --log-level debug
    `);
    process.exit(0);
  }

  return {
    urls: argv.urls,
    outDir: argv['out-dir'],
    dryRun: argv['dry-run'],
    headless: argv.headless,
    logLevel: argv['log-level'],
    maxItems: argv['max-items'],
    codes: typeof argv.codes === 'string' ? argv.codes.split(',').map(c => c.trim()) : argv.codes,
    chromeProfile: argv['chrome-profile'],
    cookieTank: argv['cookie-tank'],
    concurrency: argv.concurrency,
    qps: argv.qps,
    timeoutMs: argv['timeout-ms']
  };
}

async function loadUrls(urlsFile: string): Promise<string[]> {
  try {
    if (!await fs.pathExists(urlsFile)) {
      throw new Error(`URLs 파일이 존재하지 않습니다: ${urlsFile}`);
    }

    const content = await fs.readFile(urlsFile, 'utf8');
    const urls = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .filter(line => line.startsWith('http'));

    // 중복 제거 및 도메인/쿼리 정규화
    const uniqueUrls = [...new Set(urls.map(url => {
      try {
        const urlObj = new URL(url);
        // 쿼리 파라미터 정렬로 정규화
        urlObj.searchParams.sort();
        return urlObj.toString();
      } catch {
        return url; // 파싱 실패시 원본 유지
      }
    }))];

    console.log(`📄 ${uniqueUrls.length}개 URL 로드됨 (중복 ${urls.length - uniqueUrls.length}개 제거)`);
    
    if (uniqueUrls.length === 0) {
      throw new Error('처리할 유효한 URL이 없습니다.');
    }

    return uniqueUrls;

  } catch (error) {
    console.error('❌ URLs 로드 실패:', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function main() {
  try {
    console.log('🚀 Passing 배치 문서 수집기 시작');
    console.log('=====================================');

    const config = parseArgs();
    
    console.log('📋 설정:');
    console.log(`  URLs 파일: ${config.urls}`);
    console.log(`  출력 디렉토리: ${config.outDir}`);
    console.log(`  DRY RUN: ${config.dryRun}`);
    console.log(`  headless=${config.headless} qps=${config.qps} concurrency=${config.concurrency}`);
    console.log(`  대상 코드: ${config.codes.join(', ')}`);
    console.log('');

    const urls = await loadUrls(config.urls);

    const result = await runPipeline({
      urls,
      config,
      onProgress: (current: number, total: number, url: string) => {
        console.log(`⏳ [${current}/${total}] ${url}`);
      }
    });

    console.log(`[SUMMARY] ok=${result.success} fail=${result.failed} totalFiles=${result.totalFiles} missing=${result.missingCodes.join(',') || 'none'}`);
    
    if (result.failedUrls.length > 0) {
      const failedFile = path.join(config.outDir, 'urls.failed.txt');
      await fs.ensureDir(path.dirname(failedFile));
      await fs.writeFile(failedFile, result.failedUrls.join('\n') + '\n');
      console.log(`❌ 실패 URL: ${failedFile}`);
    }

    process.exit(result.failed > 0 ? 1 : 0);

  } catch (error) {
    console.error('💥 치명적 오류:', error instanceof Error ? error.message : String(error));
    if (process.env.LOG_LEVEL === 'debug') {
      console.error(error instanceof Error ? error.stack : error);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { Config };