import ExcelJS from 'exceljs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { expect, it } from 'vitest';
import { LocalExportService } from './local-export-service';
import { ApplicationExportDirectory } from './export-directory';

it('exports a partial batch with its selected range and skipped-request evidence in a separate sheet', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hrss-partial-export-'));
  try {
    const records = [{ systemId: 'guangdong-hrss', matterId: 'unemployment', recordKey: 'test', firstSeenAt: 1, updatedAt: 1,
      data: { name: '测试人员', applyDate: '2026-11-02' } }];
    const columns = [{ key: 'name', label: '姓名' }, { key: 'applyDate', label: '登记日期' }];
    const file = join(directory, 'partial.xlsx');
    const result = await new LocalExportService().export(file, 'xlsx', records, undefined, columns, undefined,
      { taskId: 'TEST-BATCH', systemId: 'guangdong-hrss', matterId: 'unemployment', businessName: '失业信息', status: 'completed',
        startDate: '2026-11-01', endDate: '2026-11-28', dateBasis: '登记日期', skippedRequests: 2, batchRowCount: 1 });
    expect(result?.completenessWarning).toContain('未完成');
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file);
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['业务列表台账', '批次说明']);
    expect(workbook.worksheets[0].getRow(1).values).toEqual([undefined, '姓名', '登记日期']);
    const note = workbook.getWorksheet('批次说明')!;
    const values: Record<string, unknown> = {};
    note.eachRow(row => { values[String(row.getCell(1).value)] = row.getCell(2).value; });
    expect(values).toMatchObject({ '批次编号': 'TEST-BATCH', '采集完整性': '部分完成 / 待补齐', '所选开始日期': '2026-11-01',
      '所选结束日期': '2026-11-28', '跳过请求次数': 2, '本批次已保存条数': 1, '本次导出条数': 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps a header-only ledger and failure evidence when every request was skipped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hrss-empty-partial-'));
  try {
    const file = join(directory, 'empty.xlsx');
    const result = await new LocalExportService().export(file, 'xlsx', [], undefined, [{ key: 'name', label: '姓名' }], undefined,
      { taskId: 'TEST-EMPTY', systemId: 'guangdong-hrss', status: 'completed', skippedRequests: 1, batchRowCount: 0 });
    expect(result).toMatchObject({ rowCount: 0, completenessWarning: expect.any(String) });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file);
    expect(workbook.worksheets[0].rowCount).toBe(1);
    expect(JSON.stringify(workbook.getWorksheet('批次说明')!.model)).toContain('不代表原系统在所选范围内没有数据');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('does not add metadata sheets or columns to official publicity import templates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'permit-structure-'));
  try {
    const records = [{ systemId: 'oversize-transport', matterId: 'oversize-transport-return', recordKey: 'test', firstSeenAt: 1, updatedAt: 1,
      data: { xkXdrMc: '测试企业', xkXdrLb: '法人及非法人组织', xkFrdb: '测试法人' } }];
    const service = new LocalExportService();
    const beforeFile = join(directory, 'before.xlsx'), afterFile = join(directory, 'after.xlsx');
    await service.export(beforeFile, 'xlsx', records);
    await service.export(afterFile, 'xlsx', records, undefined, undefined, undefined,
      { taskId: 'TEST-PERMIT', systemId: 'oversize-transport', status: 'completed', skippedRequests: 1 });
    const before = new ExcelJS.Workbook(), after = new ExcelJS.Workbook();
    await before.xlsx.readFile(beforeFile); await after.xlsx.readFile(afterFile);
    expect(after.worksheets.map(sheet => [sheet.name, sheet.getSheetValues()])).toEqual(before.worksheets.map(sheet => [sheet.name, sheet.getSheetValues()]));
    expect(after.getWorksheet('批次说明')).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);

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

it('exports Shenzhen cases and their full process snapshots in separate sheets without requiring a process number', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shenzhen-process-export-'));
  try {
    const event = { operator: '操作甲', reviewer: '审批乙', organization: '测试机构', step: '受理环节', action: '受理',
      handledAt: '2026-11-02 09:00:00', receivedAt: '2026-10-01 08:00:00', operatedAt: '2026-11-01 08:30:00',
      reviewedAt: '2026-11-02 09:00:00', completedAt: '2026-11-03 10:00:00', publicityStartedAt: '2026-11-04 11:00:00',
      result: '公示通过', rawResult: '无异议', opinion: '测试意见', stageType: 'shouli', withdrawn: false, sourceRecordId: '', accessToken: 'SECRET' };
    const base = { systemId: 'shenzhen-integrated-services', matterId: 'small-enterprise-social-insurance-subsidy', firstSeenAt: 1, updatedAt: 1 };
    const records = [
      { ...base, recordKey: 'case-1', data: { caseNumber: 'TEST-001', applicationNumber: 'TEST-001', processNumber: '', sourceMatterName: '测试事项',
        subjectName: '测试单位', handlingRecordStatus: 'collected', handlingRecordCount: 2, handlingRecords: [event, { ...event }], accessToken: 'SECRET' } },
      { ...base, recordKey: 'case-2', data: { caseNumber: 'TEST-002', applicationNumber: 'TEST-002', processNumber: 'TEST-FLOW', sourceMatterName: '测试事项',
        subjectName: '保留历史单位', handlingRecordStatus: 'failed', handlingRecordCount: 0, handlingRecords: [event], handlingRecordError: 'SECRET' } },
      { ...base, recordKey: 'case-3', data: { caseNumber: 'TEST-003', applicationNumber: 'TEST-003', processNumber: '', sourceMatterName: '测试事项',
        subjectName: '待补齐单位', handlingRecordStatus: 'failed', handlingRecordCount: 0, handlingRecords: [] } },
    ];
    const columns = [{ key: 'caseNumber', label: '办件编号' }, { key: 'subjectName', label: '申请人 / 单位' },
      { key: 'handlingRecordCount', label: '办理记录数' }, { key: 'handlingRecordStatus', label: '办理过程状态' }];
    const file = join(directory, 'shenzhen.xlsx');
    await new LocalExportService().export(file, 'xlsx', records, undefined, columns);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file);
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['办件列表', '办理记录']);
    const cases = workbook.getWorksheet('办件列表')!, history = workbook.getWorksheet('办理记录')!;
    expect(cases.rowCount).toBe(4); expect(history.rowCount).toBe(4);
    expect(cases.getRow(3).getCell(3).value).toBe('1（上次）'); expect(cases.getRow(3).getCell(4).value).toBe('办理过程待补齐');
    expect(cases.getRow(4).getCell(3).value).toBe('待补齐');
    const headers = history.getRow(1).values as unknown[];
    const cell = (row: number, label: string) => history.getRow(row).getCell(headers.indexOf(label)).value;
    expect(cell(2, '办件编号')).toBe('TEST-001'); expect(cell(2, '业务流水号')).toBe('');
    expect(cell(2, '操作人')).toBe('操作甲'); expect(cell(2, '审批人')).toBe('审批乙');
    for (const [label, value] of Object.entries({ '环节接收时间': event.receivedAt, '操作时间': event.operatedAt, '审批时间': event.reviewedAt,
      '完成时间': event.completedAt, '公示开始时间': event.publicityStartedAt, '原始办理结果': '无异议', '环节类型代码': 'shouli' })) expect(cell(2, label)).toBe(value);
    expect(cell(4, '过程采集状态')).toBe('待补齐（保留上次记录）');
    expect(JSON.stringify(workbook.model)).not.toContain('SECRET');
    const jsonFile = join(directory, 'shenzhen.json'); await new LocalExportService().export(jsonFile, 'json', records, undefined, columns);
    const exported = JSON.parse(await readFile(jsonFile, 'utf8'));
    expect(exported[0].handlingRecords).toHaveLength(2); expect(exported[0].handlingRecords[0].reviewer).toBe('审批乙');
    expect(JSON.stringify(exported)).not.toContain('SECRET');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
