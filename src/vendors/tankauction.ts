import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { slugify, createCasePrefix, createSafeFilename } from '../utils/slug';
import { ensureDir } from '../utils/fs';

export interface VisitResult {
  prefix: string;
  title: string;
  sectionHandle: any; // Playwright ElementHandle
  caseNo?: string;
  round?: string;
  success: boolean;
  error?: string;
}

export interface LinkCandidate {
  code?: string;
  label: string;
  href: string;
  element: any; // Playwright ElementHandle
}

export interface ResolvedTarget {
  finalUrl: string;
  filename?: string;
  success: boolean;
  error?: string;
}

export class TankAuctionVendor {
  private context?: BrowserContext;
  private browser?: Browser;

  async initializeSession(chromeProfile?: string, cookieTank?: string, headless: boolean = true): Promise<BrowserContext> {
    try {
      // Chrome 프로필 우선
      if (chromeProfile) {
        this.browser = await chromium.launchPersistentContext(chromeProfile, {
          headless,
          viewport: { width: 1920, height: 1080 },
          locale: 'ko-KR'
        });
        this.context = this.browser;
      } else {
        // 일반 브라우저 + 쿠키 파일
        this.browser = await chromium.launch({ headless });
        this.context = await this.browser.newContext({
          viewport: { width: 1920, height: 1080 },
          locale: 'ko-KR'
        });

        // 쿠키 로드
        if (cookieTank) {
          try {
            const fs = require('fs-extra');
            if (await fs.pathExists(cookieTank)) {
              const cookies = JSON.parse(await fs.readFile(cookieTank, 'utf8'));
              await this.context.addCookies(cookies);
            }
          } catch (error) {
            console.warn('쿠키 로드 실패:', error.message);
          }
        }
      }

      return this.context;
    } catch (error) {
      throw new Error(`세션 초기화 실패: ${error.message}`);
    }
  }

  async verifyLogin(page: Page): Promise<boolean> {
    try {
      // 로그인 상태 확인 - 일반적인 패턴들
      const loginIndicators = [
        'text="로그아웃"',
        'text="마이페이지"',
        '[data-user]',
        '.user-profile',
        '#userInfo',
        'text*="님"' // "홍길동님" 형태
      ];

      for (const selector of loginIndicators) {
        try {
          const element = await page.locator(selector).first();
          if (await element.isVisible({ timeout: 2000 })) {
            return true;
          }
        } catch {
          continue;
        }
      }

      // 로그인 폼이 있으면 미로그인 상태
      const loginForms = ['input[type="password"]', 'button*="로그인"', 'input[name*="login"]'];
      for (const selector of loginForms) {
        try {
          if (await page.locator(selector).first().isVisible({ timeout: 1000 })) {
            return false;
          }
        } catch {
          continue;
        }
      }

      return true; // 명확하지 않으면 로그인된 것으로 가정
    } catch {
      return false;
    }
  }

  async open(url: string): Promise<VisitResult> {
    if (!this.context) {
      throw new Error('세션이 초기화되지 않았습니다.');
    }

    const page = await this.context.newPage();
    
    try {
      await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });

      // 로그인 상태 확인
      if (!await this.verifyLogin(page)) {
        throw new Error('로그인이 필요합니다.');
      }

      // 페이지 타이틀 및 사건 정보 추출
      const title = await page.title() || '';
      const bodyText = await page.textContent('body') || '';
      const fullText = `${title} ${bodyText}`;

      // 사건번호 추출 (여러 패턴 시도)
      const casePatterns = [
        /(\d{4}-\d{7}-\d{1,4})/,  // 2024-1234567-1 형태
        /(\d{4}타경\d+)/,         // 2024타경12345 형태  
        /사건번호[:\s]*([^\s\n]+)/,
        /물건번호[:\s]*([^\s\n]+)/
      ];

      let caseNo: string | undefined;
      for (const pattern of casePatterns) {
        const match = fullText.match(pattern);
        if (match) {
          caseNo = match[1].trim();
          break;
        }
      }

      // 차수 추출
      const roundMatch = fullText.match(/(\d+)\s*차/);
      const round = roundMatch ? roundMatch[1] + '차' : '1차';

      const prefix = createCasePrefix(caseNo, round);

      // 사이드 영역 찾기 (참고자료/지도자료/기타참고자료)
      const sectionSelectors = [
        'text*="참고자료"',
        'text*="자료"', 
        'text*="첨부"',
        'text*="다운로드"',
        'text*="문서함"',
        'text*="지도자료"',
        'text*="지도"',
        'text*="위치"',
        'text*="기타참고자료"',
        'text*="기타"',
        'text*="보조"'
      ];

      let sectionHandle = null;
      for (const selector of sectionSelectors) {
        try {
          const element = page.locator(selector).first();
          if (await element.isVisible({ timeout: 2000 })) {
            // 부모 컨테이너 찾기
            const parent = element.locator('xpath=ancestor-or-self::*[contains(@class, "section") or contains(@class, "panel") or contains(@class, "box") or self::table or self::div][1]');
            if (await parent.count() > 0) {
              sectionHandle = parent.first();
              break;
            } else {
              sectionHandle = element;
              break;
            }
          }
        } catch {
          continue;
        }
      }

      if (!sectionHandle) {
        throw new Error('참고자료 섹션을 찾을 수 없습니다.');
      }

