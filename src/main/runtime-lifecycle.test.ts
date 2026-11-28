import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));
vi.mock('./login-tab', () => ({ loginTabController: { flushSessionStorage: vi.fn(async () => {}) } }));
import { AppRuntime } from './runtime';
import { TaskEngine } from '../core/tasks/engine';
import { LocalEnrichmentQueue } from './local-enrichment-queue';

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

describe('runtime shutdown and nonblocking local enrichment', () => {
  it('does not write an export when export permission was revoked during enrichment', async () => {
    const runtime = new AppRuntime(), lookup = gate(), entered = gate(), write = vi.fn();
    let allowExport = true;
    const row = { systemId: 'online-car-permit', matterId: 'fixture', recordKey: 'key',
      data: { xkXdrMc: '测试公司', xkXdrLb: '法人及非法人组织', xkFrdb: '' } };
    Object.assign(runtime, {
      currentGrant: async () => ({ allowExport, allowedSystems: [row.systemId], expiresAt: Date.now() + 60_000 }),
      requireLicense: async () => {}, exportService: { export: write },
      enterpriseService: { enrich: async (_s: string, _m: string, rows: object[]) => { entered.release(); await lookup.wait; return rows; } },
      platformStore: { recordsForExport: async () => [row] },
    });
    const exporting = runtime.exportLocalRecords({ systemId: row.systemId }, 'fixture.xlsx', 'xlsx');
    await entered.wait; allowExport = false; lookup.release();
    await expect(exporting).rejects.toThrow('LICENSE_FEATURE_DENIED');
    expect(write).not.toHaveBeenCalled();
  });
  it('continues independent session flushes and storage close after one vault write fails', async () => {
    const runtime = new AppRuntime(), order: string[] = [];
    Object.assign(runtime, {
      credentialStore: { flush: async () => { order.push('credentials'); throw new Error('fixture vault write failure'); } },
      sessionRecovery: { flush: async () => { order.push('recovery'); } },
      sessionStore: { flush: async () => { order.push('sessions'); } },
      repository: { close: async () => { order.push('close'); } },
    });
    await expect(runtime.shutdown()).rejects.toThrow('部分后台任务未能正常保存');
    expect(order).toEqual(['credentials', 'recovery', 'sessions', 'close']);
  });
  it('keeps storage open until tasks and admitted business operations have finished', async () => {
    const runtime = new AppRuntime(), taskGate = gate(), opGate = gate();
    const events: string[] = [], close = vi.fn(async () => { events.push('close'); });
    runtime.tasks = new TaskEngine({ save: async task => { events.push(task.status); }, listTasks: async () => [] });
    Object.assign(runtime, { repository: { close } });
    let signal: AbortSignal | undefined;
    const task = runtime.tasks.run('fixture', async context => { signal = context.signal; await taskGate.wait; });
    const op = runtime.businessOperation(() => opGate.wait);
    await vi.waitFor(() => expect(signal).toBeDefined());
    const stopping = runtime.shutdown();
    expect(runtime.shutdown()).toBe(stopping);
    expect(signal!.aborted).toBe(true);
    await expect(runtime.businessOperation(async () => {})).rejects.toThrow('正在保存');
    expect(close).not.toHaveBeenCalled();
    taskGate.release(); await task;
    expect(close).not.toHaveBeenCalled();
    opGate.release(); await op; await stopping;
    expect(events.at(-1)).toBe('close');
    expect(events).toContain('cancelled');
  });

  it('returns a local snapshot immediately and notifies after enrichment is saved', async () => {
    const runtime = new AppRuntime(), lookup = gate();
    const row = { systemId: 'online-car-permit', matterId: 'fixture', recordKey: 'key', data: {
      xkXdrMc: '测试服务中心', xkXdrLb: '法人及非法人组织', xkFrdb: '', xkXdrShxym: '',
    } };
    const apply = vi.fn(async () => {}), changed = vi.fn();
    const enrich = vi.fn(async (_system, _matter, rows) => { await lookup.wait; return rows.map((item: object) => ({ ...item, xkFrdb: '已补法人' })); });
    Object.assign(runtime, { currentGrant: async () => ({ expiresAt: Date.now() + 60_000, allowedSystems: [row.systemId] }),
      requireLicense: async () => {}, enterpriseService: { enrich },
      platformStore: { listRecords: async () => ({ rows: [row], total: 1 }), applyEnterpriseEnrichment: apply } });
    runtime.onRecordsChanged(changed);
    const result = await runtime.listLocalRecords({ systemId: row.systemId, matterId: row.matterId });
    expect(result.rows[0].data.xkFrdb).toBe(''); expect(apply).not.toHaveBeenCalled();
    await runtime.listLocalRecords({ systemId: row.systemId, matterId: row.matterId });
    expect(enrich).toHaveBeenCalledTimes(1);
    lookup.release();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith({ systemId: row.systemId, matterId: row.matterId }));
    expect(apply).toHaveBeenCalledOnce(); expect(result.rows[0].data.xkFrdb).toBe('');
    await runtime.shutdown();
  });

  it('aborts background lookup on exit and discards enrichment without touching closed storage', async () => {
    const runtime = new AppRuntime(), lookup = gate(), apply = vi.fn();
    const row = { systemId: 'online-car-permit', matterId: 'fixture', recordKey: 'key', data: { xkXdrMc: '测试公司', xkXdrLb: '法人及非法人组织' } };
    let signal: AbortSignal | undefined;
    Object.assign(runtime, { currentGrant: async () => ({ expiresAt: Date.now() + 60_000, allowedSystems: [row.systemId] }), requireLicense: async () => {},
      enterpriseService: { enrich: async (_s: string, _m: string, rows: object[], abort: AbortSignal) => { signal = abort; await lookup.wait; return rows.map(data => ({ ...data, xkFrdb: '迟到结果' })); } },
      platformStore: { listRecords: async () => ({ rows: [row], total: 1 }), applyEnterpriseEnrichment: apply } });
    await runtime.listLocalRecords({ systemId: row.systemId });
    const stop = runtime.shutdown();
    expect(signal!.aborted).toBe(true);
    lookup.release(); await stop;
    expect(apply).not.toHaveBeenCalled();
  });

  it('deduplicates repeated pages and serializes unrelated enrichment requests', async () => {
    const queue = new LocalEnrichmentQueue(), first = gate(), order: string[] = [];
    queue.schedule('a', async () => { order.push('a'); await first.wait; });
    queue.schedule('a', async () => { order.push('duplicate'); });
    queue.schedule('b', async () => { order.push('b'); });
    expect(order).toEqual(['a']); first.release();
    await vi.waitFor(() => expect(order).toEqual(['a', 'b']));
    queue.schedule('a', async () => { order.push('repeat'); });
    await queue.stop(); expect(order).toEqual(['a', 'b']);
  });
});
