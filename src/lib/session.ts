import { Browser, BrowserContext, chromium, LaunchOptions } from 'playwright';
import fs from 'fs-extra';
import path from 'path';
import { Logger } from './log';

export interface SessionConfig {
  chromeProfile?: string;
  cookieTank?: string;
  headless?: boolean;
  userAgent?: string;
}

export class SessionManager {
  private browser?: Browser;
  private context?: BrowserContext;
  private logger: Logger;
  private config: SessionConfig;

  constructor(config: SessionConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async initialize(): Promise<BrowserContext> {
    try {
      const launchOptions: LaunchOptions = {
        headless: this.config.headless ?? true,
      };

      if (this.config.chromeProfile) {
        this.logger.info('Chrome 프로필 사용', { profile: this.config.chromeProfile });
        launchOptions.channel = 'chrome';
        launchOptions.args = [`--user-data-dir=${this.config.chromeProfile}`];
      }

      this.browser = await chromium.launch(launchOptions);
      this.context = await this.browser.newContext({
        userAgent: this.config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'ko-KR',
        ignoreHTTPSErrors: true,
      });

      if (this.config.cookieTank && !this.config.chromeProfile) {
        await this.loadCookies();
      }

      this.logger.info('세션 초기화 완료');
      return this.context;
    } catch (error) {
      this.logger.error('세션 초기화 실패', { error: error.message });
      throw error;
    }
  }

  private async loadCookies(): Promise<void> {
    try {
      if (!this.config.cookieTank || !fs.existsSync(this.config.cookieTank)) {
        this.logger.warn('쿠키 파일 없음', { file: this.config.cookieTank });
        return;
      }

      const cookies = JSON.parse(await fs.readFile(this.config.cookieTank, 'utf8'));
      await this.context?.addCookies(cookies);
      this.logger.info('쿠키 로드 완료', { count: cookies.length });
    } catch (error) {
      this.logger.error('쿠키 로드 실패', { error: error.message });
    }
  }

  async saveCookies(): Promise<void> {
    if (!this.config.cookieTank || !this.context) return;

    try {
      const cookies = await this.context.cookies();
      await fs.writeFile(this.config.cookieTank, JSON.stringify(cookies, null, 2));
      this.logger.info('쿠키 저장 완료', { count: cookies.length });
    } catch (error) {
      this.logger.error('쿠키 저장 실패', { error: error.message });
    }
  }

  async isSessionValid(): Promise<boolean> {
    if (!this.context) return false;

    try {
      const page = await this.context.newPage();
      const response = await page.goto('https://www.tankauction.com/main.php');
      const isValid = response?.status() === 200;
      await page.close();
      
      this.logger.debug('세션 유효성 확인', { valid: isValid });
      return isValid;
    } catch (error) {
      this.logger.warn('세션 유효성 확인 실패', { error: error.message });
      return false;
    }
  }

  async refreshSession(): Promise<void> {
    this.logger.info('세션 재시작');
    await this.close();
    await this.initialize();
  }

  getContext(): BrowserContext | undefined {
    return this.context;
  }

  async close(): Promise<void> {
    if (this.config.cookieTank && this.context) {
      await this.saveCookies();
    }

    if (this.context) {
      await this.context.close();
      this.context = undefined;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = undefined;
    }

    this.logger.info('세션 종료');
  }
}