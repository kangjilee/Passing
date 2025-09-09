import { BrowserContext } from 'playwright';
import fs from 'fs';

export async function extractPdfFromHtml(
  context: BrowserContext, 
  htmlUrl: string, 
  refererUrl: string, 
  saveBase: string
): Promise<string | null> {
  try {
    console.log('[HTML-PDF] Extracting PDF from HTML viewer:', htmlUrl);
    
    const r = await context.request.get(htmlUrl, { 
      headers: { Referer: refererUrl },
      timeout: 30000
    });
    
    const ct = r.headers()['content-type'] || '';
    
    // 이미 PDF인 경우
    if (/application\/pdf|application\/octet-stream/i.test(ct)) {
      const out = `${saveBase}.pdf`;
      const buf = await r.body();
      fs.writeFileSync(out, buf);
      console.log('[SAVE:direct-pdf]', out);
      return out;
    }
    
    // HTML인 경우 PDF 링크 추출
    if (/text\/html/i.test(ct)) {
      const htmlContent = await r.text();
      console.log('[HTML-PDF] Searching for PDF links in HTML content');
      
      // HTML 내용을 파일로 저장해서 확인
      try {
        fs.writeFileSync('./out/_debug/viewer_html_sample.html', htmlContent);
        console.log('[HTML-PDF] HTML content saved to ./out/_debug/viewer_html_sample.html');
      } catch (writeError) {
        console.log('[HTML-PDF] Failed to save HTML content');
      }
      
      // 다양한 패턴으로 PDF 링크 찾기
      const patterns = [
        // JavaScript 데이터에서 PDF 파일 경로 추출 (탱크옥션 특화)
        /"파일경로":"([^"]*\.pdf[^"]*)"/gi,
        // iframe/embed src
        /(?:src|data)=["']([^"']*(?:\.pdf|paFile\.php[^"']*tp=D)[^"']*)/gi,
        // a href 
        /href=["']([^"']*(?:\.pdf|paFile\.php[^"']*tp=D)[^"']*)/gi,
        // JavaScript 함수 호출
        /(?:window\.open|location\.href)\s*=?\s*["']([^"']*(?:\.pdf|paFile\.php[^"']*tp=D)[^"']*)/gi,
        // 일반적인 PDF URL 패턴
        /https?:\/\/[^"'\s]*(?:\.pdf|paFile\.php[^"'\s]*tp=D)[^"'\s]*/gi
      ];
      
      const foundLinks = new Set<string>();
      
      for (const pattern of patterns) {
        const matches = [...htmlContent.matchAll(pattern)];
        for (const match of matches) {
          const link = match[1] || match[0];
          if (link) foundLinks.add(link);
        }
      }
      
      console.log('[HTML-PDF] Found', foundLinks.size, 'potential PDF links');
      
      if (foundLinks.size > 0 && foundLinks.size <= 5) {
        console.log('[HTML-PDF] Links:', [...foundLinks].slice(0, 3).join(', '));
      }
      
      // 각 링크 시도
      for (const link of foundLinks) {
        try {
          const pdfUrl = new URL(link, htmlUrl).toString();
          console.log('[HTML-PDF] Trying:', pdfUrl);
          
          const pdfR = await context.request.get(pdfUrl, { 
            headers: { Referer: htmlUrl },
            timeout: 30000
          });
          
          const pdfCt = pdfR.headers()['content-type'] || '';
          console.log('[HTML-PDF] Response Content-Type:', pdfCt);
          
          if (/application\/pdf/i.test(pdfCt)) {
            const out = `${saveBase}.pdf`;
            const buf = await pdfR.body();
            fs.writeFileSync(out, buf);
            console.log('[SAVE:html-extracted-pdf]', out);
            return out;
          }
        } catch (linkError) {
          console.log('[HTML-PDF] Link failed:', linkError instanceof Error ? linkError.message : String(linkError));
        }
      }
    }
    
    return null;
  } catch (error) {
    console.log('[HTML-PDF] Extraction failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}