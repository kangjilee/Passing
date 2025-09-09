import fs from 'fs';
import path from 'path';
import { type BrowserContext, type Page, type Response, type Download } from 'playwright';
import { clickDownloadButtonsInPage } from './clickDownloadButtonsInPage';
import { extractPdfFromHtml } from './htmlPdfExtractor';

const FILE_CT = /^(application\/pdf|application\/octet-stream|text\/csv|application\/vnd\.ms-excel|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/zip|image\/(png|jpe?g|tiff|gif))/i;

function extFromCT(ct?: string, fallback = 'pdf'): string {
  if (!ct) return fallback;
  if (/pdf/i.test(ct)) return 'pdf';
  if (/csv/i.test(ct)) return 'csv';
  if (/zip/i.test(ct)) return 'zip';
  if (/spreadsheetml/i.test(ct)) return 'xlsx';
  if (/ms-excel/i.test(ct)) return 'xls';
  if (/png/i.test(ct)) return 'png';
  if (/jpe?g/i.test(ct)) return 'jpg';
  if (/tiff/i.test(ct)) return 'tif';
  if (/gif/i.test(ct)) return 'gif';
  return fallback;
}

function safeName(s: string): string { 
  return s.replace(/[/\\?%*:|"<>]/g, '_'); 
}

function nameFromCD(cd?: string, def = 'file'): string { 
  if (!cd) return def;
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
  return safeName(decodeURIComponent(m?.[1] || def));
}

function defaultExtFromCode(code: string): string {
  if (/RTR/i.test(code)) return 'csv';
  if (/(IMG|TEN|NT|AP|REG|BLD|ZON|RS|NOI)/i.test(code)) return 'pdf';
  return 'pdf';
}

// 원본 href(예: .../pa/paFile.php?cltrNo=1778958&tp=J&chkNo=1&bfree=)의
// 모든 파라미터를 유지하고 tp만 D로 바꿔서 요청
export function toDirectDownloadFromHref(href: string, baseUrl: string): string | null {
  try {
    // JavaScript href 처리
    if (href.startsWith('javascript:fileView(')) {
      // javascript:fileView("paFile.php?cltrNo=1778958&tp=D") → https://baseUrl/pa/paFile.php?cltrNo=1778958&tp=D
      const match = /fileView\(['"](.*?)['"]/.exec(href);
      if (match) {
        let filePath = match[1];
        // 상대 경로면 /pa/ 추가
        if (!filePath.startsWith('/pa/')) {
          filePath = '/pa/' + filePath;
        }
        const u = new URL(filePath, baseUrl);
        // tp가 있으면 D로 교체, 없으면 추가  
        if (u.searchParams.has('tp')) u.searchParams.set('tp', 'D');
        else u.searchParams.append('tp', 'D');
        console.log('[HREF-TRANSFORM]', href, '→', u.toString());
        return u.toString();
      }
    }
    
    // 일반 URL 처리
    const u = new URL(href, baseUrl); // ★ 절대경로화 + 모든 쿼리 유지
    // paView.php로 오는 경우도 paFile.php로 강제
    if (u.pathname.endsWith('/pa/paView.php')) u.pathname = '/pa/paFile.php';
    // tp가 있으면 D로 교체, 없으면 추가
    if (u.searchParams.has('tp')) u.searchParams.set('tp', 'D');
    else u.searchParams.append('tp', 'D');
    return u.toString();
  } catch { 
    return null; 
  }
}

export async function fetchDirectFromHref(
  context: BrowserContext, 
  href: string, 
  referer: string, 
  saveBase: string, 
  defExt = 'pdf'
): Promise<string | null> {
  const direct = toDirectDownloadFromHref(href, referer);
  if (!direct) return null;
  
  console.log('[TRY] direct fetch href:', direct);
  
  try {
    const r = await context.request.get(direct, { 
      headers: { Referer: referer },
      timeout: 30000
    });
    
    const ct = r.headers()['content-type'] || '';
    if (!/application\/pdf|text\/csv|zip|excel|spreadsheetml|image\/(png|jpe?g)/i.test(ct)) {
      return null;
    }

    const cd = r.headers()['content-disposition'] || '';
    const ext = (/\.(pdf|csv|xlsx|xls|zip|png|jpe?g)(?=$)/i.exec(cd || '')?.[0]) || ( 
      /pdf/i.test(ct) ? '.pdf' :
      /csv/i.test(ct) ? '.csv' : 
      /spreadsheetml/i.test(ct) ? '.xlsx' :
      /ms-excel/i.test(ct) ? '.xls' : 
      '.pdf'
    );
    
    const out = `${saveBase}${ext}`;
    const buf = await r.body();
    fs.writeFileSync(out, buf);
    console.log('[SAVE:direct-href]', out);
    return out;
  } catch (error) {
    console.log('[TRY] direct fetch href failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

// Legacy function for backward compatibility
function toDirectDownloadUrl(viewUrl: string): string | null {
  try {
    const u = new URL(viewUrl);
    if (u.pathname.includes('/pa/paFile.php')) {
      const tp = u.searchParams.get('tp');
      if (tp !== 'D') {
        u.searchParams.set('tp', 'D'); // ★ viewer→download
      }
      return u.toString();
    }
  } catch {}
  return null;
}

export async function fetchDirectFromViewer(
  context: BrowserContext, 
  viewUrl: string, 
  saveBase: string, 
  defExt = 'pdf'
): Promise<string | null> {
  const direct = toDirectDownloadUrl(viewUrl);
  if (!direct) return null;
  
  console.log('[TRY] direct fetch url:', direct);
  
  try {
    const r = await context.request.get(direct, { 
      headers: { Referer: viewUrl },
      timeout: 30000
    });
    
    const ct = r.headers()['content-type'] || '';
    if (!/application\/pdf|text\/csv|zip|excel|spreadsheetml|image\/(png|jpe?g)/i.test(ct)) {
      return null;
    }

    const cd = r.headers()['content-disposition'] || '';
    const ext = path.extname(cd) || ( 
      /pdf/i.test(ct) ? '.pdf' :
      /csv/i.test(ct) ? '.csv' :
      /spreadsheetml/i.test(ct) ? '.xlsx' :
      /ms-excel/i.test(ct) ? '.xls' : 
      '.' + defExt 
    );
    
    const out = `${saveBase}${ext}`;
    const buf = await r.body();
    fs.writeFileSync(out, buf);
    console.log('[SAVE:direct]', out);
    return out;
  } catch (error) {
    console.log('[TRY] direct fetch failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function sniffFileResponse(resps: Response[]): Promise<Response | null> {
  for (const r of resps.reverse()) {
    const ct = r.headers()['content-type'] || '';
    if (FILE_CT.test(ct) && r.status() === 200) return r;
  }
  return null;
}

async function findPdfSrcInDom(p: Page): Promise<string | null> {
  // iframe/embed/object/src 링크 안에서 pdf/csv/xlsx 소스 추출
  const selectors = [
    'embed[src]', 'iframe[src]', 'object[data]',
    'a[href*=".pdf"]', 'a[href*=".csv"]', 'a[href*=".xlsx"]', 'a[href*=".xls"]'
  ];
  
  for (const selector of selectors) {
    try {
      const element = p.locator(selector).first();
      if (await element.count().catch(() => 0)) {
        const attr = selector.includes('object') ? 'data' : (selector.includes('a[') ? 'href' : 'src');
        const url = await element.getAttribute(attr).catch(() => null);
        if (url) return url;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** V3.3 가장 강력한 저장기: 클릭→download or popup→응답/뷰어src→원본href직링크→OS폴백 */
export async function clickResolveAndSaveV2(
  context: BrowserContext, 
  page: Page, 
  anchorSelector: string, 
  saveBase: string, 
  code: string = 'UNK',
  originalHref?: string
): Promise<string | null> {
  const defaultExt = defaultExtFromCode(code);
  
  try {
    // Ensure output directory exists
    await fs.promises.mkdir(path.dirname(saveBase), { recursive: true });

    // Context 전역 감시 (다운로드/팝업/응답)
    const respBucket: Response[] = [];
    const onResp = (r: Response) => respBucket.push(r);
    context.on('response', onResp);

    // V3.3: 클릭과 다운로드 이벤트를 동시에 대기 (더 긴 타임아웃으로 확실히 잡기)
    let dl: any = null;
    let pop: any = null;
    
    console.log('[CLICK] Starting click with concurrent download/popup monitoring');
    console.log('[CLICK] Selector:', anchorSelector);
    console.log('[CLICK] Original href:', originalHref);
    
    try {
      if (anchorSelector.startsWith('//') || anchorSelector.startsWith('xpath=')) {
        // XPath selector - 동시 대기 패턴
        const [downloadEvent, popupEvent] = await Promise.allSettled([
          context.waitForEvent('download', { timeout: 30000 }), // 30초로 증가
          context.waitForEvent('page', { timeout: 12000 }),
          page.locator(anchorSelector).click({ button: 'left', timeout: 5000 })
        ]);
        
        if (downloadEvent.status === 'fulfilled') {
          dl = downloadEvent.value;
          console.log('[CLICK] Download event captured immediately!');
        }
        if (popupEvent.status === 'fulfilled') {
          pop = popupEvent.value;
          console.log('[CLICK] Popup opened:', pop.url());
          
          // 팝업 URL이 paFile.php이면 HTML에서 PDF 추출 시도
          const popupUrl = pop.url();
          if (popupUrl.includes('/pa/paFile.php')) {
            const extractedPdf = await extractPdfFromHtml(context, popupUrl, page.url(), saveBase);
            if (extractedPdf) {
              await pop.close().catch(() => {});
              context.off('response', onResp);
              return extractedPdf;
            }
          }
        }
      } else {
        // CSS selector - 동시 대기 패턴
        const [downloadEvent, popupEvent] = await Promise.allSettled([
          context.waitForEvent('download', { timeout: 30000 }), // 30초로 증가
          context.waitForEvent('page', { timeout: 12000 }),
          page.click(anchorSelector, { button: 'left', timeout: 5000 })
        ]);
        
        if (downloadEvent.status === 'fulfilled') {
          dl = downloadEvent.value;
          console.log('[CLICK] Download event captured immediately!');
        }
        if (popupEvent.status === 'fulfilled') {
          pop = popupEvent.value;
          console.log('[CLICK] Popup opened:', pop.url());
          
          // 팝업 URL이 paFile.php이면 HTML에서 PDF 추출 시도
          const popupUrl = pop.url();
          if (popupUrl.includes('/pa/paFile.php')) {
            const extractedPdf = await extractPdfFromHtml(context, popupUrl, page.url(), saveBase);
            if (extractedPdf) {
              await pop.close().catch(() => {});
              context.off('response', onResp);
              return extractedPdf;
            }
          }
        }
      }
    } catch (clickError) {
      context.off('response', onResp);
      console.warn(`Click failed for ${anchorSelector}:`, clickError instanceof Error ? clickError.message : String(clickError));
      return null;
    }

    // Wait for potential responses
    await page.waitForTimeout(1500);

    // 1) 다운로드 이벤트 최우선
    if (dl) {
      try {
        const suggested = dl.suggestedFilename() || 'download';
        const ext = path.extname(suggested) || '.' + defaultExt;
        const out = `${saveBase}${ext}`;
        await dl.saveAs(out);
        await dl.finished(); // 파일 완전히 기록될 때까지 대기
        context.off('response', onResp);
        console.log('[SAVE:download]', out);
        return out;
      } catch (dlError) {
        console.warn('Download save failed:', dlError instanceof Error ? dlError.message : String(dlError));
      }
    }

    // 2) 팝업이 열렸다면 그 안에서 파일 응답 또는 뷰어 src 탐색
    if (pop) {
      try {
        await pop.waitForLoadState('domcontentloaded', { timeout: 10000 });
        
        // (a) 응답 스니핑
        const popResps: Response[] = [];
        const onPR = (r: Response) => popResps.push(r);
        pop.on('response', onPR);
        await pop.waitForTimeout(1500);
        
        const fileResp = await sniffFileResponse(popResps);
        if (fileResp) {
          try {
            const ct = fileResp.headers()['content-type'] || '';
            const cd = fileResp.headers()['content-disposition'] || '';
            const ext = '.' + extFromCT(ct, defaultExt);
            const name = nameFromCD(cd, path.basename(saveBase) + ext);
            const out = path.join(path.dirname(saveBase), name);
            const buf = await fileResp.body();
            fs.writeFileSync(out, buf);
            pop.off('response', onPR);
            context.off('response', onResp);
            await pop.close().catch(() => {});
            return out;
          } catch (respError) {
            console.warn('Response save failed:', respError instanceof Error ? respError.message : String(respError));
          }
        }

        // V3.3: (b.1) 뷰어 내부 다운로드 버튼/아이콘 클릭 시도 - 동시 대기 패턴 (60초 타임아웃)
        const savedByButton = await clickDownloadButtonsInPage(pop, 3000, context, saveBase, defaultExt);
        if (savedByButton) {
          pop.off('response', onPR);
          context.off('response', onResp);
          await pop.close().catch(() => {});
          return savedByButton;
        }

        // (b.2) 직링크 다운로드 시도 (tp=D 폴백 - 기존 뷰어 URL 기반)
        const viewUrl = pop.url();
        const savedByDirect = await fetchDirectFromViewer(context, viewUrl, saveBase, defaultExt);
        if (savedByDirect) {
          pop.off('response', onPR);
          context.off('response', onResp);
          await pop.close().catch(() => {});
          return savedByDirect;
        }

        // (b.3) DOM에서 pdf/csv src 찾아 직접 GET (referer 포함)
        const src = await findPdfSrcInDom(pop);
        if (src) {
          try {
            const u = new URL(src, pop.url()).toString();
            const r = await context.request.get(u, { 
              headers: { Referer: pop.url() },
              timeout: 30000
            });
            const ct = r.headers()['content-type'] || '';
            if (FILE_CT.test(ct)) {
              const cd = r.headers()['content-disposition'] || '';
              const ext = '.' + extFromCT(ct, defaultExt);
              const name = nameFromCD(cd, path.basename(saveBase) + ext);
              const out = path.join(path.dirname(saveBase), name);
              const buf = await r.body();
              fs.writeFileSync(out, buf);
              pop.off('response', onPR);
              context.off('response', onResp);
              await pop.close().catch(() => {});
              return out;
            }
          } catch (getError) {
            console.warn('DOM src GET failed:', getError instanceof Error ? getError.message : String(getError));
          }
        }

        pop.off('response', onPR);
        await pop.close().catch(() => {});
      } catch (popError) {
        console.warn('Popup processing failed:', popError instanceof Error ? popError.message : String(popError));
        await pop.close().catch(() => {});
      }
    }

    // 3) 현재 컨텍스트 응답 중 파일형이면 저장
    const fileResp = await sniffFileResponse(respBucket);
    if (fileResp) {
      try {
        const ct = fileResp.headers()['content-type'] || '';
        const cd = fileResp.headers()['content-disposition'] || '';
        
        // Validate it's not HTML masquerading as file
        const buffer = await fileResp.body();
        const contentStr = buffer.toString('utf8', 0, Math.min(500, buffer.length));
        if (/<html|<!doctype/i.test(contentStr)) {
          context.off('response', onResp);
          return null; // HTML detected
        }
        
        const ext = '.' + extFromCT(ct, defaultExt);
        const name = nameFromCD(cd, path.basename(saveBase) + ext);
        const out = path.join(path.dirname(saveBase), name);
        fs.writeFileSync(out, buffer);
        context.off('response', onResp);
        return out;
      } catch (respError) {
        console.warn('File response save failed:', respError instanceof Error ? respError.message : String(respError));
      }
    }

    // V3.3: 원본 href 기반 직링크 시도 (모든 파라미터 보존)
    if (originalHref) {
      console.log('[TRY] original href fallback with preserved parameters:', originalHref);
      const savedByHref = await fetchDirectFromHref(context, originalHref, page.url(), saveBase, defaultExt);
      if (savedByHref) {
        context.off('response', onResp);
        return savedByHref;
      }
    } else {
      console.log('[DEBUG] No originalHref provided for fallback');
    }

    // V3.3: OS 다운로드 폴더 감시 폴백
    if (process.env.OS_DOWNLOADS_FALLBACK === 'true') {
      const osDir = process.env.OS_DOWNLOADS_DIR || 'C:\\Users\\lee\\Downloads';
      console.log('[TRY] OS downloads fallback monitoring:', osDir);
      
      const { waitAndPickupFromOS } = await import('./osDownloads');
      const picked = await waitAndPickupFromOS(osDir, /\.(pdf|csv|xlsx|xls|zip)$/i, 60000);
      
      if (picked) {
        const ext = path.extname(picked) || '.' + defaultExt;
        const target = `${saveBase}${ext}`;
        
        try {
          fs.copyFileSync(picked, target);
          console.log('[SAVE:os-pickup]', target);
          context.off('response', onResp);
          return target;
        } catch (copyError) {
          console.warn('OS pickup copy failed:', copyError instanceof Error ? copyError.message : String(copyError));
        }
      }
    }

    context.off('response', onResp);
    return null; // 파일성 응답 없음 → 링크로만 기록

  } catch (error) {
    console.warn('Download process failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

// Backward compatibility exports
export { clickResolveAndSaveV2 as clickAndSave };
export type ClickDownloadResult = {
  saved: boolean;
  path?: string;
  size?: number;
  hash?: string;
  ext?: string;
  error?: string;
};