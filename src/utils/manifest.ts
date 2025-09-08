import { writeFile, ensureDir } from './fs';
import path from 'path';

export interface Attachment {
  code: string;
  label: string;
  url: string;
  path: string;
  hash: string;
  size: number;
  success: boolean;
  error?: string;
}

export interface ManifestData {
  url: string;
  title: string;
  prefix: string;
  attachments: Attachment[];
  missing: string[];
  stats: {
    total: number;
    success: number;
    failed: number;
    totalSize: number;
    codes: string[];
  };
  meta: {
    timestamp: string;
    version: string;
  };
}

export class Manifest {
  private data: ManifestData;
  private requiredCodes: Set<string>;

  constructor(url: string, title: string, prefix: string, requiredCodes: string[] = ['AP', 'REG', 'BLD', 'ZON', 'RS']) {
    this.requiredCodes = new Set(requiredCodes);
    
    this.data = {
      url,
      title,
      prefix,
      attachments: [],
      missing: [],
      stats: {
        total: 0,
        success: 0,
        failed: 0,
        totalSize: 0,
        codes: []
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      }
    };
  }

  add(attachment: Attachment): void {
    this.data.attachments.push(attachment);
    this.updateStats();
  }

  private updateStats(): void {
    const successful = this.data.attachments.filter(a => a.success);
    const codes = new Set(successful.map(a => a.code));
    
    this.data.stats = {
      total: this.data.attachments.length,
      success: successful.length,
      failed: this.data.attachments.length - successful.length,
      totalSize: successful.reduce((sum, a) => sum + a.size, 0),
      codes: Array.from(codes).sort()
    };

    // 누락된 필수 코드 계산
    this.data.missing = Array.from(this.requiredCodes)
      .filter(code => !codes.has(code))
      .sort();
  }

  async save(outputDir: string): Promise<void> {
    await ensureDir(outputDir);
    const manifestPath = path.join(outputDir, 'MANIFEST.json');
    await writeFile(manifestPath, JSON.stringify(this.data, null, 2));
  }

  getData(): ManifestData {
    return { ...this.data };
  }

  getStats() {
    return { ...this.data.stats };
  }

  getMissing(): string[] {
    return [...this.data.missing];
  }

  hasRequiredCodes(): boolean {
    return this.data.missing.length === 0;
  }

  getSummary(): string {
    const { total, success, failed } = this.data.stats;
    const missingText = this.data.missing.length > 0 
      ? ` (누락: ${this.data.missing.join(', ')})`
      : '';
    
    return `${success}/${total} 성공, ${failed} 실패${missingText}`;
  }
}