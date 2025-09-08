import { Page } from 'playwright';
import { Logger } from './log';

export interface DocumentCandidate {
  text: string;
  href: string;
  code?: string;
  selector: string;
  isFormBased?: boolean;
}

export interface ScanResult {
  caseInfo: {
    caseNumber?: string;
    sequence?: string;
    prefix: string;
  };
  candidates: DocumentCandidate[];
}

export class PageScanner {
  private logger: Logger;
  private readonly SIDE_OK_PATTERNS = [
    /참고자료/i, /지도자료/i, /기타참고자료/i, /첨부/i, /자료/i, /문서/i,
    /감정평가서/i, /재산명세/i, /등기부/i, /건축물/i, /토지이용/i,
    /실거래가/i, /임차/i, /특약/i
  ];

  private readonly NEG_LABEL_PATTERNS = [
    /관심/i, /즐겨찾/i, /분류/i, /추가/i, /수정/i, /삭제/i,
    /마이페이지/i, /알림/i, /공유/i, /인쇄/i, /문의/i, /담당자/i
  ];

  private readonly CODE_PATTERNS = {
    AP: /감정|평가/i,
    RS: /재산명세/i,
    REG: /등기|건물등기|토지등기/i,
    BLD: /건축물대장|층별|표제부/i,
    ZON: /토지이용/i,
    RTR: /실거래|국토부실거래/i,
    TEN: /임차|점유|배당/i,
    NT: /특약|유의/i
  };

  private readonly MAX_CANDIDATES = 16;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async scanPage(page: Page): Promise<ScanResult> {
    try {
      this.logger.info('페이지 스캔 시작');

      const caseInfo = await this.extractCaseInfo(page);
      this.logger.debug('사건정보 추출', caseInfo);

      const candidates = await this.findCandidates(page);
      this.logger.info('후보 추출 완료', { count: candidates.length });

      return {
        caseInfo,
        candidates: candidates.slice(0, this.MAX_CANDIDATES)
      };
    } catch (error) {
      this.logger.error('페이지 스캔 실패', { error: error.message });
      throw error;
    }
  }

  private async extractCaseInfo(page: Page): Promise<ScanResult['caseInfo']> {
    try {
      const title = await page.title();
      const bodyText = await page.textContent('body') || '';
      
      const fullText = `${title} ${bodyText}`;
      
      const caseMatch = fullText.match(/(\d{4}타경\d+|\d+호)/i);
      const seqMatch = fullText.match(/(\d+차)/i);
      
      const caseNumber = caseMatch ? caseMatch[1] : 'UNKNOWN';
      const sequence = seqMatch ? seqMatch[1] : '1차';
      
      const prefix = `${caseNumber}_${sequence}`.replace(/[^\w\-_]/g, '_');

      return {
        caseNumber,
        sequence,
        prefix
      };
    } catch (error) {
      this.logger.warn('사건정보 추출 실패', { error: error.message });
      return {
        prefix: `CASE_${Date.now()}`
      };
    }
  }

  private async findCandidates(page: Page): Promise<DocumentCandidate[]> {
    const candidates: DocumentCandidate[] = [];

    try {
      const links = await page.locator('a[href]').all();
      
      for (let i = 0; i < links.length && candidates.length < this.MAX_CANDIDATES; i++) {
        const link = links[i];
        
        try {
          const text = (await link.textContent() || '').trim();
          const href = await link.getAttribute('href') || '';
          
          if (!text || !href || href === '#') continue;

          if (!this.isSideAreaCandidate(text)) continue;
          if (this.isNegativeLabel(text)) continue;

          const selector = await this.generateSelector(link);
          const isFormBased = await this.isFormBasedLink(link);
          const code = this.classifyCode(text);

          candidates.push({
            text,
            href,
            code,
            selector,
            isFormBased
          });

          this.logger.debug('후보 발견', { text, code, href: href.substring(0, 100) });
        } catch (error) {
          this.logger.debug('링크 처리 실패', { error: error.message });
        }
      }

      const formInputs = await page.locator('input[type="button"], input[type="submit"], button').all();
      
      for (let i = 0; i < formInputs.length && candidates.length < this.MAX_CANDIDATES; i++) {
        const input = formInputs[i];
        
        try {
          const text = (await input.getAttribute('value') || await input.textContent() || '').trim();
          
          if (!text) continue;
          if (!this.isSideAreaCandidate(text)) continue;
          if (this.isNegativeLabel(text)) continue;

          const selector = await this.generateSelector(input);
          const code = this.classifyCode(text);

          candidates.push({
            text,
            href: 'javascript:void(0)',
            code,
            selector,
            isFormBased: true
          });

          this.logger.debug('폼 후보 발견', { text, code });
        } catch (error) {
          this.logger.debug('폼 입력 처리 실패', { error: error.message });
        }
      }

    } catch (error) {
      this.logger.error('후보 탐색 실패', { error: error.message });
    }

    return candidates;
  }

  private isSideAreaCandidate(text: string): boolean {
    return this.SIDE_OK_PATTERNS.some(pattern => pattern.test(text));
  }

  private isNegativeLabel(text: string): boolean {
    return this.NEG_LABEL_PATTERNS.some(pattern => pattern.test(text));
  }

  private classifyCode(text: string): string | undefined {
    for (const [code, pattern] of Object.entries(this.CODE_PATTERNS)) {
      if (pattern.test(text)) {
        return code;
      }
    }
    return undefined;
  }

  private async generateSelector(element: any): Promise<string> {
    try {
      const tagName = await element.evaluate((el: Element) => el.tagName.toLowerCase());
      const id = await element.getAttribute('id');
      const className = await element.getAttribute('class');
      
      if (id) {
        return `#${id}`;
      }
      
      if (className) {
        const classes = className.split(' ').filter(c => c.trim()).slice(0, 2);
        if (classes.length > 0) {
          return `${tagName}.${classes.join('.')}`;
        }
      }
      
      return tagName;
    } catch (error) {
      return 'a';
    }
  }

  private async isFormBasedLink(link: any): Promise<boolean> {
    try {
      const href = await link.getAttribute('href') || '';
      const onclick = await link.getAttribute('onclick') || '';
      
      return href.startsWith('javascript:') || onclick.includes('submit') || onclick.includes('form');
    } catch {
      return false;
    }
  }
}