import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));
import { LocalEnrichmentQueue } from './local-enrichment-queue';
import { AppRuntime } from './runtime';
import { NodeSqliteDriver } from '../core/storage/database';
import { SqliteLocalRepository } from '../core/storage/sqlite-repository';
import { SqlitePlatformStore } from '../core/storage/platform-store';
import { DefaultLocalSyncEngine, buildRecordKey } from '../core/sync/engine';
import { onlineCarPermitPlugin } from '../plugins/online-car-permit';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

describe('independent remediation boundary review', () => {
  it('continues work queued between the last drain check and its finally microtask', async () => {
    const queue = new LocalEnrichmentQueue(), finish = deferred();
    const second = vi.fn(async () => {});
    queue.schedule('first', async () => { await finish.promise; });
    void finish.promise.then(() => { void Promise.resolve().then(() => queue.schedule('second', second)); });
    finish.resolve();
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
    await queue.stop();
  });

  it('refuses to save background lookup results when the grant was withdrawn in flight', async () => {
    const runtime = new AppRuntime(), finish = deferred<Record<string, unknown>[]>(), entered = deferred();
    let permitted = true;
    const apply = vi.fn();
    const requireLicense = vi.spyOn(runtime, 'requireLicense').mockImplementation(async () => {
      if (!permitted) throw new Error('LICENSE_MATTER_DENIED');
      return { licenseId: 'fixture', allowedSystems: ['online-car-permit'], expiresAt: Date.now() + 60_000 };
    });
    const enrichment = vi.fn(async () => { entered.resolve(); return finish.promise; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(runtime, { enterpriseService: { enrich: enrichment }, platformStore: { applyEnterpriseEnrichment: apply } });
    const internals = runtime as unknown as { scheduleLocalEnrichment(rows: unknown[], ledger: boolean): void; localEnrichment: { active?: Promise<void>; stop(): Promise<void> } };
    const row = { xkXdrMc: '测试企业', xkXdrLb: '法人及非法人组织', xkFrdb: '', xkXdrShxym: '91440300123456789Q' };
    internals.scheduleLocalEnrichment([{ systemId: 'online-car-permit', matterId: 'online-car-permit-return', recordKey: 'fixture', data: row }], true);
    await entered.promise; permitted = false;
    finish.resolve([{ ...row, xkFrdb: '查询返回法人' }]);
    await internals.localEnrichment.active;
    expect(requireLicense).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();
    await internals.localEnrichment.stop(); warn.mockRestore();
  });

  it('exports the newer manual edit after a delayed enrichment fails its compare-and-set', async () => {
    const database = new NodeSqliteDriver(':memory:');
    const repository = new SqliteLocalRepository(database); await repository.initialize();
    const store = new SqlitePlatformStore(database); await store.initialize();
    const runtime = new AppRuntime(), entered = deferred(), finish = deferred<Record<string, unknown>[]>();
    const systemId = onlineCarPermitPlugin.id, matter = onlineCarPermitPlugin.matters[0], matterId = matter.id;
    runtime.plugins.register(onlineCarPermitPlugin);
    const initial = { xkWsh: 'TEST-PERMIT', xkJdrq: '2026-11-01', xkXdrMc: '测试企业', xkXdrLb: '法人及非法人组织',
      xkXdrShxym: '91440300123456789Q', xkFrdb: '' };
    const key = buildRecordKey(initial, matter.uniqueKey), sync = new DefaultLocalSyncEngine(repository);
    await sync.commit(systemId, matterId, await sync.preview(systemId, matterId, matter.uniqueKey, [initial]));
    const writeExport = vi.fn(async (_path, _format, records) => ({ path: 'fixture.xlsx', rowCount: records.length, createdAt: 1 }));
    Object.assign(runtime, { repository, platformStore: store, exportService: { export: writeExport },
      enterpriseService: { enrich: async () => { entered.resolve(); return finish.promise; } } });
    vi.spyOn(runtime, 'currentGrant').mockResolvedValue({ licenseId: 'fixture', expiresAt: Date.now() + 60_000,
      allowedSystems: [systemId], allowedMatters: { [systemId]: [matterId] }, allowExport: true });
    try {
      const exported = runtime.exportLocalRecords({ systemId, matterId }, 'fixture.xlsx', 'xlsx');
      await entered.promise;
      await store.updateRecord(systemId, matterId, key, key, { ...initial, xkFrdb: '人工核验法人' });
      finish.resolve([{ ...initial, xkFrdb: '查询返回法人' }]);
      await exported;
      expect((await repository.find(systemId, matterId, key))?.data.xkFrdb).toBe('人工核验法人');
      expect(writeExport.mock.calls[0][2][0].data.xkFrdb).toBe('人工核验法人');
    } finally { await database.close(); }
  });
});
