import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.ensureDir(dirPath);
}

export async function writeFile(filePath: string, content: Buffer | string): Promise<void> {
  await fs.writeFile(filePath, content);
}

export async function readFile(filePath: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
  return fs.readFile(filePath, encoding);
}

export async function pathExists(filePath: string): Promise<boolean> {
  return fs.pathExists(filePath);
}

export async function getFileStats(filePath: string) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

export function calculateHash(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

export async function findUniqueFilename(basePath: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const name = path.basename(filename, ext);
  const dir = path.dirname(basePath);
  
  let counter = 1;
  let candidateFilename = filename;
  let candidatePath = path.join(dir, candidateFilename);
  
  while (await pathExists(candidatePath)) {
    candidateFilename = `${name}_${counter}${ext}`;
    candidatePath = path.join(dir, candidateFilename);
    counter++;
    
    // 무한루프 방지
    if (counter > 1000) {
      candidateFilename = `${name}_${Date.now()}${ext}`;
      break;
    }
  }
  
  return candidateFilename;
}

export async function isValidFile(filePath: string, minSize: number = 1024): Promise<boolean> {
  const stats = await getFileStats(filePath);
  return stats ? stats.size >= minSize : false;
}