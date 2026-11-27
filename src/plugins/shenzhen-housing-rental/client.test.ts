import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ session: { fromPartition: () => ({ clearStorageData: vi.fn() }) } }));
import { decryptEcs14Request, decryptEcsRequest, encryptEcsRequest } from '../government-info/codec';
import { AppError } from '../../core/errors/app-error';
import { validatePluginContract } from '../../core/plugins/types';
import { HousingRentalClient } from './client';
import { session } from 'electron';
import { createHousingRentalPlugin } from './index';
import { HOUSING_HOME_URL, HOUSING_LOGIN_URL, HOUSING_PARTITION, HOUSING_RPC_URL } from './catalog';
import { housingAreaPrefix, housingAcceptancePrefix, housingRows, parseHousingRpc } from './protocol';

const SID = 'fixture_housing_session_A_0000000000';
const AREA = '440305009000000000';
const CODE = '440305009' + '0'.repeat(15) + '1';
const CERTIFICATE = '粤（2026）合成第001号';
const acceptance = 'FIXTURE-ACCEPT-001';
const encoded = (value: unknown) => encryptEcsRequest(encodeURIComponent(JSON.stringify(value))).slice(2);
const response = (value: unknown) => new Response(encoded(value), { headers: { 'content-type': 'text/plain' } });
const table = (rows: Record<string, unknown>[], total = rows.length) => ({ count: total, result: rows });

interface FixtureOptions {
  wrongCase?: boolean; wrongCaseArea?: boolean; unrelatedCertificate?: boolean; wrongRelatedCase?: boolean;
  multipleProperty?: boolean; wrongPropertyArea?: boolean; houseArea?: string; multipleHouse?: boolean;
  wrongCode?: boolean; invalidHouse?: boolean; houseMissing?: boolean; bound?: boolean; repeatedBinding?: boolean;
  writeTimeout?: boolean; writeResult?: unknown; emptyBindingList?: boolean; expired?: boolean; malformed?: boolean;
  sessionArea?: string;
  code?: string; houseId?: string;
  caseMark?: number; ignoreCaseMarkFilter?: boolean; caseArea?: string;
}
function fixture(options: FixtureOptions = {}) {
  const calls: Array<{ method: string; args: string[]; query?: Record<string, any>; init: RequestInit }> = [];
  let bound = Boolean(options.bound);
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(HOUSING_RPC_URL);
    const headers = new Headers(init.headers), type = headers.get('data-type');
    expect(headers.get('lsys-area')).toBe('4403'); expect(headers.get('lsys-name')).toBe('ZIB'); expect(headers.get('lrqvt')).toBe('3');
    expect(init.redirect).toBe('manual');
    const qs = new URLSearchParams(headers.get('qs')!);
    const method = qs.get('method')!;
    const args = JSON.parse((type === '14' ? decryptEcs14Request : decryptEcsRequest)(String(init.body)));
    expect(qs.get('sid')).toBe(SID); expect(Number(qs.get('parlen'))).toBe(args.length);
    const query = method === 'DynaSearch' ? JSON.parse(args[0]) : undefined;
    calls.push({ method, args, query, init });
    if (options.expired) return new Response('<html><input type="password"></html>', { headers: { 'content-type': 'text/html' } });
    if (options.malformed) return new Response('not-a-valid-rpc-response');
    if (method === 'app_getLogicModuleOperations') {
      expect(type).toBe('14'); expect(args).toEqual(['ZLindex2', 'true', 'true']);
      return response({ name: 'ZLindex2', operations: ['system.all'], userinfo: { userid: 'fixture_user', areaid: options.sessionArea ?? AREA } });
    }
    if (method === 'insertOrupdatePropertyHouse') {
      expect(type).toBe('16');
      if (options.writeTimeout) return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true }));
      bound = true;
      return response(Object.hasOwn(options, 'writeResult') ? options.writeResult : true);
    }
    expect(method).toBe('DynaSearch'); expect(query.pageNum).toBe(1); expect(query.pageSize).toBe(2);
    if (query.name === 'tysl_transactor') {
      const mark = options.caseMark ?? 2;
      if (!options.ignoreCaseMarkFilter && query.parameters.find((p: any) => p.name === 'delmark')?.value !== mark) return response(table([]));
      return response(table([{ id: 'case_fixture', transactno: options.wrongCase ? 'DIFFERENT' : acceptance,
        acceptareaid: options.wrongCaseArea ? '440304009000000000' : options.caseArea ?? AREA, delmark: String(mark) }]));
    }
    if (query.name === 'tysl_contractproperty') return response(table(options.unrelatedCertificate ? [] : [{ id: 'case_property_fixture',
      tysl_transactor_id: options.wrongRelatedCase ? 'case_other' : 'case_fixture', housecertification: CERTIFICATE, housecertificationid: '01' }]));
    if (query.name === 'property') return response(table([{ id: 'property_fixture', housecertification: CERTIFICATE, housecertificationid: '01',
      areaid: options.wrongPropertyArea ? '440304009000000000' : AREA, delmark: '0' }], options.multipleProperty ? 2 : 1));
    if (query.name === 'viewcodehouse') return response(table(options.houseMissing ? [] : [{ id: options.houseId ?? 'house_fixture', code: options.wrongCode ? '9'.repeat(25) : options.code ?? CODE,
      buildingid: 'building_fixture', houseaddress: '合成房屋地址', areaid: options.houseArea ?? AREA, delmark: '0', isvalid: options.invalidHouse ? '0' : '1' }], options.houseMissing ? 0 : options.multipleHouse ? 2 : 1));
    if (query.name === 'propertyhouse') {
      if (!bound && options.emptyBindingList) return new Response('');
      return response(table(bound ? [{ id: 'binding_fixture', propertyid: 'property_fixture', houseid: 'house_fixture', delmark: '0' }] : [], options.repeatedBinding ? 2 : bound ? 1 : 0));
    }
    throw new Error('Unrecognized fixture query');
  });
  const client = new HousingRentalClient({ fetcher, minimumIntervalMs: 0, timeoutMs: options.writeTimeout ? 20 : 1000 });
  client.acceptRequestHeaders({ QS: `method=app_getUIResource2&sid=${SID}&parlen=4` });
  return { client, calls, fetcher };
}

