import { Page, BrowserContext, Response, Request } from 'playwright';
import { Logger } from './log';
import { DocumentCandidate } from './pageScan';

export interface ResolvedUrl {
  originalHref: string;
  finalUrl: string;
  method: string;
  requestBody?: string;
  contentType?: string;
  filename?: string;
  success: boolean;
  error?: string;
}

export class UrlResolver {
  private logger: Logger;
  private hookMs: number;
  private capturedRequests: Map<string, { method: string; body?: string }> = new Map();

  constructor(logger: Logger, hookMs: number = 600) {
    this.logger = logger;
    this.hookMs = hookMs;
  }

  async resolveCandidate(
    page: Page, 
    context: BrowserContext, 
    candidate: DocumentCandidate
  ): Promise<ResolvedUrl> {
    this.logger.debug('URL 해석 시작', { text: candidate.text, href: candidate.href });

    try {
      if (candidate.isFormBased) {
        return await this.resolveFormBased(page, candidate);
      } else {
        return await this.resolveLinkBased(page, context, candidate);
      }
    } catch (error) {
      this.logger.error('URL 해석 실패', { 
        text: candidate.text, 
        error: error.message 
      });
      
      return {
        originalHref: candidate.href,
        finalUrl: '',
        method: 'GET',
        success: false,
        error: error.message
      };
    }
  }

  private async resolveLinkBased(
    page: Page, 
    context: BrowserContext, 
    candidate: DocumentCandidate
  ): Promise<ResolvedUrl> {
    
    if (candidate.href.startsWith('http') && !candidate.href.includes('javascript:')) {
      return {
        originalHref: candidate.href,
        finalUrl: candidate.href,
        method: 'GET',
        success: true
      };
    }

    const result: ResolvedUrl = {
      originalHref: candidate.href,
      finalUrl: '',
      method: 'GET',
      success: false
    };

    let newPagePromise: Promise<Page> | null = null;
    let downloadPromise: Promise<any> | null = null;
    let popupPromise: Promise<Page> | null = null;

    const setupListeners = () => {
      newPagePromise = context.waitForEvent('page', { timeout: this.hookMs * 2 });
      downloadPromise = page.waitForEvent('download', { timeout: this.hookMs * 2 });
      
      page.on('popup', async (popup) => {
        popupPromise = Promise.resolve(popup);
      });

      page.on('requestfinished', (request) => {
        if (request.method() !== 'GET') {
          this.capturedRequests.set(request.url(), {
            method: request.method(),
            body: request.postData() || undefined
          });
        }
      });
    };

    const cleanupListeners = () => {
      page.removeAllListeners('popup');
      page.removeAllListeners('requestfinished');
    };

    try {
      setupListeners();

      const element = page.locator(candidate.selector).first();
      await element.click({ timeout: this.hookMs });

      await page.waitForTimeout(this.hookMs);

      const [newPage, download, popup] = await Promise.allSettled([
        newPagePromise?.catch(() => null) || Promise.resolve(null),
        downloadPromise?.catch(() => null) || Promise.resolve(null),
        popupPromise?.catch(() => null) || Promise.resolve(null)
      ]);

      if (download.status === 'fulfilled' && download.value) {
        result.finalUrl = download.value.url();
        result.filename = download.value.suggestedFilename();
        result.success = true;
        this.logger.debug('다운로드 감지', { url: result.finalUrl });
      }
      else if (newPage.status === 'fulfilled' && newPage.value) {
        result.finalUrl = newPage.value.url();
        result.success = true;
        await newPage.value.close();
        this.logger.debug('새 탭 감지', { url: result.finalUrl });
      }
      else if (popup.status === 'fulfilled' && popup.value) {
        result.finalUrl = popup.value.url();
        result.success = true;
        await popup.value.close();
        this.logger.debug('팝업 감지', { url: result.finalUrl });
      }
      else {
        const currentUrl = page.url();
        if (currentUrl !== candidate.href) {
          result.finalUrl = currentUrl;
          result.success = true;
          this.logger.debug('URL 변경 감지', { url: result.finalUrl });
        } else {
          result.error = 'No URL change detected';
        }
      }

      if (result.success && this.capturedRequests.has(result.finalUrl)) {
        const captured = this.capturedRequests.get(result.finalUrl);
        result.method = captured?.method || 'GET';
        result.requestBody = captured?.body;
      }

    } catch (error) {
      result.error = error.message;
      this.logger.debug('링크 해석 중 에러', { error: error.message });
    } finally {
      cleanupListeners();
    }

    return result;
  }

  private async resolveFormBased(page: Page, candidate: DocumentCandidate): Promise<ResolvedUrl> {
    const result: ResolvedUrl = {
      originalHref: candidate.href,
      finalUrl: '',
      method: 'POST',
      success: false
    };

    try {
      let responsePromise = page.waitForResponse(response => 
        response.request().method() !== 'GET' && 
        response.status() >= 200 && response.status() < 400,
        { timeout: this.hookMs * 2 }
      );

      const element = page.locator(candidate.selector).first();
      await element.click({ timeout: this.hookMs });

      await page.waitForTimeout(this.hookMs);

      try {
        const response = await responsePromise;
        result.finalUrl = response.url();
        result.method = response.request().method();
        result.requestBody = response.request().postData();
        result.contentType = response.headers()['content-type'];
        result.success = true;
        
        this.logger.debug('폼 응답 감지', { 
          url: result.finalUrl, 
          method: result.method 
        });
      } catch (timeoutError) {
        const currentUrl = page.url();
        if (currentUrl && currentUrl !== 'about:blank') {
          result.finalUrl = currentUrl;
          result.success = true;
        } else {
          result.error = 'Form submission timeout';
        }
      }

    } catch (error) {
      result.error = error.message;
      this.logger.debug('폼 해석 실패', { error: error.message });
    }

    return result;
  }

  async extractContentType(finalUrl: string, context: BrowserContext): Promise<string | undefined> {
    try {
      const response = await context.request.head(finalUrl);
      return response.headers()['content-type'];
    } catch (error) {
      this.logger.debug('Content-Type 추출 실패', { url: finalUrl, error: error.message });
      return undefined;
    }
  }

  clearCapturedRequests(): void {
    this.capturedRequests.clear();
  }
}