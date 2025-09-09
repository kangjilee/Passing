import { Page, Frame, BrowserContext } from 'playwright';
import path from 'path';

export async function clickDownloadButtonsInPage(
  page: Page,
  timeout = 3000,
  browserContext?: BrowserContext,
  saveBase?: string,
  defaultExt?: string
): Promise<string | null> {
  const downloadSelectors = [
    // Korean text patterns
    'text=/다운로드|저장|내려받기|파일받기|원본저장|다운|download|save/i',
    
    // Button elements with Korean text
    'button:has-text(/다운로드|저장|내려받기|파일받기|원본저장/i)',
    'a:has-text(/다운로드|저장|내려받기|파일받기|원본저장/i)',
    'input[type="button"]:has-text(/다운로드|저장|내려받기|파일받기|원본저장/i)',
    
    // ARIA attributes
    '[aria-label*="다운로드" i]',
    '[aria-label*="저장" i]',
    '[aria-label*="download" i]',
    '[aria-label*="save" i]',
    
    // Title attributes
    '[title*="다운로드" i]',
    '[title*="저장" i]',
    '[title*="download" i]',
    '[title*="save" i]',
    
    // Class patterns
    '[class*="download" i]',
    '[class*="save" i]',
    '[class*="다운" i]',
    '[class*="저장" i]',
    
    // ID patterns
    '[id*="download" i]',
    '[id*="save" i]',
    '[id*="다운" i]',
    '[id*="저장" i]',
    
    // Common download icon classes
    '.fa-download',
    '.icon-download',
    '.download-icon',
    '.save-icon',
    '.btn-download',
    '.btn-save',
    
    // Input buttons with value
    'input[value*="다운로드" i]',
    'input[value*="저장" i]',
    'input[value*="download" i]',
    'input[value*="save" i]',
    
    // Images with alt text
    'img[alt*="다운로드" i]',
    'img[alt*="저장" i]',
    'img[alt*="download" i]',
    'img[alt*="save" i]'
  ];

  try {
    // First try main page
    const found = await tryClickDownloadButtons(page, downloadSelectors, timeout, browserContext, saveBase, defaultExt);
    if (found) return found;

    // Then try all frames
    const frames = page.frames();
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      
      try {
        const frameFound = await tryClickDownloadButtons(frame, downloadSelectors, timeout / 2, browserContext, saveBase, defaultExt);
        if (frameFound) return frameFound;
      } catch (error) {
        console.log(`[clickDownloadButtonsInPage] Frame search failed:`, error);
      }
    }

    return null;
  } catch (error) {
    console.log(`[clickDownloadButtonsInPage] Error:`, error);
    return null;
  }
}

async function tryClickDownloadButtons(
  context: Page | Frame,
  selectors: string[],
  timeout: number,
  browserContext?: any,
  saveBase?: string,
  defaultExt?: string
): Promise<string | null> {
  for (const selector of selectors) {
    try {
      const elements = await context.locator(selector).all();
      
      for (const element of elements) {
        try {
          // Check if element is visible and clickable
          const isVisible = await element.isVisible();
          const isEnabled = await element.isEnabled();
          
          if (isVisible && isEnabled && browserContext && saveBase) {
            console.log(`[TRY] waiting download & click:`, selector);
            
            // V3.2: 동시 대기 패턴으로 다운로드 이벤트를 놓치지 않음
            try {
              const [dl] = await Promise.all([
                browserContext.waitForEvent('download', { timeout: 15000 }),
                element.click({ force: true, timeout: 1000 })
              ]);
              
              if (dl) {
                const suggested = dl.suggestedFilename() || '';
                const ext = path.extname(suggested) || '.' + (defaultExt || 'pdf');
                const out = `${saveBase}${ext}`;
                await dl.saveAs(out);
                await dl.finished(); // 파일 완전히 기록될 때까지 대기
                console.log('[SAVE:download]', out);
                return out;
              }
            } catch (downloadError) {
              console.log(`[TRY] Download event failed for ${selector}:`, downloadError instanceof Error ? downloadError.message : String(downloadError));
              continue;
            }
          } else if (isVisible && isEnabled) {
            // 기존 방식 (browserContext 없을 때)
            console.log(`[tryClickDownloadButtons] Clicking element with selector: ${selector}`);
            await element.click({ timeout: 1000 });
            
            // Small delay to allow download to trigger
            await new Promise(resolve => setTimeout(resolve, 500));
            return 'clicked'; // 성공했지만 다운로드는 외부에서 처리
          }
        } catch (clickError) {
          // Continue to next element if click fails
          continue;
        }
      }
    } catch (selectorError) {
      // Continue to next selector if this one fails
      continue;
    }
  }
  
  return null;
}