      // 섹션이 접혀있으면 펼치기
      try {
        const toggleButtons = sectionHandle.locator('button, a, [onclick], [class*="toggle"], [class*="expand"]');
        const count = await toggleButtons.count();
        for (let i = 0; i < count; i++) {
          const btn = toggleButtons.nth(i);
          const text = await btn.textContent() || '';
          if (text.includes('▼') || text.includes('▲') || text.includes('펼치') || text.includes('더보기')) {
            await btn.click({ timeout: 2000 });
            await page.waitForTimeout(1000);
            break;
          }
        }
      } catch {
        // 토글 실패는 무시
      }

      return {
        prefix,
        title: title.trim(),
        sectionHandle,
        caseNo,
        round,
        success: true
      };

    } catch (error) {
      return {
        prefix: createCasePrefix(),
        title: '',
        sectionHandle: null,
        success: false,
        error: error.message
      };
    } finally {
      await page.close();
    }
  }

  async collectLinks(sectionHandle: any, maxItems: number = 16): Promise<LinkCandidate[]> {
    if (!sectionHandle) {
      return [];
    }

    const candidates: LinkCandidate[] = [];
    
    try {
      // href가 있는 링크들 수집
      const links = sectionHandle.locator('a[href]');
      const linkCount = Math.min(await links.count(), maxItems);
      
      for (let i = 0; i < linkCount; i++) {
        const link = links.nth(i);
        const href = await link.getAttribute('href') || '';
        const text = (await link.textContent() || '').trim();
        
        if (!href || href === '#' || !text) continue;
        
        candidates.push({
          label: text,
          href,
          element: link
        });
      }

      // 버튼/폼 요소들도 수집
      const buttons = sectionHandle.locator('button, input[type="button"], input[type="submit"]');
      const buttonCount = Math.min(await buttons.count(), maxItems - candidates.length);
      
      for (let i = 0; i < buttonCount; i++) {
        const button = buttons.nth(i);
        const text = (await button.getAttribute('value') || await button.textContent() || '').trim();
        
        if (!text) continue;
        
        candidates.push({
          label: text,
          href: 'javascript:void(0)',
          element: button
        });
      }

    } catch (error) {
      console.warn('링크 수집 실패:', error.message);
    }

    return candidates.slice(0, maxItems);
  }

  filterAndMap(candidates: LinkCandidate[], allowedCodes: string[]): LinkCandidate[] {
    const codePatterns: Record<string, RegExp> = {
      'AP': /감정|평가/i,
      'RS': /재산명세/i,
      'REG': /등기|건물등기|토지등기/i,
      'BLD': /건축물대장|층별|표제부/i,
      'ZON': /토지이용/i,
      'RTR': /실거래|국토부실거래/i,
      'TEN': /임차|점유|배당/i,
      'NT': /특약|유의/i
    };

    return candidates
      .map(candidate => {
        // 코드 분류
        for (const code of allowedCodes) {
          const pattern = codePatterns[code];
          if (pattern && pattern.test(candidate.label)) {
            return { ...candidate, code };
          }
        }
        return candidate; // 코드 없이도 유지
      })
      .filter(candidate => {
        // 불필요한 라벨 제외
        const negativePatterns = [
          /관심|즐겨찾|분류|추가|수정|삭제/i,
          /마이페이지|알림|공유|인쇄|문의|담당자/i,
          /로그인|회원가입|비밀번호/i
        ];
        
        return !negativePatterns.some(pattern => pattern.test(candidate.label));
      });
  }

  async resolveTargets(candidate: LinkCandidate, page: Page): Promise<ResolvedTarget> {
    try {
      // 절대 URL이면 바로 반환
      if (candidate.href.startsWith('http') && !candidate.href.includes('javascript:')) {
        return {
          finalUrl: candidate.href,
          success: true
        };
      }

      // 팝업/다운로드/새탭 이벤트 감지
      let finalUrl = '';
      let filename = '';

      const [popup, download, newPage] = await Promise.allSettled([
        page.waitForEvent('popup', { timeout: 3000 }),
        page.waitForEvent('download', { timeout: 3000 }),
        this.context!.waitForEvent('page', { timeout: 3000 })
      ]);

      // 클릭 실행
      await candidate.element.click({ timeout: 2000 });
      await page.waitForTimeout(1000);

      // 다운로드 이벤트 우선
      if (download.status === 'fulfilled') {
        finalUrl = download.value.url();
        filename = download.value.suggestedFilename();
      }
      // 팝업 이벤트
      else if (popup.status === 'fulfilled') {
        finalUrl = popup.value.url();
        await popup.value.close();
      }
      // 새 탭 이벤트  
      else if (newPage.status === 'fulfilled') {
        finalUrl = newPage.value.url();
        await newPage.value.close();
      }
      // URL 변경 감지
      else {
        const currentUrl = page.url();
        if (currentUrl !== candidate.href) {
          finalUrl = currentUrl;
        }
      }

      if (!finalUrl) {
        throw new Error('URL을 해석할 수 없습니다.');
      }

      return {
        finalUrl,
        filename,
        success: true
      };

    } catch (error) {
      return {
        finalUrl: '',
        success: false,
        error: error.message
      };
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = undefined;
      this.context = undefined;
    }
  }

  getContext(): BrowserContext | undefined {
    return this.context;
  }
}