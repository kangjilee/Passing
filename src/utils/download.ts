import { BrowserContext } from 'playwright';
import { RateLimiter } from './rate';
import { writeFile, ensureDir, calculateHash, findUniqueFilename, isValidFile } from './fs';
import path from 'path';

export interface DownloadOptions {
  url: string;
  outputPath: string;
  filename: string;
  referer?: string;
  timeout?: number;
  retries?: number;
}

export interface DownloadResult {
  success: boolean;
  path?: string;
  size: number;
  hash?: string;
  error?: string;
  contentType?: string;
}

export class Downloader {
  constructor(
    private context: BrowserContext,
    private rateLimiter: RateLimiter,
    private timeoutMs: number = 120000
  ) {}

  async download(options: DownloadOptions): Promise<DownloadResult> {
    const { url, outputPath, filename, referer, timeout = this.timeoutMs, retries = 1 } = options;
    
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.rateLimiter.add(async () => {
          return await this.performDownload(url, outputPath, filename, referer, timeout);
        });
      } catch (error) {
        lastError = error as Error;
        
        if (attempt < retries) {
          // 지수 백오프
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return {
      success: false,
      size: 0,
      error: lastError?.message || 'Unknown download error'
    };
  }

  private async performDownload(
    url: string, 
    outputPath: string, 
    filename: string, 
    referer?: string,
    timeout: number = 120000
  ): Promise<DownloadResult> {
    
    await ensureDir(outputPath);
    
    const headers: Record<string, string> = {};
    if (referer) {
      headers['Referer'] = referer;
    }

    const response = await this.context.request.get(url, {
      headers,
      timeout
    });

    if (!response.ok()) {
      throw new Error(`HTTP ${response.status()}: ${response.statusText()}`);
    }

    const buffer = await response.body();
    const contentType = response.headers()['content-type'];
    
    // 무결성 체크 - 너무 작은 파일이나 에러 페이지 감지
    if (buffer.length < 512) { // 512 bytes 미만은 의심
      const text = buffer.toString('utf8', 0, Math.min(200, buffer.length));
      if (text.includes('error') || text.includes('not found') || text.includes('403') || text.includes('404')) {
        throw new Error('Downloaded content appears to be an error page');
      }
    }

    const hash = calculateHash(buffer);
    const uniqueFilename = await findUniqueFilename(path.join(outputPath, filename), filename);
    const finalPath = path.join(outputPath, uniqueFilename);
    
    await writeFile(finalPath, buffer);
    
    // 파일 무결성 재검증
    if (!await isValidFile(finalPath, 512)) {
      throw new Error('Downloaded file failed integrity check');
    }

    return {
      success: true,
      path: finalPath,
      size: buffer.length,
      hash,
      contentType
    };
  }

  getFileExtension(contentType?: string, url?: string, code?: string): string {
    // Content-Type 우선
    if (contentType) {
      const mimeToExt: Record<string, string> = {
        'application/pdf': '.pdf',
        'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.ms-excel': '.xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/vnd.hancom.hwp': '.hwp',
        'text/csv': '.csv',
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'text/plain': '.txt',
        'application/zip': '.zip'
      };

      for (const [mime, ext] of Object.entries(mimeToExt)) {
        if (contentType.toLowerCase().includes(mime)) {
          return ext;
        }
      }
    }

    // URL 확장자 추출
    if (url) {
      const match = url.match(/\.([a-zA-Z0-9]{2,4})(?:\?|#|$)/);
      if (match) {
        return `.${match[1].toLowerCase()}`;
      }
    }

    // 코드별 기본값
    if (code) {
      const codeDefaults: Record<string, string> = {
        'AP': '.pdf',  // 감정평가서
        'RS': '.pdf',  // 재산명세서 (HWP -> PDF로 변경, 호환성)
        'REG': '.pdf', // 등기부등본
        'BLD': '.pdf', // 건축물대장
        'ZON': '.pdf', // 토지이용계획
        'RTR': '.csv', // 실거래가 (CSV 우선, 엑셀은 .xlsx)
        'TEN': '.pdf', // 임차 (HWP -> PDF로 변경)
        'NT': '.pdf'   // 특약 (HWP -> PDF로 변경)
      };
      
      if (codeDefaults[code]) {
        return codeDefaults[code];
      }
    }

    return '.pdf'; // 최종 기본값
  }
}