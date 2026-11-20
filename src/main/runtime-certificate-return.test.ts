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
    Object.assign(runtime, { syncEngine: engine, platformStore: { replaceTaskOutput }, requireLicense: vi.fn(async () => {}) });
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
