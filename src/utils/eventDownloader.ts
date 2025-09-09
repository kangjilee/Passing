import fs from 'fs';
import path from 'path';
import type { Page, Response, Download, Locator } from 'playwright';

const ALLOWED_CT = /^(application\/pdf|application\/octet-stream|text\/csv|application\/vnd\.ms-excel|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/zip|image\/(png|jpeg|jpg|tiff|gif))/i;

function extFromCT(ct?: string, fallback = 'pdf'): string {
  if (!ct) return fallback;
  if (/pdf/i.test(ct)) return 'pdf';
  if (/csv/i.test(ct)) return 'csv';
  if (/zip/i.test(ct)) return 'zip';
  if (/excel/i.test(ct)) return 'xls';
  if (/spreadsheetml/i.test(ct)) return 'xlsx';
  if (/png/i.test(ct)) return 'png';
  if (/jpe?g/i.test(ct)) return 'jpg';
  if (/tiff/i.test(ct)) return 'tif';
  if (/gif/i.test(ct)) return 'gif';
  return fallback;
}

function filenameFromCD(cd?: string, def = 'file'): string {
  if (!cd) return def;
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
  if (m && m[1]) {
    return decodeURIComponent(m[1].replace(/[/\\?%*:|"<>]/g, '_'));
  }
  return def;
}

function defaultExtFromCode(code: string): string {
  if (/RTR/i.test(code)) return 'csv';
  if (/(IMG|TEN|NT|AP|REG|BLD|ZON|RS|NOI)/i.test(code)) return 'pdf';
  return 'pdf';
}

export interface ClickDownloadResult {
  saved: boolean;
  path?: string;
  size?: number;
  hash?: string;
  ext?: string;
  error?: string;
}

/**
 * 링크를 클릭해서 실제 파일을 저장. HTML 응답이면 파일 저장하지 않음
 * @param page Playwright page
 * @param element Element to click (Locator or ElementHandle)
 * @param saveBase Base path for saving (without extension)
 * @param code File code for default extension
 */
export async function clickAndSave(
  page: Page, 
  element: Locator | any, 
  saveBase: string, 
  code: string
): Promise<ClickDownloadResult> {
  try {
    const responses: Response[] = [];
    const onResp = (r: Response) => responses.push(r);
    page.on('response', onResp);

    // Ensure download directory exists
    await fs.promises.mkdir(path.dirname(saveBase), { recursive: true });

    // 클릭과 동시에 다운로드 이벤트 대기
    const dlPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    
    // Element click
    try {
      if (typeof element.click === 'function') {
        await element.click({ button: 'left', timeout: 5000 });
      } else {
        // Fallback for other element types
        await element.click();
      }
    } catch (clickError) {
      page.off('response', onResp);
      return { saved: false, error: `Click failed: ${clickError instanceof Error ? clickError.message : String(clickError)}` };
    }

    // Wait a bit for potential response
    await page.waitForTimeout(1000);

    const dl: Download | null = await dlPromise;

    if (dl) {
      // Download event occurred
      try {
        const suggested = dl.suggestedFilename() || 'download';
        const ext = path.extname(suggested) || '.' + defaultExtFromCode(code);
        const finalPath = `${saveBase}${ext}`;
        
        await dl.saveAs(finalPath);
        
        if (fs.existsSync(finalPath)) {
          const stats = fs.statSync(finalPath);
          const hash = require('crypto').createHash('md5').update(fs.readFileSync(finalPath)).digest('hex');
          
          page.off('response', onResp);
          return {
            saved: true,
            path: finalPath,
            size: stats.size,
            hash,
            ext: ext.slice(1)
          };
        }
      } catch (saveError) {
        page.off('response', onResp);
        return { saved: false, error: `Download save failed: ${saveError instanceof Error ? saveError.message : String(saveError)}` };
      }
    } else {
      // No download event - check responses for file content
      const fileResp = responses.reverse().find(r => {
        const ct = r.headers()['content-type'] || '';
        return ALLOWED_CT.test(ct) && r.status() === 200;
      });
      
      if (fileResp) {
        try {
          const ct = fileResp.headers()['content-type'] || '';
          const cd = fileResp.headers()['content-disposition'] || '';
          
          let ext = '.' + extFromCT(ct, defaultExtFromCode(code));
          let filename = filenameFromCD(cd, path.basename(saveBase));
          
          if (!path.extname(filename)) {
            filename += ext;
          }
          
          const finalPath = path.join(path.dirname(saveBase), filename);
          const buffer = await fileResp.body();
          
          // Validate it's not HTML
          const contentStr = buffer.toString('utf8', 0, Math.min(500, buffer.length));
          if (/<html|<!doctype/i.test(contentStr)) {
            page.off('response', onResp);
            return { saved: false, error: 'Response is HTML, not a file' };
          }
          
          fs.writeFileSync(finalPath, buffer);
          const hash = require('crypto').createHash('md5').update(buffer).digest('hex');
          
          page.off('response', onResp);
          return {
            saved: true,
            path: finalPath,
            size: buffer.length,
            hash,
            ext: path.extname(filename).slice(1)
          };
        } catch (respError) {
          page.off('response', onResp);
          return { saved: false, error: `Response save failed: ${respError instanceof Error ? respError.message : String(respError)}` };
        }
      }
    }

    // Try iframe/frame PDF fallback
    try {
      for (const frame of page.frames()) {
        const pdfResp = await frame.waitForResponse(r => 
          /application\/pdf/i.test(r.headers()['content-type'] || ''), 
          { timeout: 5000 }
        ).catch(() => null);
        
        if (pdfResp) {
          const buffer = await pdfResp.body();
          const finalPath = `${saveBase}.pdf`;
          fs.writeFileSync(finalPath, buffer);
          const hash = require('crypto').createHash('md5').update(buffer).digest('hex');
          
          page.off('response', onResp);
          return {
            saved: true,
            path: finalPath,
            size: buffer.length,
            hash,
            ext: 'pdf'
          };
        }
      }
    } catch {
      // Frame fallback failed
    }

    page.off('response', onResp);
    return { saved: false, error: 'No file download detected - likely HTML response' };

  } catch (error) {
    return { saved: false, error: error instanceof Error ? error.message : String(error) };
  }
}