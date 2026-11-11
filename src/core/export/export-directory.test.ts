import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredRecord } from '../storage/types';
import { ApplicationExportDirectory, exportFileName, exportPeriod } from './export-directory';

const rows = (dates = ['2026-10-04', '2026-10-17']): StoredRecord[] => dates.map((date, index) => ({
  systemId: 'oversize-transport', matterId: 'oversize-transport-return', recordKey: String(index),
  data: { xkJdrq: date }, updatedAt: 1, firstSeenAt: 1,
}));
const identity = { businessName: '大件运输许可' };
const directories: string[] = [];
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-export-path-')); directories.push(directory);
  return { directory, manager: new ApplicationExportDirectory(directory) };
};
const writer = async (path: string) => { await writeFile(path, 'fixture', { flag: 'wx' }); return { path, rowCount: 2, createdAt: 1 }; };
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('fixed application export destination', () => {
  it('uses the selected business period, not today or a batch id', () => {
    expect(exportFileName(rows(), { ...identity, startDate: '2026-10-01', endDate: '2026-10-19' }, 'xlsx'))
      .toBe('行政许可-大件运输许可-2026-10-01至2026-10-19.xlsx');
    expect(exportFileName(rows(), identity, 'xlsx')).toBe('行政许可-大件运输许可-2026-10-04至2026-10-17.xlsx');
  });
  it('normalizes business date formats and explicitly marks unknown or partially missing dates', () => {
    expect(exportPeriod(rows(['2026/1/3', '2026年2月4日']), identity)).toBe('2026-01-03至2026-02-04');
    expect(exportPeriod(rows(['2026-02-30', '']), identity)).toBe('时间段未知');
    expect(exportPeriod(rows(['2026-10-04', '']), identity)).toBe('2026-10-04至2026-10-04-部分日期缺失');
    expect(exportPeriod(rows(), { ...identity, startDate: '2026-10-01' })).toBe('2026-10-01至结束日期未知');
    expect(exportPeriod(rows(), { ...identity, startDate: '2026-10-19', endDate: '2026-10-01' })).toBe('时间段无效');
  });
  it('sanitizes business names, blocks path traversal and bounds filename length', () => {
    const name = exportFileName(rows(), { businessName: '../恶意/业务:*?"<>|\\\n' + '测试'.repeat(100) }, 'xlsx');
    expect(name).not.toMatch(/[<>:"/\\|?*\x00-\x1f]/);
    expect(name.startsWith('行政许可-')).toBe(true); expect(name.length).toBeLessThan(140);
  });
  it('keeps all exports in the fixed folder and never overwrites on repeats or concurrent calls', async () => {
    const { directory, manager } = await fixture();
    const results = await Promise.all([manager.export(rows(), identity, 'xlsx', writer), manager.export(rows(), identity, 'xlsx', writer)]);
    expect(new Set(results.map(result => result!.path)).size).toBe(2);
    expect(results.every(result => result!.path.startsWith(directory))).toBe(true);
    expect(results.map(result => basename(result!.path)).some(name => name.endsWith(' (2).xlsx'))).toBe(true);
    for (const result of results) expect(await readFile(result!.path, 'utf8')).toBe('fixture');
  });
  it('allows opening only a successfully exported existing regular file in the fixed folder', async () => {
    const { directory, manager } = await fixture();
    const result = await manager.export(rows(), identity, 'xlsx', writer);
    expect(await manager.folderForExport(result!.path)).toBeTruthy();
    await expect(manager.folderForExport(join(directory, 'unrelated.xlsx'))).rejects.toThrow('本次应用导出');
    await expect(manager.folderForExport('../elsewhere.xlsx')).rejects.toThrow('本次应用导出');
    await expect(manager.folderForExport({ path: result!.path })).rejects.toThrow('本次应用导出');
    await rm(result!.path);
    await expect(manager.folderForExport(result!.path)).rejects.toThrow('移动或删除');
  });
  it('does not authorize a cancelled or failed export', async () => {
    const { directory, manager } = await fixture();
    expect(await manager.export(rows(), identity, 'xlsx', async () => null)).toBeNull();
    const writer = vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(manager.export(rows(), identity, 'xlsx', writer)).rejects.toThrow('安装目录的写入权限');
    await expect(manager.folderForExport(join(directory, exportFileName(rows(), identity, 'xlsx')))).rejects.toThrow('本次应用导出');
  });
  it('refuses a junction as the configured export directory', async () => {
    const { directory } = await fixture(); const target = join(directory, 'target');
    const { mkdir } = await import('node:fs/promises'); await mkdir(target);
    const link = join(directory, '导出文件'); await symlink(target, link, 'junction');
    await expect(new ApplicationExportDirectory(link).export(rows(), identity, 'xlsx', writer)).rejects.toThrow('不能是链接');
  });
});
