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

it('exports street-case history as one row per operation, including operations outside the application-date range', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hrss-history-export-'));
  try {
    const records = [
      { systemId: 'guangdong-hrss', matterId: 'enterprise-hiring-difficult-personnel-subsidy', recordKey: 'case-1', firstSeenAt: 1, updatedAt: 1,
        data: { applyBh: 'TEST-001', unitName: '测试单位', applyDate: '2026-10-01', handlingRecordStatus: 'collected', handlingRecordCount: 2,
          handlingRecords: [
            { operator: '测试甲', organization: '受理部门', handledAt: '2026-10-01 09:00', step: '受理', action: '通过', result: '', opinion: '核验通过', accessToken: 'SECRET' },
            { operator: '测试乙', organization: '审核部门', handledAt: '2026-11-20 10:00', step: '审核', action: '办结', result: '通过', opinion: '后续记录' },
          ] } },
      { systemId: 'guangdong-hrss', matterId: 'startup-training', recordKey: 'case-2', firstSeenAt: 1, updatedAt: 1,
        data: { applyBh: 'TEST-002', unitName: '待受理单位', applyDate: '2026-10-02', handlingRecordStatus: 'skipped-pending', handlingRecordCount: 0, handlingRecords: [] } },
    ];
    const columns = [{ key: 'applyBh', label: '申请编号' }, { key: 'unitName', label: '单位名称' }, { key: 'applyDate', label: '申请日期' },
      { key: 'handlingRecordCount', label: '办理记录数' }, { key: 'handlingRecordStatus', label: '采集状态' }, { key: 'handlingRecords', label: '不得序列化' }];
    const path = join(directory, 'history.xlsx');
    await new LocalExportService().export(path, 'xlsx', records, undefined, columns);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path);
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['业务列表台账', '办理记录']);
    const cases = workbook.getWorksheet('业务列表台账')!, history = workbook.getWorksheet('办理记录')!;
    expect(cases.columnCount).toBe(5); expect(cases.rowCount).toBe(3);
    expect(cases.getRow(3).getCell(4).value).toBe(0);
    expect(cases.getRow(3).getCell(5).value).toBe('待受理，暂无办理记录');
    expect(history.rowCount).toBe(3);
    expect(history.getRow(1).values).toEqual([undefined, '申请编号', '单位名称', '申请日期', '记录序号', '办理人员', '办理机构', '办理时间', '办理环节', '办理操作', '办理结果', '办理意见']);
    expect(history.getRow(3).values).toEqual([undefined, 'TEST-001', '测试单位', '2026-10-01', 2, '测试乙', '审核部门', '2026-11-20 10:00', '审核', '办结', '通过', '后续记录']);
    expect(JSON.stringify(workbook.model)).not.toContain('SECRET');
    expect(JSON.stringify(workbook.model)).not.toContain('[object Object]');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps original matters list-only and creates an empty history sheet for a pending street batch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hrss-pending-export-'));
  try {
    const service = new LocalExportService(), columns = [{ key: 'applyBh', label: '申请编号' }];
    const record = { systemId: 'guangdong-hrss', matterId: 'startup-training', recordKey: 'case-1', firstSeenAt: 1, updatedAt: 1,
      data: { applyBh: 'TEST-001', handlingRecordStatus: 'skipped-pending', handlingRecords: [] } };
    const pendingPath = join(directory, 'pending.xlsx'); await service.export(pendingPath, 'xlsx', [record], undefined, columns);
    const pending = new ExcelJS.Workbook(); await pending.xlsx.readFile(pendingPath);
    expect(pending.getWorksheet('办理记录')?.rowCount).toBe(1);
    const originalPath = join(directory, 'original.xlsx'); await service.export(originalPath, 'xlsx', [{ ...record, matterId: 'unemployment' }], undefined, columns);
    const original = new ExcelJS.Workbook(); await original.xlsx.readFile(originalPath);
    expect(original.worksheets.map(sheet => sheet.name)).toEqual(['业务列表台账']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
