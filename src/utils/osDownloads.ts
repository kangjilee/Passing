import fs from 'fs';
import path from 'path';

export async function waitAndPickupFromOS(
  dir: string, 
  pattern = /\.(pdf|csv|xlsx|xls|zip)$/i, 
  timeoutMs = 60000
): Promise<string | null> {
  const start = Date.now();
  let last: string | null = null;
  let lastSize = -1;
  
  while (Date.now() - start < timeoutMs) {
    try {
      const files = fs.readdirSync(dir)
        .filter(f => pattern.test(f) && !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
      
      // 가장 최근 파일
      files.sort((a, b) => {
        const statA = fs.statSync(path.join(dir, a));
        const statB = fs.statSync(path.join(dir, b));
        return statB.mtimeMs - statA.mtimeMs;
      });
      
      const cand = files[0];
      if (cand) {
        const p = path.join(dir, cand);
        const sz = fs.statSync(p).size;
        if (last === p && sz === lastSize && sz > 0) {
          console.log('[PICKUP] OS download detected:', p);
          return p; // 사이즈 고정 → 다운로드 완료로 간주
        }
        last = p;
        lastSize = sz;
      }
    } catch (error) {
      console.log('[PICKUP] OS directory read error:', error instanceof Error ? error.message : String(error));
    }
    
    await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log('[PICKUP] OS download timeout after', timeoutMs, 'ms');
  return null;
}