import { writeFile, ensureDir } from './fs';
import path from 'path';
import { Summary } from '../parsers/notice';

export interface Attachment {
  kind: 'file' | 'link';
  code: string;
  label: string;
  url: string;
  path?: string;
  size?: number;
  hash?: string;
  ext?: string;
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
    ok: number;
    fail: number;
    skipped: number;
    retries: number;
    totalFiles: number;
    totalSize: number;
    codes: string[];
  };
  startedAt: string;
  endedAt: string;
  log: string[];
  summary?: Summary;
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
        ok: 0,
        fail: 0,
        skipped: 0,
        retries: 0,
        totalFiles: 0,
        totalSize: 0,
        codes: []
      },
      startedAt: new Date().toISOString(),
      endedAt: '',
      log: [],
      summary: undefined
    };
  }

  add(attachment: Attachment): void {
    this.data.attachments.push(attachment);
    this.updateStats();
  }

  addLog(message: string): void {
    this.data.log.push(`[${new Date().toISOString()}] ${message}`);
  }

  setSummary(summary: Summary): void {
    this.data.summary = summary;
  }

  finish(): void {
    this.data.endedAt = new Date().toISOString();
  }

  private updateStats(): void {
    const files = this.data.attachments.filter(a => a.kind === 'file');
    const successful = files.filter(a => a.success);
    const failed = files.filter(a => !a.success);
    const links = this.data.attachments.filter(a => a.kind === 'link');
    const codes = new Set(successful.map(a => a.code));
    
    this.data.stats = {
      ok: successful.length,
      fail: failed.length,
      skipped: links.length, // Links are skipped for download
      retries: 0, // Can be updated externally
      totalFiles: files.length,
      totalSize: successful.reduce((sum, a) => sum + (a.size || 0), 0),
      codes: Array.from(codes).sort()
    };

    // 누락된 필수 코드 계산 (file 종류만)
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
    const { ok, fail, skipped } = this.data.stats;
    const total = ok + fail;
    const missingText = this.data.missing.length > 0 
      ? ` (누락: ${this.data.missing.join(', ')})`
      : '';
    
    return `${ok}/${total} 성공, ${fail} 실패, ${skipped} 링크${missingText}`;
  }
}