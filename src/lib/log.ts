import fs from 'fs-extra';
import path from 'path';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export class Logger {
  private logFile: string;
  private logLevel: LogLevel;

  constructor(logLevel: LogLevel = 'INFO') {
    this.logLevel = logLevel;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.logFile = path.join(process.cwd(), 'logs', `run-${timestamp}.log`);
    
    fs.ensureDirSync(path.dirname(this.logFile));
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    return levels.indexOf(level) >= levels.indexOf(this.logLevel);
  }

  private formatMessage(level: LogLevel, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
    return `[${timestamp}] ${level}: ${message}${dataStr}`;
  }

  private writeLog(level: LogLevel, message: string, data?: any) {
    if (!this.shouldLog(level)) return;
    
    const formatted = this.formatMessage(level, message, data);
    console.log(formatted);
    fs.appendFileSync(this.logFile, formatted + '\n');
  }

  debug(message: string, data?: any) {
    this.writeLog('DEBUG', message, data);
  }

  info(message: string, data?: any) {
    this.writeLog('INFO', message, data);
  }

  warn(message: string, data?: any) {
    this.writeLog('WARN', message, data);
  }

  error(message: string, data?: any) {
    this.writeLog('ERROR', message, data);
  }

  summary(stats: {
    total: number;
    success: number;
    missingCodes: string[];
    failedUrls: number;
  }) {
    const message = `처리 ${stats.total}건 / 성공 ${stats.success} / 누락코드 {${stats.missingCodes.join(',')}} / 실패 URL ${stats.failedUrls}개`;
    this.info('=== SUMMARY ===');
    this.info(message);
    this.info('===============');
    return message;
  }

  getLogFile(): string {
    return this.logFile;
  }
}