describe('housing rental scoped binding client', () => {
  it('resolves the exact case certificate, locates the house, checks existing bindings and submits one original payload', async () => {
    const { client, calls } = fixture();
    const target = await client.resolveTarget(acceptance, CERTIFICATE);
    expect(target).toEqual({ acceptanceId: 'case_fixture', propertyId: 'property_fixture', certificateNumber: CERTIFICATE, areaId: AREA, cardId: null });
    const house = await client.findHouse(CODE, target); expect(house?.id).toBe('house_fixture');
    expect(house?.id).not.toBe(CODE); expect(await client.isBound(target, house!)).toBe(false);
    await client.bindHouse(target, house!); expect(await client.isBound(target, house!)).toBe(true);
    const write = calls.filter(call => call.method === 'insertOrupdatePropertyHouse'); expect(write).toHaveLength(1);
    expect(JSON.parse(write[0].args[0])).toEqual([[{ beanname: 'propertyhouse', propertyid: 'property_fixture', houseid: 'house_fixture', housecode: CODE,
      buildingid: 'building_fixture', delmark: '0', cardid: null }]]);
    expect(calls.find(call => call.query?.name === 'tysl_contractproperty')?.query?.parameters).toContainEqual({ name: 'TYSL_TRANSACTOR_ID', value: 'case_fixture', flag: 11 });
    expect(calls.find(call => call.query?.name === 'tysl_transactor')?.query?.parameters).toContainEqual({ name: 'delmark', value: 2, flag: 11 });
    expect(calls.find(call => call.query?.name === 'property')?.query?.parameters).toContainEqual({ name: 'delmark', value: '0', flag: 11 });
    expect(calls.find(call => call.query?.name === 'viewcodehouse')?.query?.parameters).toContainEqual({ name: 'code', value: CODE, flag: 11 });
    expect(calls.every(call => ['DynaSearch','app_getLogicModuleOperations','insertOrupdatePropertyHouse'].includes(call.method))).toBe(true);
  });
  it('uses the captured acceptance-list marker 2, while property relations continue using deletion marker 0', async () => {
    const {client,calls}=fixture();await client.resolveTarget(acceptance,CERTIFICATE);
    const query=calls.find(call=>call.query?.name==='tysl_transactor')!.query!;
    expect(query.parameters).toEqual([{name:'transactno',value:acceptance,flag:11},{name:'acceptareaid',value:'440305009000000000',flag:16},{name:'acceptareaid',value:'440305009999999999',flag:17},{name:'delmark',value:2,flag:11}]);
    expect(calls.filter(call=>call.query?.name==='property').every(call=>call.query!.parameters.some((p:any)=>p.name==='delmark'&&p.value==='0'))).toBe(true);
    expect(calls.some(call=>call.method==='insertOrupdatePropertyHouse')).toBe(false);
  });
  it.each([0,7])('does not silently switch to another business list when marker is %s',async caseMark=>{
    const {client,calls}=fixture({caseMark});await expect(client.resolveTarget(acceptance,CERTIFICATE)).rejects.toThrow('合同受理列表');
    expect(calls.filter(call=>call.query?.name==='tysl_transactor')).toHaveLength(1);
    expect(calls.some(call=>call.query?.name==='property'||call.method==='insertOrupdatePropertyHouse')).toBe(false);
  });
  it('rejects a non-acceptance row even when the remote service ignores its state filter',async()=>{
    const {client,calls}=fixture({caseMark:0,ignoreCaseMarkFilter:true});await expect(client.resolveTarget(acceptance,CERTIFICATE)).rejects.toThrow('受理状态');
    expect(calls.some(call=>call.method==='insertOrupdatePropertyHouse')).toBe(false);
  });
  it('honors the acceptance page community range without changing the property/house street scope',async()=>{
    const group='440305009123000000';const {client,calls}=fixture({sessionArea:group,caseArea:group});
    await client.resolveTarget(acceptance,CERTIFICATE);
    expect(calls.find(call=>call.query?.name==='tysl_transactor')?.query?.parameters).toContainEqual({name:'acceptareaid',value:'440305009123999999',flag:17});
    expect(housingAreaPrefix(group)).toBe('440305009');expect(housingAcceptancePrefix(group)).toBe('440305009123');
  });
  it.each([{ wrongCase: true }, { wrongCaseArea: true }, { unrelatedCertificate: true }, { wrongRelatedCase: true }, { multipleProperty: true }, { wrongPropertyArea: true }])('rejects ambiguous or unrelated target %j before any write', async options => {
    const { client, calls } = fixture(options); await expect(client.resolveTarget(acceptance, CERTIFICATE)).rejects.toMatchObject({ code: 'QUERY_INVALID' });
    expect(calls.some(call => call.method === 'insertOrupdatePropertyHouse')).toBe(false);
  });
  it.each([{ houseArea: '440304009000000000' }, { houseArea: '440305008000000000' }, { wrongCode: true }, { invalidHouse: true }, { multipleHouse: true }])('refuses mismatched, invalid or ambiguous houses %j', async options => {
    const { client } = fixture(options); const target = await client.resolveTarget(acceptance, CERTIFICATE);
    await expect(client.findHouse(CODE, target)).rejects.toMatchObject({ code: 'QUERY_INVALID' });
  });
  it('reports a missing full code and keeps already-bound rows read-only for the task layer to skip', async () => {
    const missing = fixture({ houseMissing: true }); const a = await missing.client.resolveTarget(acceptance, CERTIFICATE);
    expect(await missing.client.findHouse(CODE, a)).toBeNull();
    const { client, calls } = fixture({ bound: true }); const target = await client.resolveTarget(acceptance, CERTIFICATE), house = await client.findHouse(CODE, target);
    expect(await client.isBound(target, house!)).toBe(true); expect(calls.some(call => call.method === 'insertOrupdatePropertyHouse')).toBe(false);
  });
  it('validates the session again before treating the legacy empty-body list as empty', async () => {
    const { client, calls } = fixture({ emptyBindingList: true }); const target = await client.resolveTarget(acceptance, CERTIFICATE), house = await client.findHouse(CODE, target);
    expect(await client.isBound(target, house!)).toBe(false);
    expect(calls.filter(call => call.method === 'app_getLogicModuleOperations')).toHaveLength(2);
  });
  it('rejects duplicate source relation rows rather than confirming a clean binding', async () => {
    const { client } = fixture({ bound: true, repeatedBinding: true }); const target = await client.resolveTarget(acceptance, CERTIFICATE), house = await client.findHouse(CODE, target);
    await expect(client.isBound(target, house!)).rejects.toThrow('重复');
  });
  it('never retries a timed-out write and leaves confirmation to a separate source re-read', async () => {
    const { client, calls } = fixture({ writeTimeout: true }); const target = await client.resolveTarget(acceptance, CERTIFICATE), house = await client.findHouse(CODE, target);
    await expect(client.bindHouse(target, house!)).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' });
    expect(calls.filter(call => call.method === 'insertOrupdatePropertyHouse')).toHaveLength(1);
  });
  it.each([false, null, {}, 'true', 2])('does not claim success or retry an unclear source write result %j', async writeResult => {
    const { client, calls } = fixture({ writeResult }); const target = await client.resolveTarget(acceptance, CERTIFICATE), house = await client.findHouse(CODE, target);
    await expect(client.bindHouse(target, house!)).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' });
    expect(calls.filter(call => call.method === 'insertOrupdatePropertyHouse')).toHaveLength(1);
    expect(await client.isBound(target, house!)).toBe(true);
  });
  it('uses only real source-validated targets and requires re-resolution after account/session changes', async () => {
    const { client } = fixture(); const target = await client.resolveTarget(acceptance, CERTIFICATE), house = await client.findHouse(CODE, target);
    expect(Object.isFrozen(target)).toBe(true); expect(Object.isFrozen(house)).toBe(true);
    await expect(client.bindHouse({ ...target }, house!)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    client.acceptSid('fixture_new_housing_session_000000000');
    await expect(client.isBound(target, house!)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });
  it('rechecks the source identity before writing and invalidates old targets after a same-SID role change', async () => {
    const options: FixtureOptions = {};
    const { client, calls } = fixture(options); const target = await client.resolveTarget(acceptance, CERTIFICATE), house = await client.findHouse(CODE, target);
    options.sessionArea = '440305008000000000';
    await expect(client.bindHouse(target, house!)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(calls.filter(call => call.method === 'insertOrupdatePropertyHouse')).toHaveLength(0);
  });
  it('invalidates source login HTML and never exposes raw tokens in the error', async () => {
    const { client } = fixture({ expired: true }); await expect(client.validateSession()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(client.apiCredentials().status).toBe('expired'); expect(client.snapshot()).toBeNull();
  });
  it('keeps malformed network responses unverified rather than manufacturing an authenticated session', async () => {
    const { client } = fixture({ malformed: true }); await expect(client.validateSession()).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' });
    expect(client.apiCredentials().status).toBe('present');
  });
  it('requires complete textual codes, validates cancellation before requests and suppresses secret details', async () => {
    const { client, calls } = fixture(); const target = await client.resolveTarget(acceptance, CERTIFICATE);
    const count = calls.length; await expect(client.findHouse('0001 0002', target)).rejects.toThrow(); expect(calls.length).toBe(count);
    const controller = new AbortController(); controller.abort();
    await expect(client.findHouse(CODE, target, controller.signal)).rejects.toMatchObject({ code: 'TASK_CANCELLED' }); expect(calls.length).toBe(count);
    try { await client.findHouse('', target); } catch (error) { expect(String(error)).not.toContain(SID); }
  });
  it.each(['001', '0001234567890123456', CODE, '000001234567890123456789012345678901234567890', 'OLD/00007-A.01'])('keeps the entire variable-length code %s unchanged and uses an exact source comparison', async code => {
    const { client, calls } = fixture({ code }); const target = await client.resolveTarget(acceptance, CERTIFICATE);
    const house = await client.findHouse('  '+code+'  ', target);
    expect(house?.code).toBe(code);
    expect(calls.find(call=>call.query?.name==='viewcodehouse')?.query?.parameters).toContainEqual({name:'code',value:code,flag:11});
  });
  it.each(['00001','OLD/00007-A.01'])('does not require a UUID-shaped house key, including old houses whose real key is %s', async code => {
    const { client } = fixture({ code,houseId:code }); const target=await client.resolveTarget(acceptance,CERTIFICATE);
    expect(await client.findHouse(code,target)).toMatchObject({code,id:code});
  });
});

describe('housing rental plugin and protocol boundary', () => {
  it('registers one automation matter, explicit source login and main-process-only session recovery', async () => {
    const { client } = fixture(); const plugin = createHousingRentalPlugin({ client }); validatePluginContract(plugin);
    expect(plugin.matters).toHaveLength(1); expect(plugin.matters[0]).toMatchObject({ id: 'house-code-binding', queryAvailable: false, querySchema: [] });
    expect(plugin.loginPage).toMatchObject({ url: HOUSING_LOGIN_URL, partition: HOUSING_PARTITION });
    expect(plugin.sessionRecovery?.homeUrl()).toBe(HOUSING_HOME_URL);
    expect((await plugin.getSessionState()).status).toBe('authenticated');
    expect(JSON.stringify(await plugin.getSessionState())).not.toContain(SID);
    expect(plugin.sessionRecovery?.snapshot()).toEqual({ sid: SID });
    plugin.loginPage?.onLoginPageChange?.(true); expect((await plugin.getSessionState()).status).toBe('expired');
    client.acceptSid(SID); expect((await plugin.getSessionState()).status).toBe('authenticated');
    await expect(plugin.matters[0].query({ page: 1, pageSize: 1, filters: {} })).rejects.toThrow('工作台');
  });
  it('does not mistake a SID-shaped string or the presence of a home URL for a verified login', async () => {
    const fetcher = vi.fn(); const client = new HousingRentalClient({ fetcher }); const plugin = createHousingRentalPlugin({ client });
    expect((await plugin.getSessionState()).status).toBe('logged-out'); expect(fetcher).not.toHaveBeenCalled();
    client.acceptRequestHeaders({ Cookie: SID }); expect(client.snapshot()).toBeNull();
  });
  it('observes only this partition successful RPC headers and discards stale generations and redirects', async () => {
    const handlers: Record<string, Function> = {};
    const spy = vi.spyOn(session, 'fromPartition').mockReturnValue({ webRequest: Object.fromEntries(['onBeforeSendHeaders','onCompleted','onBeforeRedirect','onErrorOccurred'].map(name => [name, (_filter: unknown, fn: Function) => { handlers[name] = fn; }])) } as never);
    try {
      const client = new HousingRentalClient({ fetcher: vi.fn(), observeBrowser: true });
      await client.initialize(); expect(spy).toHaveBeenCalledWith(HOUSING_PARTITION);
      const callback = vi.fn();
      handlers.onBeforeSendHeaders({ id: 1, requestHeaders: { QS: `method=DynaSearch&sid=${SID}&parlen=1` } }, callback);
      handlers.onCompleted({ id: 1, statusCode: 302, responseHeaders: {} }); expect(client.snapshot()).toBeNull();
      handlers.onBeforeSendHeaders({ id: 2, requestHeaders: { QS: `method=DynaSearch&sid=${SID}&parlen=1` } }, callback);
      handlers.onCompleted({ id: 2, statusCode: 200, responseHeaders: { 'Content-Type': ['text/plain;charset=UTF-8'] } });
      expect(client.snapshot()).toEqual({ sid: SID }); expect(callback).toHaveBeenCalled();
      handlers.onBeforeSendHeaders({ id: 3, requestHeaders: { QS: `method=DynaSearch&sid=${SID}&parlen=1` } }, callback);
      client.clear(true); handlers.onCompleted({ id: 3, statusCode: 200, responseHeaders: { 'Content-Type': ['text/plain'] } });
      expect(client.snapshot()).toBeNull(); expect(client.apiCredentials().status).toBe('expired');
    } finally { spy.mockRestore(); }
  });
  it('maps real LEAP row arrays through metadata, but refuses malformed and repeated fields', () => {
    expect(housingRows({ count: 1, metaData: [{ name: 'id' }, { name: 'code' }], result: [['fixture', CODE]] }).rows).toEqual([{ id: 'fixture', code: CODE }]);
    expect(() => housingRows({ count: 1, metaData: [{ name: 'id' }], result: [['fixture', CODE]] })).toThrow('字段无法对应');
    expect(() => housingRows({ count: 1, metaData: [{ name: 'id' }, { name: 'id' }], result: [['fixture', CODE]] })).toThrow('字段重复');
    expect(() => housingRows({ count: 0, result: [{}] })).toThrow('结构不完整');
    expect(() => parseHousingRpc(encoded({ error: 'fixture secret business payload' }), false)).toThrow('业务错误');
  });
  it('uses the source city/district/street area scope without widening a street to its district', () => {
    expect(housingAreaPrefix('440300000000000000')).toBe('4403');
    expect(housingAreaPrefix('440305000000000000')).toBe('440305');
    expect(housingAreaPrefix(AREA)).toBe('440305009');
    expect(housingAcceptancePrefix('440300000000000000')).toBe('4403');
    expect(housingAcceptancePrefix('440305000000000000')).toBe('440305');
    expect(housingAcceptancePrefix(AREA)).toBe('440305009');
  });
});
