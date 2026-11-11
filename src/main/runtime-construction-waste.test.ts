import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));
import { AppRuntime } from './runtime';
import { governmentInfoPlugin } from '../plugins/government-info';
import { enrichConstructionWaste } from '../plugins/government-info/field-rules';
import { toDoublePublicityRecord } from '../plugins/government-info/enrichment';
import { EnterpriseEnrichmentService } from '../core/enterprise/service';
import { MemoryLocalRepository } from '../core/storage/memory-repository';
import { buildRecordKey, DefaultLocalSyncEngine } from '../core/sync/engine';

describe('construction-waste contractor reflow', () => {
  it.each([true, false])('replaces the legacy proxy and stores the same contractor result in the ledger and batch (resolved=%s)', async resolved => {
    const runtime = new AppRuntime(), repository = new MemoryLocalRepository(), engine = new DefaultLocalSyncEngine(repository);
    const plugin = governmentInfoPlugin, definition = plugin.matters.find(matter => matter.id === 'construction-waste-discharge')!;
    const source = { cityLsh: 'FIXTURE-CITY', sxmc: definition.name, sxType: '1', applyer: '深圳市南山区水务局', cardNumber: '11440305MB2D27962K' };
    const incoming = toDoublePublicityRecord(enrichConstructionWaste(source,
      { zjbh: 'FIXTURE-PERMIT', zzsj: '2026-10-27', zjyxqstart: '2026-10-27', zjyxqend: '2027-10-27' },
      { paragraphs: [], tables: [[['许可正文发证机关：水务局'], ...(resolved ? [['施工单位', '施工企业有限公司']] : [])]] }));
    const legacy = toDoublePublicityRecord({ ...source, qymc: source.applyer, xydm: source.cardNumber, frdb: '机关法人' });
    await engine.commit(plugin.id, definition.id, await engine.preview(plugin.id, definition.id, definition.uniqueKey, [legacy]));
    const matter = { ...definition, query: async () => ({ rows: [incoming], total: 1, page: 1, pageSize: 1 }) };
    runtime.plugins.register({ ...plugin, matters: [matter], getSessionState: async () => ({ status: 'authenticated', systemId: plugin.id }),
      auth: { ...plugin.auth, getSessionForRequest: async () => ({ metadata: {} }) } });
    const fetcher = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).items).toEqual([{ name: '施工企业有限公司', creditCode: '', applicantCode: '' }]);
      return Response.json({ results: [{ requestId: 'fixture', status: 'success', reason: '',
        enterprise: { id: 'fixture', name: '施工企业有限公司', creditCode: '91440300123456789Q', legalPerson: '施工单位法人', source: 'cache', updatedAt: 1 } }] });
    });
    const replaceTaskOutput = vi.fn();
    Object.assign(runtime, { repository, syncEngine: engine, platformStore: { replaceTaskOutput }, requireLicense: vi.fn(async () => {}),
      enterpriseService: new EnterpriseEnrichmentService('https://backend.test/api/enterprises/resolve', async () => ({
        proof: { payload: 'fixture', signature: 'fixture', algorithm: 'RSA-SHA256' }, deviceId: 'fixture',
      }), fetcher) });
    const context = { taskId: 'fixture-contractor-batch', signal: new AbortController().signal, report: vi.fn() };
    expect(await runtime.runOneClickReturn(plugin.id, matter.id, context)).toMatchObject({ total: 1, inserted: 0, updated: 1 });
    const key = buildRecordKey(source, matter.uniqueKey), saved = (await repository.find(plugin.id, matter.id, key))!.data;
    expect(saved).toMatchObject({ applyer: source.applyer, cardNumber: source.cardNumber,
      xkXdrMc: resolved ? '施工企业有限公司' : '', xkFrdb: resolved ? '施工单位法人' : '',
      xkXdrShxym: resolved ? '91440300123456789Q' : '', constructionWastePrincipal: { status: resolved ? 'resolved' : 'missing' } });
    expect(replaceTaskOutput).toHaveBeenLastCalledWith(context.taskId, plugin.id, matter.id, [{ recordKey: key, data: saved }]);
    await runtime.runOneClickReturn(plugin.id, matter.id, context);
    expect(fetcher).toHaveBeenCalledTimes(resolved ? 1 : 0);
  });
});
