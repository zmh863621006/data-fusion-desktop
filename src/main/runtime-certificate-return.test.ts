import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));

import { AppRuntime } from './runtime';
import { governmentInfoPlugin } from '../plugins/government-info';
import { MemoryLocalRepository } from '../core/storage/memory-repository';
import { buildRecordKey, DefaultLocalSyncEngine } from '../core/sync/engine';
import { supplementCertificateFields } from '../plugins/government-info/certificate-fields';

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
});
