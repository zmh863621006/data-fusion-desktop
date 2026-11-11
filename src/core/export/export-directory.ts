import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { StoredRecord } from '../storage/types';
import type { ExportFormat, ExportResult } from './types';

export interface ExportIdentity {
  businessName: string;
  kind?: 'list-ledger';
  startDate?: unknown;
  endDate?: unknown;
}

/** Accept business dates only, never substitute the export timestamp. */
function dateText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日|(?:[ T].*)?)$/.exec(value.trim());
  if (!match) return undefined;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return undefined;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

export function exportPeriod(records: StoredRecord[], identity: ExportIdentity): string {
  const start = dateText(identity.startDate), end = dateText(identity.endDate);
  if (start && end && start <= end) return `${start}至${end}`;
  if (start && end) return '时间段无效';
  if (start || end) return `${start ?? '开始日期未知'}至${end ?? '结束日期未知'}`;
  const dates = records.map(record => identity.kind === 'list-ledger'
    ? dateText(record.data.applyDate) ?? dateText(record.data.registerDate)
    : dateText(record.data.xkJdrq) ?? dateText(record.data.xkjdrq)).filter((value): value is string => Boolean(value)).sort();
  if (!dates.length) return identity.kind === 'list-ledger' ? '全部列表' : '时间段未知';
  const unknown = dates.length < records.length ? '-部分日期缺失' : '';
  return `${dates[0]}至${dates[dates.length - 1]}${unknown}`;
}

export function exportFileName(records: StoredRecord[], identity: ExportIdentity, format: ExportFormat, maxBusinessLength = 80): string {
  const business = [...identity.businessName.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')]
    .slice(0, Math.max(1, maxBusinessLength)).join('') || '未命名业务';
  return `${identity.kind === 'list-ledger' ? '业务台账' : '行政许可'}-${business}-${exportPeriod(records, identity)}.${format}`;
}

/** Native-only destination. Renderer callers never choose a filesystem path. */
export class ApplicationExportDirectory {
  readonly directory: string;
  private readonly completed = new Set<string>();

  constructor(directory: string) { this.directory = resolve(directory); }

  private async checkedDirectory(): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('导出文件目录不能是链接或普通文件');
    return realpath(this.directory);
  }

  async export(records: StoredRecord[], identity: ExportIdentity, format: ExportFormat,
    writer: (path: string) => Promise<ExportResult | null>): Promise<ExportResult | null> {
    try {
      await this.checkedDirectory();
      const budget = Math.min(80, Math.max(1, 235 - this.directory.length - exportPeriod(records, identity).length - 22));
      const name = exportFileName(records, identity, format, budget);
      const stem = name.slice(0, -(format.length + 1));
      for (let sequence = 1; sequence <= 10_000; sequence++) {
        const path = join(this.directory, sequence === 1 ? name : `${stem} (${sequence}).${format}`);
        try { await lstat(path); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        try {
          const result = await writer(path);
          if (result) this.completed.add(resolve(result.path));
          return result;
        } catch (error) {
          // The writer uses exclusive creation, including across two app instances.
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      throw new Error('同名导出文件过多，请整理导出文件夹后重试');
    } catch (error) {
      if (['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new Error(`无法写入固定导出目录：${this.directory}。请确认应用安装目录的写入权限，或将应用安装到当前用户可写的目录。`);
      }
      throw error;
    }
  }

  async folderForExport(input: unknown): Promise<string> {
    if (typeof input !== 'string' || input.length > 2000 || !isAbsolute(input)
      || !this.completed.has(resolve(input)) || dirname(resolve(input)) !== this.directory
      || !/^(?:行政许可|业务台账)-.+\.(xlsx|csv|json)$/i.test(basename(input))) throw new Error('只能打开本次应用导出文件所在的文件夹');
    const root = await this.checkedDirectory();
    try {
      const info = await lstat(input);
      if (!info.isFile() || info.isSymbolicLink() || dirname(await realpath(input)) !== root) throw new Error('导出文件位置无效');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('导出文件已被移动或删除，请重新导出');
      throw error;
    }
    return root;
  }
}
