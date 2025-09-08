export function slugify(text: string): string {
  return text
    // 한글 제거/축약 (선택적으로 유지하거나 로마자 변환 가능)
    .replace(/[가-힣]/g, '') 
    // 공백을 하이픈으로
    .replace(/\s+/g, '-')
    // 특수문자 제거 (OS-safe characters만 유지)
    .replace(/[^\w\-_.]/g, '')
    // 연속 하이픈 정리
    .replace(/-+/g, '-')
    // 앞뒤 하이픈 제거
    .replace(/^-+|-+$/g, '')
    // 길이 제한
    .substring(0, 50)
    // 빈 문자열 방지
    || 'unnamed';
}

export function createSafeFilename(prefix: string, code: string, sequence: string, label: string, extension: string): string {
  const sluggedLabel = slugify(label);
  const parts = [prefix, code, sequence, sluggedLabel].filter(Boolean);
  return `${parts.join('__')}${extension}`;
}

export function createCasePrefix(caseNumber?: string, round?: string): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const caseSlug = caseNumber ? slugify(caseNumber) : 'UNKNOWN';
  const roundSlug = round ? slugify(round) : '1';
  
  return `${today}_${caseSlug}_${roundSlug}`;
}