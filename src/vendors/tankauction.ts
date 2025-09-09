import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { slugify, createCasePrefix, createSafeFilename } from '../utils/slug';
import { ensureDir } from '../utils/fs';
import { openContext } from '../session';
import { clickResolveAndSaveV2 } from '../utils/downloader';
import fs from 'fs';
import path from 'path';

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
  kind?: 'file' | 'link'; // file = download, link = metadata only
}

export interface ResolvedTarget {
  finalUrl: string;
  filename?: string;
  success: boolean;
  error?: string;
}

export interface CollectionResult {
  anchors: LinkCandidate[];
  debugDir: string;
  softEmpty: boolean;
}

export async function debugDump(page: Page, dir: string, tag: string): Promise<void> {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${tag}.png`), fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    fs.writeFileSync(path.join(dir, `${tag}.html`), html, 'utf8');
  } catch (error) {
    console.warn(`Debug dump failed for ${tag}:`, error instanceof Error ? error.message : String(error));
  }
}

export class TankAuctionVendor {
  private context?: BrowserContext;
  private browser?: Browser;

  async initializeSession(chromeProfile?: string, cookieTank?: string, headless: boolean = true): Promise<BrowserContext> {
    try {
      this.context = await openContext();
      return this.context;
    } catch (error) {
      throw new Error(`세션 초기화 실패: ${error instanceof Error ? error.message : String(error)}`);
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

      return {
        prefix,
        title: title.trim(),
        sectionHandle: null, // No longer needed - handled by collectLinksV2
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
        error: error instanceof Error ? error.message : String(error)
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
      console.warn('링크 수집 실패:', error instanceof Error ? error.message : String(error));
    }

    return candidates.slice(0, maxItems);
  }

  async collectLinksV2(page: Page, prefix: string, outDir: string): Promise<CollectionResult> {
    const dbg = path.join(outDir, '_debug', prefix.replace(/[^\w.-]/g, '_'));
    
    try {
      await fs.promises.mkdir(dbg, { recursive: true });
    } catch (error) {
      console.warn('Failed to create debug directory:', error instanceof Error ? error.message : String(error));
    }

    // 0) 안정화 대기
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await page.waitForTimeout(800);

    // 1) 섹션 후보(동의어 포함)
    const sectionSelectors = [
      'xpath=//aside//*[contains(text(),"참고자료")]/ancestor::*[self::aside or self::div or self::section][1]',
      'xpath=//*[contains(@class,"side") and .//*[contains(text(),"참고자료")]]',
      'xpath=//section[.//*[contains(text(),"참고자료")]]',
      'xpath=//*[contains(text(),"참고자료")]/ancestor::*[self::aside or self::div or self::section][1]',
      // 지도/기타도 허용
      'xpath=//aside//*[contains(text(),"지도자료") or contains(text(),"기타")]/ancestor::*[self::aside or self::div or self::section][1]'
    ];

    let section = null;
    for (const sel of sectionSelectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count().catch(() => 0)) {
          section = loc;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!section) {
      // 탭/아코디언 펼침 시도 (자주 쓰는 토글 패턴)
      const toggles = page.locator('button, a').filter({ hasText: /(참고자료|첨부|다운로드|문서함|지도자료|기타)/ });
      try {
        if (await toggles.count().catch(() => 0)) {
          await toggles.first().click({ timeout: 3000 });
          await page.waitForTimeout(500);
          for (const sel of sectionSelectors) {
            const loc = page.locator(sel).first();
            if (await loc.count().catch(() => 0)) {
              section = loc;
              break;
            }
          }
        }
      } catch {
        // Toggle click failed, continue
      }
    }

    await debugDump(page, dbg, '01_detail');

    // 2) 섹션 내부 앵커 수집
    let anchors: LinkCandidate[] = [];
    if (section) {
      try {
        const links = await section.locator('a[href]').all();
        for (const link of links) {
          const href = await link.getAttribute('href').catch(() => null);
          const label = (await link.innerText().catch(() => '')).trim();
          if (!href) continue;
          anchors.push({ href, label, element: link });
        }
      } catch (error) {
        console.warn('Section link collection failed:', error instanceof Error ? error.message : String(error));
      }
    }

    // 3) 폴백: 전 페이지 스캔(필요 라벨만)
    if (anchors.length === 0) {
      try {
        const links = await page.locator('a[href]').all();
        const include = /(감정|평가|재산명세|등기|건축물대장|토지이용|실거래|임차|특약|현황)/;
        const exclude = /(관심|즐겨찾기|공유|인쇄|담당|문의|복사|스크랩)/;
        
        for (const link of links) {
          const href = await link.getAttribute('href').catch(() => null);
          const label = (await link.innerText().catch(() => '')).trim();
          if (!href) continue;
          if (include.test(label) && !exclude.test(label)) {
            anchors.push({ href, label, element: link });
          }
        }
      } catch (error) {
        console.warn('Fallback link collection failed:', error instanceof Error ? error.message : String(error));
      }
    }

    // Save debug info
    try {
      fs.writeFileSync(path.join(dbg, 'anchors.json'), JSON.stringify(
        anchors.map(a => ({ href: a.href, label: a.label })), 
        null, 
        2
      ));
    } catch (error) {
      console.warn('Failed to save anchors.json:', error instanceof Error ? error.message : String(error));
    }

    if (anchors.length === 0) {
      console.warn('[COLLECT] no anchors found → treat as missing, not hard-fail');
      return { anchors: [], debugDir: dbg, softEmpty: true };
    }
    
    console.log(`[COLLECT] Found ${anchors.length} anchors for ${prefix}`);
    return { anchors, debugDir: dbg, softEmpty: false };
  }

  filterAndMap(candidates: LinkCandidate[], allowedCodes: string[]): LinkCandidate[] {
    const RX = {
      include: /(감정|평가|재산명세|처분재산|등기|건축물대장|토지이용|실거래|임차|점유|현황|특약|유의|사진|앨범|이미지|공고|물건상세|안내)/i,
      exclude: /(관심|즐겨찾기|공유|인쇄|담당|문의|복사|스크랩|다운로드 안내)/i,
      mapOnly: /(지도|지적편집도|로드뷰|카카오|네이버)/i,
      portalOnly: /(네이버부동산|KB|국토|통계|부동산플래닛|씨리얼|지역|인구|세대)/i,
      codeMap: [
        { rx: /(감정|평가)/i, code: 'AP' },
        { rx: /(재산명세|처분재산)/i, code: 'RS' },
        { rx: /(등기)/i, code: 'REG' },
        { rx: /(건축물대장)/i, code: 'BLD' },
        { rx: /(토지이용)/i, code: 'ZON' },
        { rx: /(실거래|거래가|국토)/i, code: 'RTR' },
        { rx: /(임차|점유|현황표)/i, code: 'TEN' },
        { rx: /(특약|유의|공지|안내)/i, code: 'NT' },
        { rx: /(공고|물건상세)/i, code: 'NOI' },
        { rx: /(사진|앨범|이미지|포토)/i, code: 'IMG' },
      ]
    };

    return candidates
      .filter(candidate => {
        // 1) exclude 패턴 제외
        if (RX.exclude.test(candidate.label)) {
          return false;
        }
        // 2) include 패턴이나 지도/포털 패턴 중 하나는 매치
        return RX.include.test(candidate.label) || 
               RX.mapOnly.test(candidate.label) || 
               RX.portalOnly.test(candidate.label);
      })
      .map(candidate => {
        // 분류 로직
        if (RX.mapOnly.test(candidate.label)) {
          return { ...candidate, kind: 'link' as const, code: 'MAP' };
        }
        
        if (RX.portalOnly.test(candidate.label)) {
          return { ...candidate, kind: 'link' as const, code: 'PORTAL' };
        }
        
        // 파일 다운로드 대상 - codeMap으로 분류
        let code = 'OTH'; // 기본값
        for (const { rx, code: mappedCode } of RX.codeMap) {
          if (rx.test(candidate.label)) {
            code = mappedCode;
            break;
          }
        }
        
        return { ...candidate, kind: 'file' as const, code };
      })
      .filter(candidate => {
        // allowedCodes 체크 (MAP, PORTAL은 항상 허용)
        return candidate.code === 'MAP' || 
               candidate.code === 'PORTAL' || 
               allowedCodes.includes(candidate.code || '');
      });
  }

  async downloadFile(candidate: LinkCandidate, page: Page, saveBase: string): Promise<ResolvedTarget & { path?: string, size?: number, hash?: string, ext?: string }> {
    try {
      if (!this.context) {
        return {
          finalUrl: candidate.href,
          success: false,
          error: 'Browser context not available'
        };
      }

      // Create a unique selector for the element - use text content match
      const selectorText = await candidate.element.innerText().catch(() => candidate.label);
      const anchorSelector = `text="${selectorText}"`;

      // Use V3.3 enhanced downloader with original href parameter preservation
      const savedPath = await clickResolveAndSaveV2(this.context, page, anchorSelector, saveBase, candidate.code || 'UNK', candidate.href);
      
      if (savedPath && fs.existsSync(savedPath)) {
        const stats = fs.statSync(savedPath);
        const hash = require('crypto').createHash('md5').update(fs.readFileSync(savedPath)).digest('hex');
        
        return {
          finalUrl: candidate.href,
          filename: path.basename(savedPath),
          path: savedPath,
          size: stats.size,
          hash: hash,
          ext: path.extname(savedPath).slice(1),
          success: true
        };
      } else {
        return {
          finalUrl: candidate.href,
          success: false,
          error: 'No file downloaded - likely HTML/viewer only'
        };
      }

    } catch (error) {
      return {
        finalUrl: candidate.href,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = undefined;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = undefined;
    }
  }

  async captureNOI(page: Page, prefix: string, outDir: string): Promise<{ paths: string[], success: boolean }> {
    try {
      const paths: string[] = [];
      const baseDir = path.join(outDir, prefix);
      await fs.promises.mkdir(baseDir, { recursive: true });

      // 1) HTML capture
      const htmlPath = path.join(baseDir, `${prefix}__NOI_01_notice.html`);
      const html = await page.content();
      fs.writeFileSync(htmlPath, html, 'utf8');
      paths.push(htmlPath);

      // 2) PNG screenshot
      const pngPath = path.join(baseDir, `${prefix}__NOI_01_notice.png`);
      await page.screenshot({ 
        path: pngPath, 
        fullPage: true,
        timeout: 10000
      }).catch(() => {}); // Ignore screenshot failures
      if (fs.existsSync(pngPath)) {
        paths.push(pngPath);
      }

      // 3) PDF capture
      try {
        const pdfPath = path.join(baseDir, `${prefix}__NOI_01_notice.pdf`);
        await page.emulateMedia({ media: 'print' });
        await page.pdf({ 
          path: pdfPath, 
          printBackground: true, 
          margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' }
        }).catch(() => {}); // Ignore PDF failures
        if (fs.existsSync(pdfPath)) {
          paths.push(pdfPath);
        }
      } catch {
        // PDF generation not supported in all environments
      }

      return { paths, success: paths.length > 0 };
    } catch (error) {
      console.warn('NOI capture failed:', error instanceof Error ? error.message : String(error));
      return { paths: [], success: false };
    }
  }

  async downloadIMG(page: Page, candidate: LinkCandidate, prefix: string, outDir: string, maxItems: number = 10): Promise<{ paths: string[], success: boolean }> {
    try {
      const paths: string[] = [];
      const baseDir = path.join(outDir, prefix);
      await fs.promises.mkdir(baseDir, { recursive: true });

      // Try V2 event-based download first
      const saveBase = path.join(baseDir, `${prefix}__IMG_01_${candidate.label.replace(/[^\w]/g, '_')}`);
      const selectorText = await candidate.element.innerText().catch(() => candidate.label);
      const anchorSelector = `text="${selectorText}"`;
      const savedPath = await clickResolveAndSaveV2(this.context!, page, anchorSelector, saveBase, 'IMG', candidate.href);
      
      if (savedPath) {
        paths.push(savedPath);
      } else {
        // If event download failed, try page scanning for images
        try {
          // Navigate to image page
          await candidate.element.click();
          await page.waitForTimeout(2000);

          // Find image elements
          const images = await page.locator('img[src]').all();
          const limitedImages = images.slice(0, Math.min(maxItems, images.length));

          for (let i = 0; i < limitedImages.length; i++) {
            try {
              const img = limitedImages[i];
              const src = await img.getAttribute('src');
              if (!src || src.startsWith('data:') || src.includes('placeholder')) continue;

              const imgUrl = new URL(src, page.url()).href;
              
              // Try to fetch image
              const response = await page.goto(imgUrl);
              if (response && response.ok()) {
                const ct = response.headers()['content-type'] || '';
                if (/image\/(png|jpeg|jpg|gif|tiff|bmp|webp)/i.test(ct)) {
                  const buffer = await response.body();
                  const ext = path.extname(imgUrl).toLowerCase() || '.jpg';
                  const imgPath = path.join(baseDir, `${prefix}__IMG_${String(i + 1).padStart(2, '0')}_image${ext}`);
                  
                  fs.writeFileSync(imgPath, buffer);
                  paths.push(imgPath);
                }
              }
            } catch {
              continue; // Skip failed images
            }
          }
        } catch {
          // Page scanning failed
        }
      }

      return { paths, success: paths.length > 0 };
    } catch (error) {
      console.warn('IMG download failed:', error instanceof Error ? error.message : String(error));
      return { paths: [], success: false };
    }
  }

  async downloadRTR(page: Page, candidate: LinkCandidate, prefix: string, outDir: string): Promise<{ paths: string[], success: boolean }> {
    try {
      const paths: string[] = [];
      const baseDir = path.join(outDir, prefix);
      await fs.promises.mkdir(baseDir, { recursive: true });

      // Try V2 event-based download first (CSV/Excel files)
      const saveBase = path.join(baseDir, `${prefix}__RTR_01_transactions`);
      const selectorText = await candidate.element.innerText().catch(() => candidate.label);
      const anchorSelector = `text="${selectorText}"`;
      const savedPath = await clickResolveAndSaveV2(this.context!, page, anchorSelector, saveBase, 'RTR', candidate.href);
      
      if (savedPath) {
        paths.push(savedPath);
      } else {
        // If no file download, try table extraction as CSV
        try {
          await candidate.element.click();
          await page.waitForTimeout(2000);

          const html = await page.content();
          const { tableToCsv } = require('../parsers/notice');
          const csv = tableToCsv(html);
          
          if (csv && csv.trim()) {
            const csvPath = path.join(baseDir, `${prefix}__RTR_01_transactions.csv`);
            fs.writeFileSync(csvPath, csv, 'utf8');
            paths.push(csvPath);
          }
        } catch (error) {
          console.warn('Table extraction failed:', error instanceof Error ? error.message : String(error));
        }
      }

      return { paths, success: paths.length > 0 };
    } catch (error) {
      console.warn('RTR download failed:', error instanceof Error ? error.message : String(error));
      return { paths: [], success: false };
    }
  }

  getContext(): BrowserContext | undefined {
    return this.context;
  }
}