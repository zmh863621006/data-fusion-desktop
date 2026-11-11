import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));
import { AppRuntime } from './runtime';
import { createGuangdongHrssPlugin } from '../plugins/guangdong-hrss';
import { NodeSqliteDriver } from '../core/storage/database';
import { SqliteLocalRepository } from '../core/storage/sqlite-repository';
import { SqlitePlatformStore } from '../core/storage/platform-store';
import { DefaultLocalSyncEngine, buildRecordKey } from '../core/sync/engine';
import { TaskEngine } from '../core/tasks/engine';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ApplicationExportDirectory } from '../core/export/export-directory';

describe('HRSS complete-list transaction and aggregate boundary', () => {
  let database: NodeSqliteDriver, runtime: AppRuntime, store: SqlitePlatformStore, repository: SqliteLocalRepository;
  let rows: Record<string, unknown>[];
  const query = vi.fn(), detail = vi.fn(), enterprise = vi.fn();
  const systemId = 'guangdong-hrss', matterId = 'unemployment';
  beforeEach(async () => {
    vi.clearAllMocks();
    database = new NodeSqliteDriver(':memory:'); repository = new SqliteLocalRepository(database); await repository.initialize();
    store = new SqlitePlatformStore(database); await store.initialize(); runtime = new AppRuntime();
    const plugin = createGuangdongHrssPlugin();
    const matter = { ...plugin.matters.find(matter => matter.id === matterId)!, query, getDetail: detail };
    runtime.plugins.register({ ...plugin, matters: [matter],
      getSessionState: async () => ({ systemId, status: 'authenticated' }),
      auth: { ...plugin.auth, getSessionForRequest: async () => ({ metadata: {} }) } });
    Object.assign(runtime, { repository, platformStore: store, syncEngine: new DefaultLocalSyncEngine(repository),
      enterpriseService: { enrich: enterprise } });
    runtime.tasks = new TaskEngine(store);
    vi.spyOn(runtime, 'currentGrant').mockResolvedValue({ licenseId: 'hrss-test', expiresAt: Date.now() + 60_000,
      allowedSystems: [systemId], allowedMatters: { [systemId]: [matterId] }, allowExport: true });
    rows = [{ recordKey: 'hashed-business-key', name: '示例人员', cardNumber: 'NOT-A-REAL-ID', employmentStatus: '失业' }];
    query.mockImplementation(async () => ({ rows, page: 1, pageSize: 200, total: rows.length }));
  });
  afterEach(async () => { await database.close(); vi.restoreAllMocks(); });
  const execute = async () => runtime.tasks.run('列表回流测试', context => runtime.runOneClickReturn(systemId, matterId, context),
    { type: 'data-return', systemId, matterId });

  it('uses record dates rather than a pending selection when naming a batch export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hrss-pending-period-'));
    try {
      Object.assign(runtime, { exportDirectory: new ApplicationExportDirectory(directory) });
      const task = { id: 'pending-date-export', type: 'data-return', name: '日期未接入的批次', systemId, matterId,
        status: 'completed' as const, progress: { current: 1 }, createdAt: 1, finishedAt: 2,
        details: { dateFilterStatus: 'pending', requestedStartDate: '2030-01-01', requestedEndDate: '2030-01-31',
          startDate: '2030-01-01', endDate: '2030-01-31' } };
      await store.save(task);
      await store.replaceTaskOutput(task.id, systemId, matterId, [{ recordKey: 'a', data: { name: '示例人员', applyDate: '2026-11-04' } }]);
      const result = await runtime.exportTaskOutput(task.id);
      expect(basename(result!.path)).toBe('业务台账-失业信息-2026-11-04至2026-11-04.xlsx');
      expect(enterprise).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('stores each business once, updates status, and never enters detail or enterprise pipelines', async () => {
    expect((await execute()).status).toBe('completed');
    expect((await execute()).result).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    rows = [{ ...rows[0], employmentStatus: '已就业' }];
    expect((await execute()).result).toMatchObject({ inserted: 0, updated: 1 });
    const result = await store.listRecords({ systemId, matterId });
    expect(result.total).toBe(1); expect(result.rows[0].data.employmentStatus).toBe('已就业');
    expect(detail).not.toHaveBeenCalled(); expect(enterprise).not.toHaveBeenCalled();
  });

  it('keeps the last completed dashboard snapshot after a source failure and treats successful empty as zero', async () => {
    await execute();
    query.mockRejectedValueOnce(new Error('分页失败，未保存本次结果'));
    expect((await execute()).status).toBe('failed');
    expect((await runtime.hrssDashboard()).totalRecords).toBe(1);
    rows = [];
    await execute();
    expect((await runtime.hrssDashboard()).totalRecords).toBe(0);
    // The historical merged ledger remains available; the dashboard uses the successful current snapshot.
    expect((await store.listRecords({ systemId, matterId })).total).toBe(1);
  });

  it('rolls back both ledger and batch output when cancellation arrives while saving', async () => {
    await execute();
    rows = [{ ...rows[0], employmentStatus: '已就业' }];
    const original = store.replaceTaskOutput.bind(store);
    vi.spyOn(store, 'replaceTaskOutput').mockImplementationOnce(async (...args) => {
      await original(...args); runtime.tasks.cancel(args[0]);
    });
    const cancelled = await execute();
    expect(cancelled.status).toBe('cancelled');
    expect((await store.listTaskOutput(cancelled.id)).total).toBe(0);
    const key = buildRecordKey(rows[0], ['recordKey']);
    expect((await repository.find(systemId, matterId, key))!.data.employmentStatus).toBe('失业');
    expect((await runtime.hrssDashboard()).totalRecords).toBe(1);
  });

  it('enforces scope in unfiltered local reads and rejects mutations and renderer-supplied synchronization', async () => {
    await execute();
    await repository.upsert({ systemId, matterId: 'not-authorized', recordKey: 'denied', data: { name: '不应返回' }, firstSeenAt: 1, updatedAt: 1 });
    expect((await runtime.listLocalRecords({})).total).toBe(1);
    await expect(runtime.listLocalRecords({ systemId, matterId: 'not-authorized' })).rejects.toThrow('LICENSE_MATTER_DENIED');
    await expect(runtime.updateLocalRecord(systemId, matterId, 'a', {})).rejects.toThrow('只读');
    await expect(runtime.createSyncPreview(systemId, matterId, rows)).rejects.toThrow('列表回流');
    const data = JSON.stringify(await runtime.hrssDashboard());
    expect(data).not.toContain('示例人员'); expect(data).not.toContain('NOT-A-REAL-ID'); expect(data).not.toContain('hashed-business-key');
    vi.mocked(runtime.currentGrant).mockResolvedValue({ licenseId: 'revoked', expiresAt: Date.now() + 60_000, allowedSystems: [] });
    await expect(runtime.hrssDashboard()).rejects.toThrow('LICENSE_SYSTEM_DENIED');
  });
});
