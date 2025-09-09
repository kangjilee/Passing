import { Page } from 'playwright';

export type Summary = {
  caseNo?: string;
  round?: string;
  type?: string;
  usage?: string;
  addr?: string;
  lot?: string;
  landArea?: number;
  buildArea?: number;
  appraisal?: number;
  minPrice?: number;
  roundCount?: number;
  distribDue?: string;
  payDue?: string;
  tenancy?: string;
  special?: string;
};

export async function extractSummary(page: Page): Promise<Summary> {
  try {
    const txt = (await page.content()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    
    const g = (re: RegExp): string => (txt.match(re)?.[1] || '').trim();
    
    // Helper function to extract numbers with commas
    const extractNumber = (pattern: string): number | undefined => {
      const numStr = g(new RegExp(pattern)).replace(/,/g, '');
      const num = Number(numStr);
      return num && !isNaN(num) ? num : undefined;
    };

    // Helper function to extract date
    const extractDate = (pattern: string): string | undefined => {
      const match = txt.match(new RegExp(pattern));
      if (match && match[1]) {
        const dateStr = match[1].replace(/[^0-9]/g, '');
        if (dateStr.length >= 8) {
          return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
        }
      }
      return undefined;
    };

    return {
      // 사건번호 (여러 패턴 시도)
      caseNo: g(/(\d{4}-\d{7}-\d{1,4})/) || g(/(\d{4}타경\d+)/) || g(/사건번호[:\s]*([^\s\n]+)/),
      
      // 차수
      round: g(/(\d+)\s*차/),
      
      // 부동산 종류
      type: g(/(아파트|오피스텔|단독주택|연립주택|다세대주택|상가|토지|공장|창고|기타)/) || 
            g(/부동산의?\s*표시[^가-힣]*([가-힣]+)/),
      
      // 용도
      usage: g(/용도[:\s]*([^\s\n,]+)/) || g(/주용도[:\s]*([^\s\n,]+)/),
      
      // 소재지
      addr: g(/소재지[:\s]*([^\n]+?)(?:\s|$)/) || 
            g(/소재[:\s]*([^\n]+?)(?:\s|$)/) ||
            g(/(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\n]+?(?=\s|$)/),
      
      // 지번
      lot: g(/지번[:\s]*([^\s\n]+)/) || g(/번지[:\s]*([^\s\n]+)/),
      
      // 토지면적 (㎡)
      landArea: extractNumber('토지면적[^0-9]*([\\d,]+)') || 
                extractNumber('대지면적[^0-9]*([\\d,]+)') ||
                extractNumber('면적[^0-9]*([\\d,]+)'),
      
      // 건물면적 (㎡)
      buildArea: extractNumber('건물면적[^0-9]*([\\d,]+)') ||
                 extractNumber('연면적[^0-9]*([\\d,]+)') ||
                 extractNumber('전용면적[^0-9]*([\\d,]+)'),
      
      // 감정가액 (원)
      appraisal: extractNumber('감정가[^0-9]*([\\d,]+)') ||
                 extractNumber('감정평가액[^0-9]*([\\d,]+)'),
      
      // 최저매각가격 (원)
      minPrice: extractNumber('최저가[^0-9]*([\\d,]+)') ||
                extractNumber('최저매각가격[^0-9]*([\\d,]+)') ||
                extractNumber('매각가격[^0-9]*([\\d,]+)'),
      
      // 매각회차
      roundCount: extractNumber('(\\d+)회\\s*매각') || extractNumber('매각회차[^0-9]*([\\d]+)'),
      
      // 배분요구 종기
      distribDue: extractDate('배분요구\\s*종기[^0-9]*([0-9]{4}[^0-9]{0,3}[0-9]{1,2}[^0-9]{0,3}[0-9]{1,2})') ||
                  extractDate('배당요구\\s*종기[^0-9]*([0-9]{4}[^0-9]{0,3}[0-9]{1,2}[^0-9]{0,3}[0-9]{1,2})'),
      
      // 대금납부기한
      payDue: extractDate('대금\\s*납부[^0-9]*([0-9]{4}[^0-9]{0,3}[0-9]{1,2}[^0-9]{0,3}[0-9]{1,2})') ||
              extractDate('납부기한[^0-9]*([0-9]{4}[^0-9]{0,3}[0-9]{1,2}[^0-9]{0,3}[0-9]{1,2})'),
      
      // 임차권 정보
      tenancy: g(/임차권[:\s]*([^\n]+?)(?:\s|$)/) || 
               g(/임차보증금[:\s]*([^\n]+?)(?:\s|$)/) ||
               g(/점유자[:\s]*([^\n]+?)(?:\s|$)/),
      
      // 특약/유의사항
      special: g(/특약[:\s]*([^\n]+?)(?:\s|$)/) ||
               g(/유의사항[:\s]*([^\n]+?)(?:\s|$)/) ||
               g(/주의사항[:\s]*([^\n]+?)(?:\s|$)/)
    };

  } catch (error) {
    console.warn('Summary extraction failed:', error instanceof Error ? error.message : String(error));
    return {};
  }
}

// Helper function to convert HTML table to CSV
export function tableToCsv(html: string): string {
  try {
    // Extract first table from HTML
    const tableMatch = html.match(/<table[^>]*>.*?<\/table>/is);
    if (!tableMatch) return '';
    
    const tableHtml = tableMatch[0];
    
    // Extract rows
    const rowMatches = tableHtml.match(/<tr[^>]*>.*?<\/tr>/gis);
    if (!rowMatches) return '';
    
    const csvRows: string[] = [];
    
    for (const rowHtml of rowMatches) {
      const cellMatches = rowHtml.match(/<t[hd][^>]*>.*?<\/t[hd]>/gis);
      if (!cellMatches) continue;
      
      const cells = cellMatches.map(cellHtml => {
        // Remove HTML tags and clean up
        let text = cellHtml.replace(/<[^>]+>/g, '').trim();
        // Handle CSV escaping
        if (text.includes(',') || text.includes('"') || text.includes('\n')) {
          text = `"${text.replace(/"/g, '""')}"`;
        }
        return text;
      });
      
      csvRows.push(cells.join(','));
    }
    
    return csvRows.join('\n');
  } catch (error) {
    console.warn('Table to CSV conversion failed:', error instanceof Error ? error.message : String(error));
    return '';
  }
}