import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { OperationalLogEntry, OperationalLogLevel, OperationalLogQuery } from '../core/diagnostics/types';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const RETENTION_DAYS = 14;
const MAX_MESSAGE_LENGTH = 12_000;

function localDate(value = new Date()): string {
  const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function redactOperationalLogText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(cookie\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/((?:LSID|sid|lid|password|token|secret)["']?\s*[=:]\s*["']?)[^\s&;,"']+/gi, '$1[REDACTED]')
    .replace(/DFL1\.[A-Za-z0-9._~-]+/g, 'DFL1.[REDACTED]');
}

function formatValue(value: unknown): string {
  if (value instanceof Error) {
    return redactOperationalLogText([value.name, value.message, value.stack].filter(Boolean).join('\n'));
  }
  if (typeof value === 'string') return redactOperationalLogText(value);
  if (value === undefined) return 'undefined';
  try {
    const seen = new WeakSet<object>();
    return redactOperationalLogText(JSON.stringify(value, (key, item: unknown) => {
      if (/^(password|token|cookie|sid|lid|authorization|secret|licenseKey|activationKey)$/i.test(key)) {
        return '[REDACTED]';
      }
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }));
  } catch {
    return redactOperationalLogText(String(value));
  }
}

export class OperationalLogService {
  private directory = '';
  private appVersion = '';
  private consoleInstalled = false;

  initialize(userDataPath: string, appVersion: string): void {
    this.directory = join(userDataPath, 'logs');
    this.appVersion = appVersion;
    mkdirSync(this.directory, { recursive: true });
    this.removeExpiredFiles();
    this.write('info', 'application', `数据融合助手启动 v${appVersion}`);
  }

  installConsoleCapture(): void {
    if (this.consoleInstalled) return;
    this.consoleInstalled = true;
    for (const level of ['info', 'warn', 'error'] as const) {
      const original = console[level].bind(console);
      console[level] = (...values: unknown[]) => {
        original(...values);
        this.write(level, 'console', ...values);
      };
    }
    process.on('uncaughtExceptionMonitor', (error) => this.write('error', 'process.uncaught', error));
    process.on('unhandledRejection', (reason) => this.write('error', 'process.rejection', reason));
  }

  write(level: OperationalLogLevel, source: string, ...values: unknown[]): void {
    if (!this.directory) return;
    const message = values.map(formatValue).join(' ').slice(0, MAX_MESSAGE_LENGTH);
    const entry: OperationalLogEntry = {
      timestamp: Date.now(),
      level,
      source: redactOperationalLogText(source).slice(0, 120),
      message,
    };
    try {
      appendFileSync(this.currentFile(), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Logging must never interrupt business work.
    }
  }

  list(query: OperationalLogQuery = {}): OperationalLogEntry[] {
    if (!this.directory) return [];
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 500), 1), 2_000);
    const keyword = query.keyword?.trim().toLocaleLowerCase() ?? '';
    const result: OperationalLogEntry[] = [];
    for (const file of this.logFiles()) {
      let lines: string[];
      try {
        lines = readFileSync(join(this.directory, file), 'utf8').split(/\r?\n/).filter(Boolean).reverse();
      } catch {
        continue;
      }
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as OperationalLogEntry;
          if (query.level && query.level !== 'all' && entry.level !== query.level) continue;
          if (keyword && !`${entry.source} ${entry.message}`.toLocaleLowerCase().includes(keyword)) continue;
          result.push(entry);
          if (result.length >= limit) return result;
        } catch {
          // Ignore a partially written or invalid line.
        }
      }
    }
    return result;
  }

  exportTo(filePath: string): { path: string; count: number } {
    const entries = this.list({ limit: 2_000 }).map((entry) => ({
      ...entry,
      source: redactOperationalLogText(entry.source),
      message: redactOperationalLogText(entry.message),
    }));
    const header = {
      exportedAt: new Date().toISOString(),
      appVersion: this.appVersion,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      note: '日志已在写入时进行凭据脱敏，导出前仍建议由运维人员复核。',
    };
    writeFileSync(filePath, `${JSON.stringify({ type: 'diagnostic-header', ...header })}\n${entries.slice().reverse().map((entry) => JSON.stringify(entry)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    return { path: filePath, count: entries.length };
  }

  getDirectory(): string {
    return this.directory;
  }

  private currentFile(): string {
    const stem = `app-${localDate()}`;
    let file = join(this.directory, `${stem}.jsonl`);
    if (!existsSync(file) || statSync(file).size < MAX_FILE_BYTES) return file;
    let index = 1;
    do {
      file = join(this.directory, `${stem}-${index}.jsonl`);
      index += 1;
    } while (existsSync(file) && statSync(file).size >= MAX_FILE_BYTES);
    return file;
  }

  private logFiles(): string[] {
    try {
      return readdirSync(this.directory)
        .filter((file) => /^app-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/.test(file))
        .sort((left, right) => right.localeCompare(left));
    } catch {
      return [];
    }
  }

  private removeExpiredFiles(): void {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000;
    for (const file of this.logFiles()) {
      const match = basename(file).match(/^app-(\d{4}-\d{2}-\d{2})/);
      if (!match || new Date(`${match[1]}T00:00:00`).getTime() >= cutoff) continue;
      try { unlinkSync(join(this.directory, file)); } catch { /* best-effort retention */ }
    }
  }
}

export const operationalLog = new OperationalLogService();
