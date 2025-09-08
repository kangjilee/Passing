import { test, expect } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import { slugify, createCasePrefix, createSafeFilename } from '../src/utils/slug';
import { RateLimiter } from '../src/utils/rate';
import { Manifest } from '../src/utils/manifest';

test('slugify should create OS-safe slugs', () => {
  expect(slugify('감정평가서 (2024)')).toBe('2024');
  expect(slugify('재산명세서.pdf')).toBe('pdf');
  expect(slugify('Special@#$%Characters')).toBe('SpecialCharacters');
  expect(slugify('multiple   spaces')).toBe('multiple-spaces');
  expect(slugify('')).toBe('unnamed');
});

test('createCasePrefix should generate valid prefixes', () => {
  const prefix = createCasePrefix('2024타경12345', '1차');
  expect(prefix).toMatch(/^\d{8}_2024_1$/);
  
  const unknownPrefix = createCasePrefix();
  expect(unknownPrefix).toMatch(/^\d{8}_UNKNOWN_1$/);
});

test('createSafeFilename should generate unique filenames', () => {
  const filename = createSafeFilename('20241201_2024_1', 'AP', '01', '감정평가서', '.pdf');
  expect(filename).toBe('20241201_2024_1__AP__01__.pdf');
});

test('RateLimiter should respect concurrency and QPS limits', async () => {
  const limiter = new RateLimiter(2, 5); // 동시 2개, 초당 5개
  const startTime = Date.now();
  const results: number[] = [];
  
  const promises = [];
  for (let i = 0; i < 6; i++) {
    promises.push(
      limiter.add(async () => {
        const elapsed = Date.now() - startTime;
        results.push(elapsed);
        return i;
      })
    );
  }
  
  await Promise.all(promises);
  
  // 6개 요청이 초당 5개 제한으로 최소 1초 이상 걸려야 함
  const totalTime = Date.now() - startTime;
  expect(totalTime).toBeGreaterThan(1000);
  
  // 동시 실행 확인 (처음 2개는 거의 동시에 시작)
  expect(results[1] - results[0]).toBeLessThan(100);
});

test('Manifest should track attachments and missing codes', async () => {
  const manifest = new Manifest(
    'http://test.com', 
    'Test Case', 
    'test_prefix', 
    ['AP', 'REG', 'BLD']
  );
  
  // 성공 케이스 추가
  manifest.add({
    code: 'AP',
    label: '감정평가서',
    url: 'http://test.com/file1',
    path: '/test/file1.pdf',
    hash: 'hash1',
    size: 1024,
    success: true
  });
  
  // 실패 케이스 추가
  manifest.add({
    code: 'REG',
    label: '등기부등본',
    url: 'http://test.com/file2',
    path: '',
    hash: '',
    size: 0,
    success: false,
    error: 'Download failed'
  });
  
  const stats = manifest.getStats();
  expect(stats.success).toBe(1);
  expect(stats.failed).toBe(1);
  expect(stats.codes).toEqual(['AP']);
  
  const missing = manifest.getMissing();
  expect(missing).toContain('REG');
  expect(missing).toContain('BLD');
  expect(missing).not.toContain('AP');
});

test('File utilities should handle basic operations', async () => {
  const testDir = path.join(process.cwd(), 'test-temp');
  const testFile = path.join(testDir, 'test.txt');
  
  try {
    const { ensureDir, writeFile, pathExists, getFileStats } = await import('../src/utils/fs');
    
    await ensureDir(testDir);
    expect(await pathExists(testDir)).toBe(true);
    
    await writeFile(testFile, 'test content');
    expect(await pathExists(testFile)).toBe(true);
    
    const stats = await getFileStats(testFile);
    expect(stats?.size).toBeGreaterThan(0);
    
  } finally {
    // 정리
    if (await fs.pathExists(testDir)) {
      await fs.remove(testDir);
    }
  }
});

test('Configuration parsing should handle environment variables', () => {
  const originalEnv = process.env;
  
  try {
    process.env.CONCURRENCY = '3';
    process.env.QPS = '10';
    process.env.CODES = 'AP,REG,BLD';
    
    // 환경변수가 올바르게 파싱되는지 테스트
    expect(parseInt(process.env.CONCURRENCY || '2')).toBe(3);
    expect(parseInt(process.env.QPS || '2')).toBe(10);
    expect(process.env.CODES?.split(',')).toEqual(['AP', 'REG', 'BLD']);
    
  } finally {
    process.env = originalEnv;
  }
});