import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));

import { AppRuntime } from './runtime';
import { governmentInfoPlugin } from '../plugins/government-info';
import { MemoryLocalRepository } from '../core/storage/memory-repository';
import { buildRecordKey, DefaultLocalSyncEngine } from '../core/sync/engine';
import { supplementCertificateFields } from '../plugins/government-info/certificate-fields';
import { createShenzhenHazardousPlugin } from '../plugins/shenzhen-hazardous-chemicals';
import { NodeSqliteDriver } from '../core/storage/database';
import { SqliteLocalRepository } from '../core/storage/sqlite-repository';
import { SqlitePlatformStore } from '../core/storage/platform-store';
import { TaskEngine } from '../core/tasks/engine';

describe('certificate reflow runtime integration', () => {
  it.each(['snapshot-error', 'cancel-during-write'])('rolls back ledger, record history and snapshot on %s', async failure => {
    const db = new NodeSqliteDriver(':memory:');
    try {
      const repository = new SqliteLocalRepository(db);
      await repository.initialize();
      const store = new SqlitePlatformStore(db);
      const engine = new DefaultLocalSyncEngine(repository);
      const runtime = new AppRuntime();
      const plugin = createShenzhenHazardousPlugin();
      const original = { sourceSerial: 'fixture', xkNr: '原许可内容' };
      const incoming = { ...original, xkNr: '新许可内容' };
      const matter = { ...plugin.matters[0], query: async () => ({ rows: [incoming], total: 1, page: 1, pageSize: 1 }) };
      runtime.plugins.register({ ...plugin, matters: [matter], getSessionState: async () => ({ systemId: plugin.id, status: 'authenticated' }),
        auth: { ...plugin.auth, getSessionForRequest: async () => ({ metadata: {} }) } });
      Object.assign(runtime, { repository, platformStore: store, syncEngine: engine, requireLicense: async () => {} });
      runtime.tasks = new TaskEngine(store);
      await engine.commit(plugin.id, matter.id, await engine.preview(plugin.id, matter.id, matter.uniqueKey, [original]));
      const key = buildRecordKey(original, matter.uniqueKey);
      const priorVersions = await repository.listVersions(plugin.id, matter.id, key);
      const write = store.replaceTaskOutput.bind(store);
      vi.spyOn(store, 'replaceTaskOutput').mockImplementationOnce(async (...args) => {
        await write(...args);
        if (failure === 'snapshot-error') throw new Error('模拟快照写入失败');
        runtime.tasks.cancel(args[0]);
      });
      const task = await runtime.tasks.run('事务测试', ctx => runtime.runOneClickReturn(plugin.id, matter.id, ctx),
        { type: 'data-return', systemId: plugin.id, matterId: matter.id });
      expect(task.status).toBe(failure === 'snapshot-error' ? 'failed' : 'cancelled');
      expect((await repository.find(plugin.id, matter.id, key))?.data).toEqual(original);
      expect(await repository.listVersions(plugin.id, matter.id, key)).toEqual(priorVersions);
      expect((await store.listTaskOutput(task.id)).total).toBe(0);
    } finally { await db.close(); }
  });

  it('uses the same preserved certificate values for the ledger and batch snapshot', async () => {
    const runtime = new AppRuntime();
    const repository = new MemoryLocalRepository();
    const engine = new DefaultLocalSyncEngine(repository);
    const definition = governmentInfoPlugin.matters.find((matter) => matter.id === 'precursor-chemicals-filing-cancellation')!;
    const original = { cityLsh: 'CITY-TEST', sblsh: 'APPLY-TEST', sxmc: definition.name, applyer: '导出主体' };
    const incoming = supplementCertificateFields(original, {}, true);
    const matter = { ...definition, query: vi.fn(async () => ({ rows: [incoming], total: 1, page: 1, pageSize: 1 })) };
    const authState = { status: 'authenticated' as const, systemId: 'government-info' };
    runtime.plugins.register({ ...governmentInfoPlugin, matters: [matter], getSessionState: async () => authState,
      auth: { ...governmentInfoPlugin.auth, getState: async () => authState, login: async () => authState,
        logout: async () => {}, getSessionForRequest: async () => ({ metadata: {} }) } });
    const replaceTaskOutput = vi.fn(async () => {});
    // Isolated in-memory fixtures: do not read the actual license, session or business database.
    Object.assign(runtime, { syncEngine: engine, platformStore: { transaction: (work: () => Promise<unknown>) => work(), replaceTaskOutput }, requireLicense: vi.fn(async () => {}) });
    await engine.commit('government-info', matter.id, await engine.preview('government-info', matter.id, matter.uniqueKey, [
      supplementCertificateFields(original, { zjbh: '00123', zjmc: '原备案证' }),
    ]));
    await runtime.runOneClickReturn('government-info', matter.id, {
      taskId: 'test-batch', signal: new AbortController().signal, report: vi.fn(),
    });
    const key = buildRecordKey(original, matter.uniqueKey);
    const saved = (await repository.find('government-info', matter.id, key))!.data;
    expect(saved).toMatchObject({ certificateNumber: '00123', certificateEnrichment: { status: 'failed' }, fillStatus: '0' });
    expect(replaceTaskOutput).toHaveBeenCalledWith('test-batch', 'government-info', matter.id, [{ recordKey: key, data: saved }]);
    expect(incoming).not.toHaveProperty('certificateNumber');
  });

  it('persists the warning on a completed dated batch and saves only the matching records', async () => {
    const database = new NodeSqliteDriver(':memory:');
    try {
      const repository = new SqliteLocalRepository(database);
      await repository.initialize();
      const store = new SqlitePlatformStore(database);
      const runtime = new AppRuntime();
      const plugin = createShenzhenHazardousPlugin();
      const authState = { status: 'authenticated' as const, systemId: plugin.id };
      const incoming = { sourceSerial: 'test-matched', xkJdrq: '2026-11-16' };
      const matter = { ...plugin.matters[0], query: vi.fn(async () => ({
        rows: [incoming], total: 1, page: 1, pageSize: 1, undatedExcludedCount: 2,
      })) };
      runtime.plugins.register({ ...plugin, matters: [matter], getSessionState: async () => authState,
        auth: { ...plugin.auth, getSessionForRequest: async () => ({ metadata: {} }) } });
      Object.assign(runtime, { syncEngine: new DefaultLocalSyncEngine(repository), platformStore: store, requireLicense: vi.fn(async () => {}) });
      runtime.tasks = new TaskEngine(store);
      const batch = await runtime.tasks.run('危化品日期回流测试', context => runtime.runOneClickReturn(plugin.id, matter.id, context),
        { type: 'data-return', systemId: plugin.id, matterId: matter.id });
      expect(batch.status).toBe('completed');
      expect(batch.result).toMatchObject({ total: 1, undatedExcludedCount: 2 });
      expect((await runtime.tasks.history())[0].progress.message).toContain('另有 2 条许可决定日期无法确认');
      expect((await store.listTaskOutput(batch.id)).rows.map(row => row.data)).toEqual([incoming]);
      expect((await store.listRecords({ systemId: plugin.id, matterId: matter.id })).total).toBe(1);
    } finally { await database.close(); }
  });
});
