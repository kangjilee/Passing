import { BrowserContext } from 'playwright';
import fs from 'fs-extra';
import path from 'path';
import { Logger } from './log';
import { ResolvedUrl } from './resolver';

export interface DownloadResult {
  filename: string;
  filepath: string;
  size: number;
  contentType?: string;
  success: boolean;
  error?: string;
}

export class FileDownloader {
  private logger: Logger;
  private context: BrowserContext;
  private outputDir: string;
  private maxRetries: number;
  private retryDelay: number;

  constructor(
    context: BrowserContext, 
    outputDir: string, 
    logger: Logger,
    maxRetries: number = 3,
    retryDelay: number = 1000
  ) {
    this.context = context;
    this.outputDir = outputDir;
    this.logger = logger;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
  }

  async downloadFile(
    resolvedUrl: ResolvedUrl, 
    suggestedFilename: string,
    isDryRun: boolean = false
  ): Promise<DownloadResult> {
    
    if (!resolvedUrl.success || !resolvedUrl.finalUrl) {
      return {
        filename: suggestedFilename,
        filepath: '',
        size: 0,
        success: false,
        error: 'Invalid resolved URL'
      };
    }

    if (isDryRun) {
      this.logger.debug('DRY RUN - 다운로드 시뮬레이션', { 
        filename: suggestedFilename, 
        url: resolvedUrl.finalUrl 
      });
      return {
        filename: suggestedFilename,
        filepath: path.join(this.outputDir, suggestedFilename),
        size: 0,
        success: true
      };
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        this.logger.debug('다운로드 시도', { 
          attempt, 
          filename: suggestedFilename, 
          url: resolvedUrl.finalUrl 
        });

        const result = await this.performDownload(resolvedUrl, suggestedFilename);
        
        if (result.success) {
          this.logger.info('다운로드 성공', { 
            filename: result.filename, 
            size: result.size 
          });
          return result;
        } else {
          throw new Error(result.error || 'Download failed');
        }

      } catch (error) {
        lastError = error as Error;
        this.logger.warn('다운로드 시도 실패', { 
          attempt, 
          filename: suggestedFilename, 
          error: lastError.message 
        });

        if (attempt < this.maxRetries) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          this.logger.debug('재시도 대기', { delay });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return {
      filename: suggestedFilename,
      filepath: '',
      size: 0,
      success: false,
      error: lastError?.message || 'Max retries exceeded'
    };
  }

  private async performDownload(
    resolvedUrl: ResolvedUrl, 
    filename: string
  ): Promise<DownloadResult> {
    
    await fs.ensureDir(this.outputDir);
    const filepath = path.join(this.outputDir, filename);

    let response;
    
    if (resolvedUrl.method === 'POST' && resolvedUrl.requestBody) {
      response = await this.context.request.post(resolvedUrl.finalUrl, {
        data: resolvedUrl.requestBody,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
    } else {
      response = await this.context.request.get(resolvedUrl.finalUrl);
    }

    if (!response.ok()) {
      throw new Error(`HTTP ${response.status()}: ${response.statusText()}`);
    }

    const buffer = await response.body();
    const contentType = response.headers()['content-type'];

    if (this.isErrorResponse(buffer, contentType)) {
      throw new Error('Response appears to be an error page');
    }

    await fs.writeFile(filepath, buffer);
    const stats = await fs.stat(filepath);

    return {
      filename,
      filepath,
      size: stats.size,
      contentType,
      success: true
    };
  }

  private isErrorResponse(buffer: Buffer, contentType?: string): boolean {
    if (!contentType) return false;

    if (contentType.includes('text/html')) {
      const text = buffer.toString('utf8', 0, Math.min(1000, buffer.length));
      const errorPatterns = [
        /error/i, /not found/i, /access denied/i, /forbidden/i,
        /에러/i, /오류/i, /접근.*거부/i, /찾을.*없/i
      ];
      return errorPatterns.some(pattern => pattern.test(text));
    }

    if (buffer.length < 100) {
      return true;
    }

    return false;
  }

  getFileExtension(contentType?: string, url?: string): string {
    if (contentType) {
      const mimeToExt: Record<string, string> = {
        'application/pdf': '.pdf',
        'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.ms-excel': '.xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/vnd.hancom.hwp': '.hwp',
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'text/plain': '.txt',
        'application/zip': '.zip',
        'application/octet-stream': '.bin'
      };

      for (const [mime, ext] of Object.entries(mimeToExt)) {
        if (contentType.includes(mime)) {
          return ext;
        }
      }
    }

    if (url) {
      const match = url.match(/\.([a-zA-Z0-9]+)(?:\?|#|$)/);
      if (match) {
        return `.${match[1].toLowerCase()}`;
      }
    }

    return '.bin';
  }

  getDefaultExtensionForCode(code?: string): string {
    const codeToExt: Record<string, string> = {
      'AP': '.pdf',  // 감정평가서
      'RS': '.hwp',  // 재산명세
      'REG': '.pdf', // 등기부
      'BLD': '.pdf', // 건축물대장
      'ZON': '.pdf', // 토지이용
      'RTR': '.xls', // 실거래가
      'TEN': '.hwp', // 임차
      'NT': '.hwp'   // 특약
    };

    return codeToExt[code || ''] || '.pdf';
  }
}