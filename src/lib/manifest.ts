import fs from 'fs-extra';
import path from 'path';
import { Logger } from './log';
import { DocumentCandidate } from './pageScan';
import { ResolvedUrl } from './resolver';
import { DownloadResult } from './downloader';

export interface ManifestEntry {
  code?: string;
  originalText: string;
  filename: string;
  filepath: string;
  finalUrl: string;
  method: string;
  requestBody?: string;
  contentType?: string;
  size: number;
  timestamp: string;
  success: boolean;
  error?: string;
}

export interface Manifest {
  casePrefix: string;
  totalCandidates: number;
  processedFiles: ManifestEntry[];
  missing: string[];
  summary: {
    foundCodes: string[];
    totalSize: number;
    successCount: number;
    failCount: number;
  };
  metadata: {
    createdAt: string;
    processedUrls: string[];
  };
}

export class ManifestManager {
  private logger: Logger;
  private requiredCodes = ['AP', 'RS', 'REG', 'BLD', 'ZON'];
  private allCodes = ['AP', 'RS', 'REG', 'BLD', 'ZON', 'RTR', 'TEN', 'NT'];
  private existingFiles: Set<string> = new Set();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async createManifest(
    casePrefix: string,
    candidates: DocumentCandidate[],
    resolvedUrls: ResolvedUrl[],
    downloadResults: DownloadResult[],
    processedUrls: string[],
    outputDir: string
  ): Promise<Manifest> {
    
    const entries: ManifestEntry[] = [];
    const foundCodes: Set<string> = new Set();
    let totalSize = 0;
    let successCount = 0;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const resolved = resolvedUrls[i];
      const download = downloadResults[i];

      const entry: ManifestEntry = {
        code: candidate.code,
        originalText: candidate.text,
        filename: download.filename,
        filepath: download.filepath,
        finalUrl: resolved.finalUrl,
        method: resolved.method,
        requestBody: resolved.requestBody,
        contentType: download.contentType || resolved.contentType,
        size: download.size,
        timestamp: new Date().toISOString(),
        success: download.success
      };

      if (!download.success) {
        entry.error = download.error || resolved.error || 'Unknown error';
      }

      entries.push(entry);

      if (download.success && candidate.code) {
        foundCodes.add(candidate.code);
        totalSize += download.size;
        successCount++;
      }
    }

    const missing = this.requiredCodes.filter(code => !foundCodes.has(code));

    const manifest: Manifest = {
      casePrefix,
      totalCandidates: candidates.length,
      processedFiles: entries,
      missing,
      summary: {
        foundCodes: Array.from(foundCodes).sort(),
        totalSize,
        successCount,
        failCount: candidates.length - successCount
      },
      metadata: {
        createdAt: new Date().toISOString(),
        processedUrls
      }
    };

    const manifestPath = path.join(outputDir, 'MANIFEST.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    
    this.logger.info('MANIFEST 생성 완료', {
      path: manifestPath,
      foundCodes: Array.from(foundCodes),
      missing
    });

    return manifest;
  }

  generateUniqueFilename(
    candidate: DocumentCandidate,
    resolved: ResolvedUrl,
    extension: string,
    outputDir: string
  ): string {
    
    const code = candidate.code || 'UNK';
    
    const sanitizedText = candidate.text
      .replace(/[^\w\s\-_가-힣]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 20);
    
    const baseFilename = `${code}_${sanitizedText}${extension}`;
    
    let counter = 1;
    let filename = baseFilename;
    
    while (this.existingFiles.has(filename) || 
           fs.existsSync(path.join(outputDir, filename))) {
      const nameWithoutExt = baseFilename.replace(extension, '');
      filename = `${nameWithoutExt}_${counter}${extension}`;
      counter++;
    }
    
    this.existingFiles.add(filename);
    this.logger.debug('고유 파일명 생성', { original: baseFilename, final: filename });
    
    return filename;
  }

