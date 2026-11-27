import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));

import { AppRuntime } from './runtime';
import { NodeSqliteDriver } from '../core/storage/database';
import { SqliteLocalRepository } from '../core/storage/sqlite-repository';
import { SqlitePlatformStore } from '../core/storage/platform-store';
import { DefaultLocalSyncEngine, buildRecordKey } from '../core/sync/engine';
import { TaskEngine } from '../core/tasks/engine';
import type { BusinessSystemPlugin } from '../core/plugins/types';
import type { LicenseGrant } from '../core/license/types';
import type { StoredRecord } from '../core/storage/types';
import { SHENZHEN_INSURANCE_MATTER as social, SHENZHEN_POST_MATTER as post, SHENZHEN_SYSTEM_ID as systemId } from '../plugins/shenzhen-integrated-services/catalog';
import { mergeShenzhenRecord } from '../plugins/shenzhen-integrated-services/query';
import { canonicalRecordQuery, visibleRecordMatter } from './shenzhen-record-scope';

const databases: NodeSqliteDriver[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.close(); });
const history = [{ operator: '合成操作人', reviewer: '合成审批人', step: '受理', operatedAt: '2026-11-01 09:00:00', reviewedAt: '2026-11-01 10:00:00' }];
const initial = () => ({ recordKey: 'shared-source-case', caseNumber: 'SYNTHETIC-CASE', sourceMatterName: '吸纳脱贫人口社保补贴和岗位补贴',
  businessState: '受理通过', handlingRecordStatus: 'collected', handlingRecordCount: history.length, handlingRecords: structuredClone(history) });

async function fixture(allowed = [post, social]) {
  const db = new NodeSqliteDriver(':memory:'); databases.push(db);
  const repository = new SqliteLocalRepository(db); await repository.initialize();
  const store = new SqlitePlatformStore(db); await store.initialize();
  const engine = new DefaultLocalSyncEngine(repository), runtime = new AppRuntime();
  const state = { rows: [initial()] as Record<string, unknown>[], undated: 0, grant: {
    licenseId: 'isolated-shenzhen-runtime-test', expiresAt: Date.now() + 3_600_000, allowedSystems: [systemId], allowedMatters: { [systemId]: [...allowed] }, allowExport: true,
  } as LicenseGrant };
  const query = vi.fn(async () => ({ rows: structuredClone(state.rows), total: state.rows.length, page: 1, pageSize: 200, ...(state.undated ? { undatedExcludedCount: state.undated } : {}) }));
  const plugin: BusinessSystemPlugin = {
    id: systemId, name: '合成深圳测试系统', version: '0.2.0', workspaceMode: 'list-ledger', loginMode: 'embedded',
    loginPage: { url: 'https://source.invalid/login', partition: 'persist:isolated-shenzhen-test', allowedOrigin: 'https://source.invalid' },
    auth: { getState: async () => ({ systemId, status: 'authenticated' }), login: async () => ({ systemId, status: 'authenticated' }), logout: async () => {}, getSessionForRequest: async () => ({ metadata: {} }) },
    getSessionState: async () => ({ systemId, status: 'authenticated' }), initialize: async () => {},
    matters: [post, social, 'ordinary-shenzhen-matter'].map(id => ({ id, name: id, uniqueKey: ['recordKey'], querySchema: [], query, mergeRecord: mergeShenzhenRecord,
      executionMode: 'one-click-return' as const, createDefaultContext: () => ({ page: 1, pageSize: 200, filters: { startDate: '2026-11-01', endDate: '2026-11-30' } }), listColumns: [{ key: 'caseNumber', label: '办件编号' }] })),
  };
  runtime.plugins.register(plugin);
  const enterprise = { enrich: vi.fn(async (_s: string, _m: string, rows: Record<string, unknown>[]) => rows) };
  Object.assign(runtime, { repository, platformStore: store, syncEngine: engine, currentGrant: vi.fn(async () => state.grant), enterpriseService: enterprise });
  runtime.tasks = new TaskEngine(store);
  const run = (matterId = post) => runtime.tasks.run('合成办理过程回流', ctx => runtime.runOneClickReturn(systemId, matterId, ctx), { type: 'data-return', systemId, matterId });
  return { db, repository, store, engine, runtime, state, run, query, enterprise };
}

