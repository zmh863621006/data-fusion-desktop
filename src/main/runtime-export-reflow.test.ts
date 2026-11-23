import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));
import { AppRuntime } from './runtime';
import { oversizeTransportPlugin } from '../plugins/oversize-transport';
import { onlineCarPermitPlugin } from '../plugins/online-car-permit';
import { ApplicationExportDirectory } from '../core/export/export-directory';
import { PERMIT_FIRST_DATA_ROW, PERMIT_SHEET_NAME } from '../core/double-publicity/permit-workbook';
import { EnterpriseEnrichmentService } from '../core/enterprise/service';
import { MemoryLocalRepository } from '../core/storage/memory-repository';
import { buildRecordKey, DefaultLocalSyncEngine } from '../core/sync/engine';
import { queryOversizeTransport } from '../plugins/oversize-transport/query';
import { governmentInfoPlugin } from '../plugins/government-info';
import { createSpecialEquipmentPlugin } from '../plugins/guangdong-special-equipment';
import { createFoodDrugPlugin } from '../plugins/guangdong-food-drug';
import ExcelJS from 'exceljs';

const creditCode = '91440300123456789Q';
const canonical = { xzxkmc: '许可事项', xkWsh: 'TEST-001', xkJdrq: '2026-10-06', xkXkjg: '测试机关',
  xkXdrMc: '测试企业', xkXdrLb: '法人及非法人组织', xkXdrShxym: '', xkFrdb: '' };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('reflow enterprise completion and managed export integration', () => {
  it('persists the matched source application code and waits for code-based legal-person completion', async () => {
    const runtime = new AppRuntime(), repository = new MemoryLocalRepository(), engine = new DefaultLocalSyncEngine(repository);
    const plugin = oversizeTransportPlugin, matter = plugin.matters[0], order: string[] = [];
    const reqNo = 'B4413002026101260031';
    const source = {
      fetchIssuedList: async () => { order.push('certificates'); return [{ id: 'cert-1', reqNo, transportName: '测试企业',
        handerTime: '2026-10-06', startTime: '2026-10-06', endTime: '2026-12-31', roadLine: '测试路线' }]; },
      fetchApplicationRecords: async (number: string) => { expect(number).toBe(reqNo); order.push('application');
        return [{ id: 'app-1', reqNo, transportName: '测试企业', transportCreditCode: creditCode }]; },
    };
    const fetcher = vi.fn(async (_url, init) => {
      order.push('enterprise'); const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ systemId: plugin.id, items: [{ name: '测试企业', creditCode, applicantCode: '' }] });
      return Response.json({ results: [{ requestId: 'request-code', status: 'success', reason: '',
        enterprise: { id: 'enterprise-code', name: '测试企业', creditCode, legalPerson: '代码匹配法人', source: 'aliyun-code', updatedAt: 1 } }] });
    });
    runtime.plugins.register({ ...plugin, matters: [{ ...matter, query: context => queryOversizeTransport(source, context) }],
      getSessionState: async () => ({ systemId: plugin.id, status: 'authenticated' }), auth: { ...plugin.auth, getSessionForRequest: async () => ({ metadata: {} }) } });
    Object.assign(runtime, { repository, syncEngine: engine, requireLicense: vi.fn(async () => {}),
      platformStore: { transaction: (work: () => Promise<unknown>) => work(), replaceTaskOutput: async (_task: string, _system: string, _matter: string, rows: Array<{ data: Record<string, unknown> }>) => {
        order.push('save'); expect(rows[0].data).toMatchObject({ xkXdrShxym: creditCode, xkFrdb: '代码匹配法人',
          oversizeApplicationEnrichment: { applicationId: 'app-1', status: 'matched' }, enterpriseEnrichment: { enterprise: { source: 'aliyun-code' } } });
      } }, enterpriseService: new EnterpriseEnrichmentService('https://backend.test/api/enterprises/resolve', async () => ({
        proof: { payload: 'test', signature: 'test', algorithm: 'RSA-SHA256' }, deviceId: 'fixture',
      }), fetcher),
    });
    await runtime.runOneClickReturn(plugin.id, matter.id, { taskId: 'source-chain', signal: new AbortController().signal, report: vi.fn() },
      { page: 1, pageSize: 10, filters: { startDate: '2026-10-01', endDate: '2026-10-10' } });
    expect(order).toEqual(['certificates','application','enterprise','save']);
  });

  it.each([oversizeTransportPlugin, onlineCarPermitPlugin])('$id fills missing enterprise fields BEFORE ledger and batch writes', async plugin => {
    const runtime = new AppRuntime(), repository = new MemoryLocalRepository(), engine = new DefaultLocalSyncEngine(repository);
    const state = { status: 'authenticated' as const, systemId: plugin.id };
    const order: string[] = [];
    const fetcher = vi.fn(async () => {
      order.push('enterprise');
      expect(await repository.find(plugin.id, plugin.matters[0].id, buildRecordKey(canonical, plugin.matters[0].uniqueKey))).toBeNull();
      return Response.json({ results: [{ requestId: 'test-request', status: 'success', reason: '',
        enterprise: { id: 'test-enterprise', name: '测试企业', legalPerson: '测试法人', creditCode, source: 'aliyun-name', updatedAt: 1 } }] });
    });
    const service = new EnterpriseEnrichmentService('https://backend.test/api/enterprises/resolve', async () => ({
      proof: { payload: 'test', signature: 'test', algorithm: 'RSA-SHA256' }, deviceId: 'fixture',
    }), fetcher);
    const matter = { ...plugin.matters[0], query: vi.fn(async () => { order.push('query'); return { rows: [{ ...canonical }], total: 1, page: 1, pageSize: 1 }; }) };
    runtime.plugins.register({ ...plugin, matters: [matter], getSessionState: async () => state,
      auth: { ...plugin.auth, getSessionForRequest: async () => ({ metadata: {} }) } });
    const replaceTaskOutput = vi.fn(async (_task: string, _system: string, _matter: string, rows: Array<{ data: Record<string, unknown> }>) => {
      order.push('batch'); expect(rows[0].data).toMatchObject({ xkFrdb: '测试法人', xkXdrShxym: creditCode });
    });
    Object.assign(runtime, { repository, syncEngine: engine, platformStore: { transaction: (work: () => Promise<unknown>) => work(), replaceTaskOutput }, enterpriseService: service, requireLicense: vi.fn(async () => {}) });
    await runtime.runOneClickReturn(plugin.id, matter.id, { taskId: 'fixture-batch', signal: new AbortController().signal, report: vi.fn() });
    expect(order).toEqual(['query', 'enterprise', 'batch']);
    const saved = await repository.find(plugin.id, matter.id, buildRecordKey(canonical, matter.uniqueKey));
    expect(saved?.data).toMatchObject({ xkFrdb: '测试法人', xkXdrShxym: creditCode, enterpriseEnrichment: { requestId: 'test-request' } });
    expect(canonical.xkFrdb).toBe('');
  });

  it.each([oversizeTransportPlugin, onlineCarPermitPlugin])('$id reuses already complete local fields with ZERO backend requests', async plugin => {
    const runtime = new AppRuntime(), repository = new MemoryLocalRepository(), engine = new DefaultLocalSyncEngine(repository);
    const state = { status: 'authenticated' as const, systemId: plugin.id }, matter = plugin.matters[0];
    const complete = { ...canonical, xkFrdb: '本地已核实法人', xkXdrShxym: creditCode };
    await engine.commit(plugin.id, matter.id, await engine.preview(plugin.id, matter.id, matter.uniqueKey, [complete]));
    const fetcher = vi.fn(), authorization = vi.fn();
    const service = new EnterpriseEnrichmentService('https://backend.test/api/enterprises/resolve', authorization, fetcher);
    runtime.plugins.register({ ...plugin, matters: [{ ...matter, query: async () => ({ rows: [{ ...canonical }], total: 1, page: 1, pageSize: 1 }) }],
      getSessionState: async () => state, auth: { ...plugin.auth, getSessionForRequest: async () => ({ metadata: {} }) } });
    const replaceTaskOutput = vi.fn();
    Object.assign(runtime, { repository, syncEngine: engine, platformStore: { transaction: (work: () => Promise<unknown>) => work(), replaceTaskOutput }, enterpriseService: service, requireLicense: vi.fn(async () => {}) });
    await runtime.runOneClickReturn(plugin.id, matter.id, { taskId: 'fixture-repeat', signal: new AbortController().signal, report: vi.fn() });
    expect(fetcher).not.toHaveBeenCalled(); expect(authorization).not.toHaveBeenCalled();
    expect((await repository.find(plugin.id, matter.id, buildRecordKey(canonical, matter.uniqueKey)))?.data).toMatchObject(complete);
    expect(replaceTaskOutput.mock.calls[0][3][0].data.xkFrdb).toBe('本地已核实法人');
  });

  it('exports a real task period under the app folder, and opens only the completed export folder', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fusion-runtime-export-')); directories.push(directory);
    const runtime = new AppRuntime(); runtime.plugins.register(oversizeTransportPlugin);
    const task = { id: 'batch-test', type: 'data-return', systemId: 'oversize-transport', matterId: 'oversize-transport-return',
      createdAt: 1, details: { startDate: '2026-10-01', endDate: '2026-10-19' } };
    Object.assign(runtime, { exportDirectory: new ApplicationExportDirectory(directory),
      currentGrant: vi.fn(async () => ({ allowExport: true })), requireLicense: vi.fn(async () => {}),
      platformStore: { getTask: async () => task, taskRowsForExport: async () => [
        { systemId: task.systemId, matterId: task.matterId, recordKey: 'test', data: canonical },
      ] },
    });
    const result = await runtime.exportTaskOutput(task.id, undefined, undefined, async () => true);
    expect(basename(result!.path)).toBe('行政许可-大件运输许可-2026-10-01至2026-10-19.xlsx');
    expect((await readFile(result!.path)).subarray(0, 2).toString()).toBe('PK');
    expect(await runtime.exportFolder(result!.path)).toBeTruthy();
    const repeat = await runtime.exportTaskOutput(task.id, undefined, undefined, async () => true);
    expect(basename(repeat!.path)).toBe('行政许可-大件运输许可-2026-10-01至2026-10-19 (2).xlsx');
  });

  it('merged ledger export uses actual decision dates rather than export day', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fusion-ledger-export-')); directories.push(directory);
    const runtime = new AppRuntime(); runtime.plugins.register(onlineCarPermitPlugin);
    const record = { systemId: 'online-car-permit', matterId: 'online-car-permit-return', recordKey: 'test',
      data: canonical, firstSeenAt: 1, updatedAt: 1 };
    Object.assign(runtime, { exportDirectory: new ApplicationExportDirectory(directory),
      currentGrant: vi.fn(async () => ({ allowExport: true })), requireLicense: vi.fn(async () => {}),
      platformStore: { recordsForExport: async () => [record] },
    });
    const result = await runtime.exportLocalRecords({ systemId: record.systemId, matterId: record.matterId }, undefined, 'xlsx', async () => true);
    expect(basename(result!.path)).toBe('行政许可-网约车车证-2026-10-06至2026-10-06.xlsx');
  });
  it.each(['guangdong-law', 'nanshan'] as const)('exports government %s for the exact batch or ledger with distinct names, original filters and export permissions', async target => {
    const directory = await mkdtemp(join(tmpdir(), 'fusion-government-export-')); directories.push(directory);
    const runtime = new AppRuntime(); runtime.plugins.register(governmentInfoPlugin);
    const record = { systemId: 'government-info', matterId: 'drainage-permit-new', recordKey: 'test',
      data: { ...canonical, ajmc: '原案件', xkCljg: '予以许可', xkZqly: '依职权', xkXkzs: '原证书', xkXklb: '普通', xkNr: '原内容' }, firstSeenAt: 1, updatedAt: 1 };
    const task = { id: 'government-batch', type: 'data-return', systemId: record.systemId, matterId: record.matterId,
      createdAt: 1, details: { startDate: '2026-10-01', endDate: '2026-10-19' } };
    const taskRowsForExport = vi.fn(async () => [record]);
    const recordsForExport = vi.fn(async () => [record]);
    const requireLicense = vi.fn(async () => {});
    Object.assign(runtime, { exportDirectory: new ApplicationExportDirectory(directory),
      currentGrant: vi.fn(async () => ({ allowExport: true })), requireLicense,
      platformStore: { getTask: async () => task, taskRowsForExport, recordsForExport },
    });
    const label = target === 'guangdong-law' ? '省执法双公示' : '南山双公示';
    const batch = await runtime.exportTaskOutput(task.id, undefined, '原关键字', async () => true, target);
    expect(basename(batch!.path)).toBe(`行政许可-${label}-污水排入排水管网许可证核发（新办）-2026-10-01至2026-10-19.xlsx`);
    expect(taskRowsForExport).toHaveBeenCalledWith(task.id, '原关键字');
    expect(requireLicense).toHaveBeenCalledWith(record.systemId, record.matterId);
    expect(await runtime.exportFolder(batch!.path)).toBeTruthy();
    const book = await new ExcelJS.Workbook().xlsx.readFile(batch!.path, { ignoreNodes: ['dataValidations'] });
    expect(book.worksheets[0].columnCount).toBe(target === 'guangdong-law' ? 24 : 31);
    expect(book.worksheets).toHaveLength(target === 'guangdong-law' ? 1 : 2);
    const ledger = await runtime.exportLocalRecords({ systemId: record.systemId, matterId: record.matterId, keyword: '原关键字' }, undefined, 'xlsx', async () => true, target);
    expect(basename(ledger!.path)).toBe(`行政许可-${label}-污水排入排水管网许可证核发（新办）-2026-10-06至2026-10-06.xlsx`);
    expect(recordsForExport).toHaveBeenCalledWith(expect.objectContaining({ keyword: '原关键字', matterId: record.matterId }));
    await expect(runtime.exportLocalRecords({ systemId: 'oversize-transport' }, undefined, 'xlsx', undefined, target)).rejects.toThrow('仅支持政务');
    Object.assign(runtime, { currentGrant: vi.fn(async () => ({ allowExport: false })) });
    await expect(runtime.exportTaskOutput(task.id, undefined, undefined, undefined, target)).rejects.toThrow();
  });

  it.each([createSpecialEquipmentPlugin(), createFoodDrugPlugin()])('$id exports both collection templates from an existing batch', async plugin => {
    const directory = await mkdtemp(join(tmpdir(), 'fusion-collection-export-')); directories.push(directory);
    const runtime = new AppRuntime();
    runtime.plugins.register(plugin);
    const matter = plugin.matters[0];
    const record = { systemId: plugin.id, matterId: matter.id, recordKey: 'existing-record',
      data: { ...canonical, xkXdrShxym: creditCode, xkFrdb: '测试法人', xkXkbh: '00008', xkXkws: '决定书',
        xkXklb: '普通', xkNr: '测试许可内容', xkYxqz: '2026-10-06', xkYxqzi: '2027-10-06',
        xkXkjgdm: '测试机关代码', xkZt: '1', xkLydw: '测试来源单位', xkLydwdm: '测试来源单位代码' }, firstSeenAt: 1, updatedAt: 1 };
    const task = { id: 'existing-batch', type: 'data-return', systemId: record.systemId, matterId: record.matterId,
      createdAt: 1, details: { startDate: '2026-10-01', endDate: '2026-10-19' } };
    const taskRowsForExport = vi.fn(async () => [record]);
    const requireLicense = vi.fn(async () => {});
    Object.assign(runtime, { exportDirectory: new ApplicationExportDirectory(directory),
      currentGrant: vi.fn(async () => ({ allowExport: true })), requireLicense,
      platformStore: { getTask: async () => task, taskRowsForExport },
    });
    const confirm = vi.fn(async () => false);
    for (const [target, label, sheetName, permitCell] of [
      ['collection-disclosure', '双公示', PERMIT_SHEET_NAME, 'T' + PERMIT_FIRST_DATA_ROW],
      ['collection-judicial', '司法公示', '行政许可案件导入模板', 'N5'],
    ] as const) {
      const result = await runtime.exportTaskOutput(task.id, undefined, '原筛选值', confirm, target);
      expect(result).toMatchObject({ rowCount: 1, warningCount: 0 });
      expect(basename(result!.path)).toBe(['行政许可', label, matter.name, '2026-10-01至2026-10-19.xlsx'].join('-'));
      const book = await new ExcelJS.Workbook().xlsx.readFile(result!.path, { ignoreNodes: ['dataValidations'] });
      expect(book.getWorksheet(sheetName)?.getCell(permitCell).value).toBe('00008');
    }
    expect(taskRowsForExport).toHaveBeenCalledTimes(2);
    expect(taskRowsForExport).toHaveBeenCalledWith(task.id, '原筛选值');
    expect(requireLicense).toHaveBeenCalledWith(plugin.id, matter.id);
    expect(confirm).not.toHaveBeenCalled();
    await expect(runtime.exportTaskOutput(task.id, undefined, undefined, confirm, 'guangdong-law')).rejects.toThrow('仅支持政务');
    expect(taskRowsForExport).toHaveBeenCalledTimes(2);
  });
});