  async loadExistingManifest(outputDir: string): Promise<Manifest | null> {
    const manifestPath = path.join(outputDir, 'MANIFEST.json');
    
    try {
      if (await fs.pathExists(manifestPath)) {
        const content = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(content) as Manifest;
        
        for (const entry of manifest.processedFiles) {
          if (entry.success) {
            this.existingFiles.add(entry.filename);
          }
        }
        
        this.logger.info('기존 MANIFEST 로드', { 
          files: manifest.processedFiles.length,
          found: manifest.summary.foundCodes
        });
        
        return manifest;
      }
    } catch (error) {
      this.logger.warn('기존 MANIFEST 로드 실패', { error: error.message });
    }
    
    return null;
  }

  async mergeManifests(
    existing: Manifest,
    newManifest: Manifest
  ): Promise<Manifest> {
    
    const merged: Manifest = {
      ...newManifest,
      processedFiles: [...existing.processedFiles, ...newManifest.processedFiles],
      totalCandidates: existing.totalCandidates + newManifest.totalCandidates,
      metadata: {
        ...newManifest.metadata,
        processedUrls: [...existing.metadata.processedUrls, ...newManifest.metadata.processedUrls]
      }
    };

    const allFoundCodes = new Set<string>();
    let totalSize = 0;
    let successCount = 0;

    for (const entry of merged.processedFiles) {
      if (entry.success && entry.code) {
        allFoundCodes.add(entry.code);
        totalSize += entry.size;
        successCount++;
      }
    }

    merged.summary = {
      foundCodes: Array.from(allFoundCodes).sort(),
      totalSize,
      successCount,
      failCount: merged.totalCandidates - successCount
    };

    merged.missing = this.requiredCodes.filter(code => !allFoundCodes.has(code));

    this.logger.info('MANIFEST 병합 완료', {
      totalFiles: merged.processedFiles.length,
      foundCodes: merged.summary.foundCodes,
      missing: merged.missing
    });

    return merged;
  }

  getMissingCodesReport(manifest: Manifest): string {
    if (manifest.missing.length === 0) {
      return '모든 필수 코드가 수집되었습니다.';
    }

    const missingDescriptions: Record<string, string> = {
      'AP': '감정평가서',
      'RS': '재산명세서',
      'REG': '등기부등본',
      'BLD': '건축물대장',
      'ZON': '토지이용계획'
    };

    const missing = manifest.missing.map(code => 
      `${code} (${missingDescriptions[code] || '알 수 없음'})`
    );

    return `누락된 필수 문서: ${missing.join(', ')}`;
  }

  validateManifest(manifest: Manifest): { isValid: boolean; issues: string[] } {
    const issues: string[] = [];

    if (manifest.missing.length > 0) {
      issues.push(`필수 코드 누락: ${manifest.missing.join(', ')}`);
    }

    if (manifest.summary.failCount > manifest.summary.successCount) {
      issues.push(`실패율이 높음: ${manifest.summary.failCount}/${manifest.totalCandidates}`);
    }

    if (manifest.summary.totalSize === 0) {
      issues.push('다운로드된 파일이 없음');
    }

    const duplicateFiles = this.findDuplicateFiles(manifest.processedFiles);
    if (duplicateFiles.length > 0) {
      issues.push(`중복 파일 감지: ${duplicateFiles.join(', ')}`);
    }

    return {
      isValid: issues.length === 0,
      issues
    };
  }

  private findDuplicateFiles(entries: ManifestEntry[]): string[] {
    const filenames = new Map<string, number>();
    
    for (const entry of entries) {
      if (entry.success) {
        const count = filenames.get(entry.filename) || 0;
        filenames.set(entry.filename, count + 1);
      }
    }

    return Array.from(filenames.entries())
      .filter(([, count]) => count > 1)
      .map(([filename]) => filename);
  }

  clearFileCache(): void {
    this.existingFiles.clear();
  }
}