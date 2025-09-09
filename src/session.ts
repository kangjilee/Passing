// src/session.ts
import { chromium, BrowserContext, LaunchOptions } from 'playwright';
import fs from 'fs';
import path from 'path';

const HEADLESS = String(process.env.HEADLESS).toLowerCase() === 'true';

export async function openContext(): Promise<BrowserContext> {
  const profile = process.env.CHROME_PROFILE?.trim();
  const storage = process.env.COOKIE_TANK?.trim();
  const channel = 'chrome'; // 크롬 채널 강제(기업 환경 호환성 ↑)

  console.log(`[SESSION] HEADLESS=${HEADLESS} PROFILE=${profile ?? '-'} STORAGE=${storage ?? '-'}`);

  // 1) 프로필 우선 모드 (요청 시)
  if (profile) {
    return await chromium.launchPersistentContext(profile, {
      channel,
      headless: HEADLESS,
      acceptDownloads: true,
      downloadsPath: path.resolve('out/_dl')
    });
  }

  // 2) 스토리지(쿠키) 모드
  const launch: LaunchOptions = { channel, headless: HEADLESS };
  const browser = await chromium.launch(launch);

  const contextOptions = {
    acceptDownloads: true,
    baseURL: 'https://www.tankauction.com'
  };

  // storageState 파일이 있으며, 확실히 존재하면 적용
  if (storage && fs.existsSync(storage)) {
    const resolved = path.resolve(storage);
    console.log(`[SESSION] using storageState: ${resolved}`);
    return await browser.newContext({ 
      ...contextOptions,
      storageState: resolved 
    });
  }

  // 3) 임시 모드(비권장): 로그인 페이지로 튈 수 있음
  console.warn('[SESSION] No PROFILE/COOKIE provided. Using ephemeral session.');
  return await browser.newContext(contextOptions);
}