describe('Shenzhen canonical source scope', () => {
  it('keeps two authorized entries in one ledger while task outputs preserve the requested entry', async () => {
    const f = await fixture(), before = JSON.stringify(f.state.grant);
    const first = await f.run(post), second = await f.run(social);
    expect(first.status).toBe('completed'); expect(second.status).toBe('completed');
    expect((await f.store.listRecords({ systemId })).total).toBe(1);
    expect((await f.store.listRecords({ systemId, matterId: post })).total).toBe(0);
    expect((await f.runtime.listLocalRecords({ systemId, matterId: post })).rows[0].matterId).toBe(post);
    expect((await f.runtime.listLocalRecords({ systemId, matterId: social })).rows[0].matterId).toBe(social);
    expect((await f.runtime.listLocalRecords({})).total).toBe(1);
    expect((await f.store.listTaskOutput(first.id)).rows[0].matterId).toBe(post);
    expect((await f.store.listTaskOutput(second.id)).rows[0].matterId).toBe(social);
    expect(JSON.stringify(f.state.grant)).toBe(before); expect(f.enterprise.enrich).not.toHaveBeenCalled();
  });

  it('allows post-only reads, versions and exports through post but rejects direct social access', async () => {
    const f = await fixture([post]); await f.run(post);
    await f.repository.upsert({ systemId, matterId: 'ordinary-shenzhen-matter', recordKey: 'private-record', data: { private: 'not-licensed' }, firstSeenAt: 1, updatedAt: 1 });
    const key = buildRecordKey(initial(), ['recordKey']);
    const fromPost = await f.runtime.listLocalRecords({ systemId, matterId: post }); expect(fromPost.total).toBe(1); expect(fromPost.rows[0].matterId).toBe(post);
    const global = await f.runtime.listLocalRecords({}); expect(global.total).toBe(1); expect(global.rows[0].matterId).toBe(post);
    expect((await f.runtime.listRecordVersions(systemId, post, key))[0].matterId).toBe(post);
    const writer = vi.spyOn(f.runtime as unknown as { exportRecords: (...args: unknown[]) => Promise<unknown> }, 'exportRecords').mockResolvedValue({ saved: true });
    await expect(f.runtime.exportLocalRecords({ systemId, matterId: post }, undefined, 'xlsx')).resolves.toEqual({ saved: true });
    expect((writer.mock.calls[0][0] as StoredRecord[]).map(r => r.matterId)).toEqual([post]);
    await expect(f.runtime.exportLocalRecords({}, undefined, 'xlsx')).resolves.toEqual({ saved: true });
    expect((writer.mock.calls[1][0] as StoredRecord[])).toHaveLength(1);
    for (const action of [
      () => f.runtime.listLocalRecords({ systemId, matterId: social }),
      () => f.runtime.listLocalRecords({ matterId: social }),
      () => f.runtime.exportLocalRecords({ systemId, matterId: social }, undefined, 'xlsx'),
      () => f.runtime.listRecordVersions(systemId, social, key),
      () => f.runtime.updateLocalRecord(systemId, social, key, {}),
    ]) await expect(action()).rejects.toThrow('LICENSE_MATTER_DENIED');
    expect(writer).toHaveBeenCalledTimes(2); expect(f.enterprise.enrich).not.toHaveBeenCalled();
    f.state.grant = { ...f.state.grant, allowedSystems: [] }; expect((await f.runtime.listLocalRecords({})).total).toBe(0);
  });

  it('retains previous process data on an incomplete refresh and clears it only on a successful empty history', async () => {
    const f = await fixture(); await f.run(post);
    f.state.rows = [{ ...initial(), businessState: '初审通过', handlingRecordStatus: 'failed', handlingRecordCount: 0, handlingRecords: [] }];
    const second = await f.run(social); expect(second.status).toBe('completed');
    expect(second.result).toMatchObject({ partial: true, incompleteHandlingCount: 1 }); expect(second.progress.message).toContain('办理过程待补齐1笔');
    const stale = (await f.runtime.listLocalRecords({ systemId, matterId: post })).rows[0].data;
    expect(stale).toMatchObject({ businessState: '初审通过', handlingRecordStatus: 'failed', handlingRecordCount: 1, handlingRecords: history });
    expect((await f.store.listTaskOutput(second.id)).rows[0].data).toEqual(stale);
    f.state.rows = [{ ...initial(), handlingRecordStatus: 'collected', handlingRecordCount: 0, handlingRecords: [] }];
    await f.run(post); expect((await f.runtime.listLocalRecords({ systemId, matterId: social })).rows[0].data.handlingRecords).toEqual([]);
  });

  it.each(['cancel-during-write', 'write-error'])('rolls back canonical ledger and task output on %s', async failure => {
    const f = await fixture(); await f.run(post);
    const key = buildRecordKey(initial(), ['recordKey']), previous = await f.repository.find(systemId, social, key), versions = await f.repository.listVersions(systemId, social, key);
    f.state.rows = [{ ...initial(), businessState: '归档完成' }];
    const write = f.store.replaceTaskOutput.bind(f.store);
    vi.spyOn(f.store, 'replaceTaskOutput').mockImplementationOnce(async (...args) => { await write(...args); if (failure === 'write-error') throw new Error('合成保存失败'); f.runtime.tasks.cancel(args[0]); });
    const task = await f.run(social);
    expect(task.status).toBe(failure === 'write-error' ? 'failed' : 'cancelled');
    expect(await f.repository.find(systemId, social, key)).toEqual(previous);
    expect(await f.repository.listVersions(systemId, social, key)).toEqual(versions);
    expect((await f.store.listTaskOutput(task.id)).total).toBe(0);
    expect((await f.store.listRecords({ systemId, matterId: post })).total).toBe(0);
  });

  it('does not alias ordinary matters and rejects mutation or renderer supplied history', async () => {
    const f = await fixture(['ordinary-shenzhen-matter']); const task = await f.run('ordinary-shenzhen-matter'); expect(task.status).toBe('completed');
    expect((await f.store.listRecords({ systemId, matterId: 'ordinary-shenzhen-matter' })).total).toBe(1);
    expect((await f.store.listRecords({ systemId, matterId: social })).total).toBe(0);
    await expect(f.runtime.updateLocalRecord(systemId, 'ordinary-shenzhen-matter', 'key', {})).rejects.toThrow('只读');
    await expect(f.runtime.createSyncPreview(systemId, 'ordinary-shenzhen-matter', [])).rejects.toThrow('列表回流');
  });

  it('reports uncertain selected dates without the unrelated license-decision-date wording', async () => {
    const f = await fixture(); f.state.undated = 2;
    const task = await f.run(post); expect(task.result).toMatchObject({ undatedExcludedCount: 2 });
    expect(task.progress.message).toContain('所选日期类型'); expect(task.progress.message).not.toContain('许可决定');
  });

  it('does not release a canonical record after its visible-entry permission is revoked during the read', async () => {
    const f = await fixture([post]); await f.run(post);
    const read = f.store.listRecords.bind(f.store);
    vi.spyOn(f.store, 'listRecords').mockImplementationOnce(async query => {
      const rows = await read(query); f.state.grant = { ...f.state.grant, allowedMatters: { [systemId]: [] } }; return rows;
    });
    await expect(f.runtime.listLocalRecords({ systemId, matterId: post })).rejects.toThrow('LICENSE_MATTER_DENIED');
  });

  it('maps only the reviewed alias and never mutates the grant or accepts client-supplied access scopes', () => {
    const grant: LicenseGrant = { licenseId: 'fixture', expiresAt: Date.now() + 60_000, allowedSystems: [systemId, 'other'], allowedMatters: { [systemId]: [post], other: [post] } };
    const before = JSON.stringify(grant), query = canonicalRecordQuery({ systemId, matterId: post, accessScopes: [{ systemId: 'unlicensed' }] }, grant);
    expect(query).toMatchObject({ matterId: social, accessScopes: [{ systemId, matterIds: [social] }, { systemId: 'other', matterIds: [post] }] });
    const ordinary = { systemId: 'other', matterId: post }; expect(visibleRecordMatter(ordinary, {}, grant)).toBe(ordinary);
    expect(canonicalRecordQuery({ systemId: 'other', matterId: post }, grant).matterId).toBe(post); expect(JSON.stringify(grant)).toBe(before);
  });
});
