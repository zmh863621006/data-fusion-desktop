import ExcelJS from 'exceljs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { expect, it } from 'vitest';
import { LocalExportService } from './local-export-service';
import { ApplicationExportDirectory } from './export-directory';

it('exports only declared list columns with Chinese headings and opens the managed ledger folder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hrss-export-'));
  try {
    const service = new LocalExportService(), target = new ApplicationExportDirectory(directory);
    const rows = [{ systemId: 'guangdong-hrss', matterId: 'unemployment', recordKey: 'opaque-id', firstSeenAt: 1, updatedAt: 1,
      data: { name: '测试人员', applyDate: '2026-11-01', cardNumber: 'TEST-CARD', unknownDetail: '应被过滤', accessToken: '不得导出', xkNr: '不得误用双公示' } }];
    const columns = [{ key: 'name', label: '姓名' }, { key: 'applyDate', label: '登记日期' }, { key: 'cardNumber', label: '证件号码' }];
    const result = await target.export(rows, { businessName: '失业信息', kind: 'list-ledger' }, 'xlsx', path => service.export(path, 'xlsx', rows, undefined, columns));
    expect(basename(result!.path)).toBe('业务台账-失业信息-2026-11-01至2026-11-01.xlsx');
    expect(result!.warningCount).toBe(0);
    expect(await target.folderForExport(result!.path)).toBe(await realpath(directory));
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(result!.path);
    const sheet = workbook.worksheets[0];
    expect(sheet.getRow(1).values).toEqual([undefined, '姓名', '登记日期', '证件号码']);
    expect(sheet.getRow(2).values).toEqual([undefined, '测试人员', '2026-11-01', 'TEST-CARD']);
    expect(sheet.rowCount).toBe(2); expect(sheet.getRow(2).getCell(1).fill?.type).toBeUndefined();
    const jsonPath = join(directory, 'ledger.json'); await service.export(jsonPath, 'json', rows, undefined, columns);
    expect(JSON.parse(await readFile(jsonPath, 'utf8'))).toEqual([{ name: '测试人员', applyDate: '2026-11-01', cardNumber: 'TEST-CARD' }]);
    await expect(service.export(join(directory, 'unsafe.xlsx'), 'xlsx', rows)).rejects.toThrow('单独导出');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
