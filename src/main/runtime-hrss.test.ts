import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));
import { AppRuntime } from './runtime';
import { createGuangdongHrssPlugin } from '../plugins/guangdong-hrss';
import { NodeSqliteDriver } from '../core/storage/database';
import { SqliteLocalRepository } from '../core/storage/sqlite-repository';
import { SqlitePlatformStore } from '../core/storage/platform-store';
import { DefaultLocalSyncEngine, buildRecordKey } from '../core/sync/engine';
import { TaskEngine, type TaskContext, type TaskProgress } from '../core/tasks/engine';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ApplicationExportDirectory } from '../core/export/export-directory';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

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
  const directContext = async (taskId: string, signal = new AbortController().signal, onProgress?: (progress: TaskProgress) => void): Promise<TaskContext> => {
    await store.save({ id: taskId, type: 'data-return', name: '串行回流测试', systemId, matterId,
      status: 'running', progress: { current: 0 }, createdAt: Date.now() });
    return { taskId, signal, report: onProgress ?? vi.fn() };
  };

  it('queues overlapping HRSS returns until the preceding query and commit both finish', async () => {
    const queryEntered = deferred<void>(), releaseQuery = deferred<void>(), commitEntered = deferred<void>(), releaseCommit = deferred<void>(), waiting = deferred<void>();
    const firstContext = await directContext('hrss-first'), nextContext = await directContext('hrss-next', undefined,
      progress => { if (progress.message?.includes('等待前一人社任务')) waiting.resolve(undefined); });
    const order: string[] = [];
    query.mockImplementationOnce(async () => { order.push('query-first'); queryEntered.resolve(undefined); await releaseQuery.promise;
      return { rows, page: 1, pageSize: 200, total: rows.length }; });
    query.mockImplementationOnce(async () => { order.push('query-next'); return { rows, page: 1, pageSize: 200, total: rows.length }; });
    const original = store.replaceTaskOutput.bind(store);
    vi.spyOn(store, 'replaceTaskOutput').mockImplementationOnce(async (...args) => {
      commitEntered.resolve(undefined); await releaseCommit.promise; await original(...args); order.push('commit-first');
    });
    const first = runtime.runOneClickReturn(systemId, matterId, firstContext);
    await queryEntered.promise;
    const next = runtime.runOneClickReturn(systemId, matterId, nextContext);
    await waiting.promise;
    expect(query).toHaveBeenCalledTimes(1);
    releaseQuery.resolve(undefined); await commitEntered.promise;
    expect(query).toHaveBeenCalledTimes(1);
    releaseCommit.resolve(undefined); await Promise.all([first, next]);
    expect(order).toEqual(['query-first', 'commit-first', 'query-next']);
    expect((await store.listTaskOutput(nextContext.taskId)).total).toBe(1);
  });

  it('cancels a waiting HRSS return without querying or blocking the following queued return', async () => {
    const queryEntered = deferred<void>(), release = deferred<void>(), middleWaiting = deferred<void>(), lastWaiting = deferred<void>();
    const cancelled = new AbortController();
    const firstContext = await directContext('queue-first');
    const middleContext = await directContext('queue-cancelled', cancelled.signal,
      progress => { if (progress.message?.includes('等待前一人社任务')) middleWaiting.resolve(undefined); });
    const lastContext = await directContext('queue-last', undefined,
      progress => { if (progress.message?.includes('等待前一人社任务')) lastWaiting.resolve(undefined); });
    query.mockImplementationOnce(async () => { queryEntered.resolve(undefined); await release.promise; return { rows, page: 1, pageSize: 200, total: rows.length }; });
    const first = runtime.runOneClickReturn(systemId, matterId, firstContext);
    await queryEntered.promise;
    const middle = runtime.runOneClickReturn(systemId, matterId, middleContext);
    await middleWaiting.promise;
    const last = runtime.runOneClickReturn(systemId, matterId, lastContext);
    await lastWaiting.promise;
    const rejected = expect(middle).rejects.toThrow('任务已取消');
    cancelled.abort(); await rejected;
    expect(query).toHaveBeenCalledTimes(1);
    release.resolve(undefined); await Promise.all([first, last]);
    expect(query).toHaveBeenCalledTimes(2);
    expect((await store.listTaskOutput(middleContext.taskId)).total).toBe(0);
    expect((await store.listTaskOutput(lastContext.taskId)).total).toBe(1);
  });

  it('releases the HRSS queue when the active query fails', async () => {
    const queryEntered = deferred<void>(), failed = deferred<void>(), waiting = deferred<void>();
    const firstContext = await directContext('failed-first'), nextContext = await directContext('after-failed', undefined,
      progress => { if (progress.message?.includes('等待前一人社任务')) waiting.resolve(undefined); });
    query.mockImplementationOnce(async () => { queryEntered.resolve(undefined); await failed.promise; return { rows, page: 1, pageSize: 200, total: rows.length }; });
    const first = runtime.runOneClickReturn(systemId, matterId, firstContext);
    const firstError = expect(first).rejects.toThrow('源站请求失败');
    await queryEntered.promise;
    const next = runtime.runOneClickReturn(systemId, matterId, nextContext);
    await waiting.promise;
    failed.reject(new Error('源站请求失败')); await firstError; await next;
    expect(query).toHaveBeenCalledTimes(2);
    expect((await store.listTaskOutput(firstContext.taskId)).total).toBe(0);
    expect((await store.listTaskOutput(nextContext.taskId)).total).toBe(1);
  });

  it('rechecks authorization after waiting and does not query a revoked queued return', async () => {
    const queryEntered = deferred<void>(), release = deferred<void>(), waiting = deferred<void>();
    const firstContext = await directContext('before-revoke'), nextContext = await directContext('revoked-waiter', undefined,
      progress => { if (progress.message?.includes('等待前一人社任务')) waiting.resolve(undefined); });
    query.mockImplementationOnce(async () => { queryEntered.resolve(undefined); await release.promise; return { rows, page: 1, pageSize: 200, total: rows.length }; });
    const first = runtime.runOneClickReturn(systemId, matterId, firstContext);
    const firstRejected = expect(first).rejects.toThrow('LICENSE_MATTER_DENIED');
    await queryEntered.promise;
    const next = runtime.runOneClickReturn(systemId, matterId, nextContext);
    const nextRejected = expect(next).rejects.toThrow('LICENSE_MATTER_DENIED');
    await waiting.promise;
    const grant = (await runtime.currentGrant())!;
    vi.mocked(runtime.currentGrant).mockResolvedValue({ ...grant, allowedMatters: { [systemId]: [] } });
    release.resolve(undefined); await firstRejected; await nextRejected;
    expect(query).toHaveBeenCalledTimes(1);
    vi.mocked(runtime.currentGrant).mockResolvedValue(grant);
    const laterContext = await directContext('re-authorized');
    await runtime.runOneClickReturn(systemId, matterId, laterContext);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not put a different business system behind the HRSS return queue', async () => {
    const entered = deferred<void>(), release = deferred<void>();
    const firstContext = await directContext('hrss-in-progress'), otherContext = await directContext('independent-system');
    const otherSystem = 'independent-system', otherQuery = vi.fn(async () => ({ rows: [{ recordKey: 'other-record' }], page: 1, pageSize: 200, total: 1 }));
    const plugin = runtime.plugins.get(systemId)!;
    runtime.plugins.register({ ...plugin, id: otherSystem, name: '其他系统',
      getSessionState: async () => ({ systemId: otherSystem, status: 'authenticated' }),
      matters: [{ ...plugin.matters[0], query: otherQuery }] });
    const grant = (await runtime.currentGrant())!;
    vi.mocked(runtime.currentGrant).mockResolvedValue({ ...grant, allowedSystems: [systemId, otherSystem],
      allowedMatters: { [systemId]: [matterId], [otherSystem]: [matterId] } });
    enterprise.mockImplementation(async (_systemId, _matterId, incoming) => incoming);
    query.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; return { rows, page: 1, pageSize: 200, total: rows.length }; });
    const first = runtime.runOneClickReturn(systemId, matterId, firstContext);
    await entered.promise;
    const other = await runtime.runOneClickReturn(otherSystem, matterId, otherContext);
    expect(other.total).toBe(1); expect(otherQuery).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(1);
    release.resolve(undefined); await first;
  });

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
      await database.run(`WITH RECURSIVE nums(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM nums WHERE n<1100)
        INSERT INTO runtime_tasks(id,type,name,system_id,matter_id,status,progress_json,created_at)
        SELECT 'new-'||n,'data-return','列表回流',?,CASE WHEN n<=55 THEN ? ELSE 'other-matter' END,
               'completed','{"current":1}',n+10 FROM nums`, [systemId, matterId]);
      const page = await runtime.taskPage({ systemId, matterId, completedBatches: true, page: 2, pageSize: 50 });
      expect(page.total).toBe(56); expect(page.rows).toHaveLength(6);
      expect(page.rows.at(-1)?.id).toBe(task.id);
      expect((await runtime.taskPage({ taskId: 'new-1100' })).rows).toEqual([]);
      expect((await runtime.listTaskOutput(task.id)).total).toBe(1);
      const result = await runtime.exportTaskOutput(task.id);
      expect(basename(result!.path)).toBe('业务台账-失业信息-2026-11-04至2026-11-04.xlsx');
      expect(enterprise).not.toHaveBeenCalled();
      const grant = (await runtime.currentGrant())!;
      vi.mocked(runtime.currentGrant).mockResolvedValue({ ...grant, allowedMatters: { [systemId]: [] } });
      expect(await runtime.taskPage({})).toEqual({ rows: [], total: 0 });
      await expect(runtime.listTaskOutput(task.id)).rejects.toThrow('LICENSE_MATTER_DENIED');
      await expect(runtime.exportTaskOutput(task.id)).rejects.toThrow('LICENSE_MATTER_DENIED');
      vi.mocked(runtime.currentGrant).mockResolvedValue({ ...grant, allowedMatters: undefined });
      expect((await runtime.taskPage({})).total).toBe(1101);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('checks the active task owner and the current matter grant before cancelling', async () => {
    const active = { id: 'active-task', type: 'data-return', name: '任务', status: 'running' as const, systemId,
      matterId: 'other-matter', progress: { current: 0 }, createdAt: 1 };
    const owner = vi.spyOn(runtime.tasks, 'get').mockReturnValue(active);
    const cancel = vi.spyOn(runtime.tasks, 'cancel').mockReturnValue(true);
    await expect(runtime.cancelTask(active.id)).rejects.toThrow('LICENSE_MATTER_DENIED');
    expect(cancel).not.toHaveBeenCalled();
    owner.mockReturnValue({ ...active, matterId });
    expect(await runtime.cancelTask(active.id)).toBe(true);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(active.id);
    owner.mockReturnValue(undefined);
    expect(await runtime.cancelTask('missing')).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
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

  it('persists timeout skip warnings and partial rows without replacing the last complete dashboard snapshot', async () => {
    await execute();
    query.mockImplementationOnce(async (context) => {
      context.onProgress?.({ current: 2, total: 2, message: '已结束，部分请求超时跳过' });
      return { rows: [{ ...rows[0], employmentStatus: '已就业' }, { recordKey: 'partial-new', employmentStatus: '失业' }],
        page: 1, pageSize: 200, total: 2, skippedRequestCount: 2 };
    });
    const partial = await execute();
    expect(partial.status).toBe('completed');
    expect(partial.result).toMatchObject({ total: 2, skippedRequests: 2, partial: true });
    expect(partial.progress).toMatchObject({ skippedRequests: 2, message: expect.stringContaining('结果含缺项') });
    expect((await store.listTaskOutput(partial.id)).total).toBe(2);
    expect((await store.listRecords({ systemId, matterId })).total).toBe(2);
    // Warnings must survive a task-engine restart; result is intentionally not stored by TaskStore.
    runtime.tasks = new TaskEngine(store);
    expect((await runtime.tasks.history()).find(task => task.id === partial.id)?.progress).toMatchObject({ skippedRequests: 2 });
    const dashboard = await runtime.hrssDashboard();
    expect(dashboard.totalRecords).toBe(1);
    expect(dashboard.matters[0]).toMatchObject({ latestSkippedRequests: 2, latestTaskStatus: 'completed', syncState: 'synced' });
  });

  it('does not turn a timeout-only empty batch into a confirmed zero, while a later real empty still becomes zero', async () => {
    query.mockResolvedValueOnce({ rows: [], page: 1, pageSize: 200, total: 0, skippedRequestCount: 1 });
    const skipped = await execute();
    expect((await store.getTask(skipped.id))?.progress.skippedRequests).toBe(1);
    expect(await runtime.hrssDashboard()).toMatchObject({ totalRecords: null, syncState: 'not-synced' });
    await execute();
    expect((await runtime.hrssDashboard()).totalRecords).toBe(1);
    query.mockResolvedValueOnce({ rows: [], page: 1, pageSize: 200, total: 0, skippedRequestCount: 1 });
    await execute();
    expect((await runtime.hrssDashboard()).totalRecords).toBe(1);
    rows = [];
    await execute();
    expect(await runtime.hrssDashboard()).toMatchObject({ totalRecords: 0, syncState: 'synced' });
    expect((await runtime.hrssDashboard()).matters[0].latestSkippedRequests).toBeUndefined();
  });

  it('keeps the query completion counts in the final persisted task message', async () => {
    query.mockImplementationOnce(async (context) => {
      context.onProgress?.({ current: 1, total: 1, message: '失业信息：共 1 条（实际获取 2 条，合并重复 1 条）' });
      return { rows, page: 1, pageSize: 200, total: 1 };
    });
    const task = await execute();
    expect((await store.getTask(task.id))?.progress.message).toContain('实际获取 2 条，合并重复 1 条');
  });

  it('uses local ledger rows until an authorized matter has a completed batch', async () => {
    await repository.upsert({ systemId, matterId, recordKey: 'older-ledger-entry', data: { employmentStatus: '失业' }, firstSeenAt: 1, updatedAt: 1 });
    const initial = await runtime.hrssDashboard();
    expect(initial).toMatchObject({ totalRecords: 1, syncState: 'local-only', syncedMatterCount: 0 });
    query.mockRejectedValueOnce(new Error('回流失败'));
    await execute();
    expect((await runtime.hrssDashboard()).totalRecords).toBe(1);
    rows = [];
    await execute();
    expect(await runtime.hrssDashboard()).toMatchObject({ totalRecords: 0, syncState: 'synced', syncedMatterCount: 1 });
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
