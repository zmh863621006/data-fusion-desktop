import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createAdminServer } from '../app.mjs';
import { validCreditCode, aliyunProvider, createEnterpriseStore } from '../enterprises.mjs';
import catalog from '../../src/plugins/government-info/matter-catalog.json' with { type: 'json' };
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';

const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY';
function credit(prefix) { return prefix + alphabet[(31 - [1,3,9,27,19,26,16,17,20,29,25,13,8,24,10,30,28].reduce((s,w,i) => s + alphabet.indexOf(prefix[i])*w, 0)%31)%31]; }
const code = credit('91440300123456789'), otherCode = credit('91440300987654321');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
async function fixture(t, provider) {
  const server = createAdminServer({ dataPath: ':memory:', privateKey, initialPassword: password, enterpriseProvider: provider, captchaFactory });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  let cookie = '';
  async function api(path, body, method = body === undefined ? 'GET' : 'POST', token = cookie) {
    if (path === '/api/admin/login') { const input=await loginCaptcha(`http://127.0.0.1:${server.address().port}`,body,token); body=input.body; token=input.token; }
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { cookie: token, 'content-type':'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  cookie = (await api('/api/admin/login', { username:'admin', password })).cookie;
  const base = '/api/admin/enterprises';
  const add = async (name, creditCode = '') => (await api(base, { name, creditCode })).body.requestId;
  async function run(ids) {
    const response = await api(`${base}/query`, { ids }); assert.equal(response.status,202);
    for (let i=0;i<100;i++) {
      const settings = (await api(`${base}/settings`)).body;
      if (!settings.job.running) return;
      await new Promise(resolve => setTimeout(resolve,5));
    }
    throw new Error('Batch did not finish');
  }
  const rows = async () => (await api(base)).body.rows;
  return { api, base, add, run, rows };
}

test('enterprise name first, code fallback, canonical cache and alias evidence', async t => {
  const calls = [];
  const f = await fixture(t, async keyword => { calls.push(keyword); return keyword === code ? { name:'标准企业有限公司',creditCode:code,legalPerson:'测试法人' } : null; });
  assert.equal(validCreditCode(code), true); assert.equal(validCreditCode('123'), false);
  const id = await f.add('错字企业有限公司', code);
  assert.equal((await f.api(`${f.base}/query`,{ids:[id]})).status,409); assert.equal(calls.length,0);
  await f.api(`${f.base}/settings`,{enabled:true},'PATCH'); await f.run([id]);
  assert.deepEqual(calls,['错字企业有限公司',code]);
  let row = (await f.rows())[0]; assert.equal(row.name,'错字企业有限公司'); assert.equal(row.standard_name,'标准企业有限公司'); assert.equal(row.status,'success');
  const alias = await f.add('错字企业有限公司');
  row = (await f.rows()).find(r=>r.id===alias); assert.equal(row.status,'success'); assert.equal(row.standard_code,code);
  const canonical = await f.add('标准企业有限公司',code);
  assert.equal((await f.rows()).find(r=>r.id===canonical).status,'success'); assert.equal(calls.length,2);
  const history = (await f.api(`${f.base}/${id}/history`)).body;
  assert.ok(history.some(h=>h.source==='aliyun-code' && h.after_json.includes('测试法人')));
});

test('name success avoids code request; service errors never count as wrong names or cause fallback', async t => {
  const calls=[];
  const f=await fixture(t, async keyword=> { calls.push(keyword); if(keyword==='异常公司') throw new Error('secret upstream response'); return {name:keyword,creditCode:code,legalPerson:'法人'}; });
  await f.api(`${f.base}/settings`,{enabled:true},'PATCH');
  const id=await f.add('正确公司',code); await f.run([id]); assert.deepEqual(calls,['正确公司']);
  const errorId=await f.add('异常公司',otherCode); await f.run([errorId]);
  const row=(await f.rows()).find(r=>r.id===errorId); assert.equal(row.status,'error'); assert.ok(!row.reason.includes('secret'));
  assert.deepEqual(calls,['正确公司','异常公司']);
  await f.run([errorId]); assert.equal(calls.length,2,'one-minute cooldown');
});

test('manual corrections propagate aliases; conflicting codes and ambiguous names require review', async t => {
  const f=await fixture(t, async()=>null);
  const id=await f.add('原始公司',code);
  assert.equal((await f.api(`${f.base}/${id}`,{name:'标准公司',creditCode:code,legalPerson:'甲'},'PATCH')).status,200);
  const alias=await f.add('别名公司',code); assert.equal((await f.rows()).find(r=>r.id===alias).status,'success');
  await f.api(`${f.base}/${id}`,{name:'标准公司',creditCode:code,legalPerson:'乙'},'PATCH');
  assert.equal((await f.rows()).find(r=>r.id===alias).legal_person,'乙');
  const conflict=await f.add('标准公司',otherCode); assert.equal((await f.rows()).find(r=>r.id===conflict).status,'review');
  assert.equal((await f.api(`${f.base}/${conflict}`,{name:'标准公司',creditCode:code,legalPerson:'乙'},'PATCH')).status,400);
  assert.equal((await f.api(`${f.base}/${id}`,{name:'标准公司',creditCode:'123',legalPerson:'乙'},'PATCH')).status,400);
  const two=await f.add('第二公司',otherCode);
  await f.api(`${f.base}/${two}`,{name:'标准公司',creditCode:otherCode,legalPerson:'丙'},'PATCH');
  const ambiguous=await f.add('标准公司'); assert.equal((await f.rows()).find(r=>r.id===ambiguous).status,'review');
});

test('viewer cannot mutate and operator cannot enable paid access; bounded batches and pagination', async t=>{
  const f=await fixture(t,async()=>null);
  for(const role of ['viewer','operator']) {
    await f.api('/api/admin/users',{username:role,password,role});
    const token=(await f.api('/api/admin/login',{username:role,password})).cookie;
    assert.equal((await f.api(`${f.base}/settings`,{enabled:true},'PATCH',token)).status,403);
    if(role==='viewer') {
      assert.equal((await f.api(f.base,{name:'测试'},'POST',token)).status,403);
      assert.equal((await f.api(`${f.base}/query`,{ids:['x']},'POST',token)).status,403);
    }
  }
  assert.equal((await f.api(f.base,undefined,'GET','')).status,401);
  for(let i=0;i<22;i++) await f.add(`测试企业${i}`);
  assert.equal((await f.rows()).length,20);
  assert.equal((await f.api(`${f.base}?page=2`)).body.rows.length,2);
  await f.api(`${f.base}/settings`,{enabled:true},'PATCH');
  assert.equal((await f.api(`${f.base}/query`,{ids:Array(21).fill('x')})).status,400);
});

test('client requires signed proof and live device/system entitlement; disabled paid access remains cache-only',async t=>{
  let paid=0; const f=await fixture(t,async()=>{paid++;return null;});
  const customer=(await f.api('/api/admin/customers',{name:'测试客户'})).body.id;
  const issued=(await f.api('/api/admin/licenses',{customerId:customer,mode:'online',maxDevices:1,expiresAt:Date.now()+86400000,allowedSystems:['government-info'],allowedMatters:{'government-info':catalog.map(m=>m.id)}})).body;
  const deviceId='a'.repeat(64);
  const proof=(await f.api('/api/activate',{key:issued.activationCode,deviceId})).body;
  const body={proof,deviceId,systemId:'government-info',matterId:catalog[0].id,items:[{name:'客户企业',applicantCode:code}]};
  assert.equal((await f.api('/api/enterprises/resolve',{...body,proof:undefined})).status,403);
  assert.equal((await f.api('/api/enterprises/resolve',{...body,deviceId:'b'.repeat(64)})).status,403);
  assert.equal((await f.api('/api/enterprises/resolve',{...body,systemId:'online-car-permit'})).status,403);
  const resolved=await f.api('/api/enterprises/resolve',body); assert.equal(resolved.status,200); assert.equal(resolved.body.results[0].status,'pending'); assert.equal(paid,0);
  const id=resolved.body.results[0].requestId;
  await f.api(`${f.base}/${id}`,{name:'规范客户企业',creditCode:code,legalPerson:'测试法人'},'PATCH');
  const cached=await f.api('/api/enterprises/resolve',body); assert.equal(cached.body.results[0].enterprise.name,'规范客户企业'); assert.equal(paid,0);
  const device=(await f.api('/api/admin/bootstrap')).body.devices[0]; await f.api(`/api/admin/devices/${device.id}/revoke`,{});
  assert.equal((await f.api('/api/enterprises/resolve',body)).status,403);
});

test('licensed client awaits server-side Aliyun fallback and tool scope is authorized separately from systems', async t => {
  const calls=[];
  const f=await fixture(t,async keyword=>{calls.push(keyword);return keyword===code ? {name:'标准公司',creditCode:code,legalPerson:'云端法人'} : null;});
  await f.api(`${f.base}/settings`,{enabled:true},'PATCH');
  const customer=(await f.api('/api/admin/customers',{name:'工具客户'})).body.id;
  const issued=(await f.api('/api/admin/licenses',{customerId:customer,mode:'online',maxDevices:1,expiresAt:Date.now()+86400000,allowedSystems:[],allowedTools:['health-publicity']})).body;
  const deviceId='c'.repeat(64), proof=(await f.api('/api/activate',{key:issued.activationCode,deviceId})).body;
  const body={proof,deviceId,systemId:'health-publicity',matterId:'word-to-publicity',items:[{name:'错字门诊部',creditCode:code}]};
  const resolved=await f.api('/api/enterprises/resolve',body);
  assert.equal(resolved.status,200);assert.equal(resolved.body.results[0].status,'success');assert.equal(resolved.body.results[0].enterprise.legalPerson,'云端法人');
  assert.deepEqual(calls,['错字门诊部',code]);
  const cached=await f.api('/api/enterprises/resolve',body);assert.equal(cached.body.results[0].status,'success');assert.equal(calls.length,2);
  assert.equal((await f.api('/api/enterprises/resolve',{...body,matterId:'unknown'})).status,403);
  assert.equal((await f.api('/api/enterprises/resolve',{...body,systemId:'oversize-transport',matterId:'oversize-transport-return'})).status,403);
  const history=(await f.api(`${f.base}/${resolved.body.results[0].requestId}/history`)).body;
  assert.ok(history.some(entry=>entry.source==='aliyun-code' && entry.actor.startsWith('client:') && entry.after_json.includes('云端法人')));
});

function storeFixture(t, provider) {
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  let clock=Date.now();
  const options={provider,configured:true,audit:()=>{},now:()=>clock,transaction:work=>{
    db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
  }};
  const store=createEnterpriseStore(db,options);db.prepare('UPDATE enterprise_settings SET enabled=1').run();
  t.after(()=>{store.close();db.close();});
  return {db,store,options,advance:duration=>{clock+=duration;},resolve:(items,source='government-info')=>store.resolve(items,source,{username:'client:test-device'})};
}

test('cached missing legal person or code is completed, persisted and then reused without a provider call', async t => {
  const calls=[];const f=storeFixture(t,async keyword=>{calls.push(keyword);return{name:'部分公司',creditCode:code,legalPerson:'补全法人'};});
  f.db.prepare('INSERT INTO enterprises VALUES(?,?,?,?,?,?)').run('partial','部分公司',code,'','legacy',1);
  const completed=await f.resolve([{name:'部分公司',creditCode:code}]);
  assert.equal(completed[0].status,'success');assert.equal(completed[0].enterprise.legalPerson,'补全法人');assert.deepEqual(calls,['部分公司']);
  await f.resolve([{name:'部分公司'}]);assert.equal(calls.length,1);
  f.db.prepare('DELETE FROM enterprise_requests').run();f.db.prepare('DELETE FROM enterprises').run();
  f.db.prepare('INSERT INTO enterprises VALUES(?,?,?,?,?,?)').run('missing-code','部分公司','','已有法人','legacy',1);
  const missingCode=await f.resolve([{name:'部分公司'}]);
  assert.equal(missingCode[0].status,'review','conflicting legal persons are preserved for review');
  assert.equal(f.db.prepare('SELECT legal_person FROM enterprises').get().legal_person,'已有法人');
  f.db.prepare('UPDATE enterprises SET legal_person=?').run('补全法人');
  f.db.prepare("UPDATE enterprise_requests SET status='partial',queried_at=NULL,reason=''").run();
  f.advance(60_000+1);
  const repaired=await f.resolve([{name:'部分公司'}]);
  assert.equal(repaired[0].status,'success');assert.equal(repaired[0].enterprise.creditCode,code);
  assert.equal(f.db.prepare('SELECT count(*) n FROM enterprises').get().n,1,'repair incomplete entity in place instead of leaving an ambiguous alias');
  assert.equal(calls.length,1,'successful provider keyword response is reused');
});

test('in-flight requests and repeated aliases deduplicate cloud calls; misses/errors survive store restart cooldown', async t => {
  const calls=[];
  const f=storeFixture(t,async keyword=>{calls.push(keyword);await new Promise(resolve=>setTimeout(resolve,10));if(keyword==='异常企业')throw new Error('do not expose provider secret');return null;});
  const input={name:'空结果公司',creditCode:code};
  const [one,two]=await Promise.all([f.resolve([input,input]),f.resolve([input])]);
  assert.equal(one[0].status,'not_found');assert.equal(two[0].status,'not_found');assert.deepEqual(calls,['空结果公司',code]);
  await f.resolve([{name:'另一空结果公司',creditCode:code}]);assert.deepEqual(calls,['空结果公司',code,'另一空结果公司']);
  const failed=await f.resolve([{name:'异常企业',creditCode:otherCode}]);assert.equal(failed[0].status,'error');assert.ok(!failed[0].reason.includes('secret'));assert.equal(calls.at(-1),'异常企业');
  f.store.close();const resumed=createEnterpriseStore(f.db,f.options);
  await resumed.resolve([input,{name:'异常企业',creditCode:otherCode}],'government-info',{username:'client:test'});assert.equal(calls.length,4);
  f.advance(15*60_000+1);await resumed.resolve([{name:'异常企业',creditCode:otherCode}],'government-info',{username:'client:test'});assert.equal(calls.length,5);
  resumed.close();
});

test('90 companies resolve with bounded provider concurrency and the minute budget protects additional requests', async t => {
  let active=0,maximum=0,calls=0;
  const f=storeFixture(t,async keyword=>{active++;maximum=Math.max(maximum,active);calls++;await new Promise(resolve=>setTimeout(resolve,1));active--;
    if(keyword.startsWith('错字'))return null;return{name:`标准企业${keyword}`,creditCode:keyword,legalPerson:'法人'};});
  const inputs=Array.from({length:90},(_,i)=>({name:`错字企业${i}`,creditCode:credit('91440300'+String(i).padStart(9,'0'))}));
  const results=await f.resolve(inputs);assert.equal(results.length,90);assert.ok(results.every(value=>value.status==='success'));assert.equal(calls,180);assert.ok(maximum<=4);
  await f.resolve(inputs);assert.equal(calls,180);
  for(let i=0;i<60;i++)f.db.prepare('INSERT INTO enterprise_provider_queries(keyword,status,result_json,queried_at) VALUES(?,?,?,?)').run(`limit-${i}`,'not_found','',Date.now());
  const limited=await f.resolve([{name:'预算限制企业'}]);assert.equal(limited[0].status,'pending');assert.match(limited[0].reason,/安全限额/);assert.equal(calls,180);
});

test('oversize exact credit-code cache ignores conflicting names and ambiguous aliases without a provider call', async t => {
  const calls=[];const f=storeFixture(t,async keyword=>{calls.push(keyword);return null;});
  f.db.prepare('INSERT INTO enterprises VALUES(?,?,?,?,?,?)').run('correct','同名运输公司',code,'正确法人','manual',1);
  f.db.prepare('INSERT INTO enterprises VALUES(?,?,?,?,?,?)').run('different','同名运输公司',otherCode,'另一法人','manual',1);
  const resolved=await f.resolve([{name:'同名运输公司',creditCode:code},{name:'过期错字名称',creditCode:code}],'oversize-transport');
  assert.ok(resolved.every(value=>value.status==='success' && value.enterprise.id==='correct' && value.enterprise.legalPerson==='正确法人'));
  assert.equal(calls.length,0);
  const ordinary=await f.resolve([{name:'同名运输公司',creditCode:otherCode}],'online-car-permit');
  assert.equal(ordinary[0].status,'review','other systems keep their existing name ambiguity rule');
  assert.equal(calls.length,0);
});

test('oversize valid source code queries only that code and can resolve despite a different cached name match', async t => {
  const calls=[];const f=storeFixture(t,async keyword=>{calls.push(keyword);return{name:'规范运输企业',creditCode:code,legalPerson:'源代码法人'};});
  f.db.prepare('INSERT INTO enterprises VALUES(?,?,?,?,?,?)').run('same-name','错误旧名称',otherCode,'不能使用的法人','manual',1);
  const resolved=await f.resolve([{name:'错误旧名称',creditCode:code}],'oversize-transport');
  assert.equal(resolved[0].status,'success');assert.equal(resolved[0].enterprise.creditCode,code);assert.equal(resolved[0].enterprise.legalPerson,'源代码法人');
  assert.deepEqual(calls,[code]);
  assert.equal(f.db.prepare('SELECT legal_person FROM enterprises WHERE id=?').get('same-name').legal_person,'不能使用的法人');
  const history=f.db.prepare('SELECT source FROM enterprise_history WHERE request_id=?').all(resolved[0].requestId);
  assert.ok(history.some(row=>row.source==='aliyun-code'));
});

test('oversize code miss never guesses by name, and code conflicts require review without replacing source evidence', async t => {
  const calls=[];const f=storeFixture(t,async keyword=>{calls.push(keyword);return keyword===code ? null : {name:'同名企业',creditCode:code,legalPerson:'其他企业法人'};});
  const missing=await f.resolve([{name:'同名企业',creditCode:code}],'oversize-transport');
  assert.equal(missing[0].status,'not_found');assert.equal(missing[0].enterprise,null);assert.match(missing[0].reason,/未按名称/);assert.deepEqual(calls,[code]);
  const conflict=await f.resolve([{name:'原系统企业',creditCode:otherCode}],'oversize-transport');
  assert.equal(conflict[0].status,'review');assert.match(conflict[0].reason,/原始有效信用代码冲突/);assert.equal(conflict[0].enterprise,null);
  assert.equal(f.db.prepare('SELECT credit_code FROM enterprise_requests WHERE id=?').get(conflict[0].requestId).credit_code,otherCode);
  assert.equal(f.db.prepare('SELECT count(*) n FROM enterprises').get().n,0);
  await f.resolve([{name:'原系统企业',creditCode:otherCode}],'oversize-transport');assert.deepEqual(calls,[code,otherCode],'review records do not automatically retry');
});

test('oversize absent or invalid code falls back to name; a validated applicant code is used before name', async t => {
  const calls=[];const f=storeFixture(t,async keyword=>{calls.push(keyword);return{name:keyword===otherCode ? '证件号运输企业' : keyword,creditCode:keyword===otherCode ? otherCode : code,legalPerson:'法人'};});
  const byName=await f.resolve([{name:'没有代码公司',creditCode:'123456'}],'oversize-transport');
  assert.equal(byName[0].status,'success');assert.deepEqual(calls,['没有代码公司']);
  const byApplicant=await f.resolve([{name:'旧名称',creditCode:'无效',applicantCode:otherCode}],'oversize-transport');
  assert.equal(byApplicant[0].status,'success');assert.equal(byApplicant[0].enterprise.creditCode,otherCode);assert.deepEqual(calls,['没有代码公司',otherCode]);
  const conflict=await f.resolve([{name:'冲突代码公司',creditCode:code,applicantCode:otherCode}],'oversize-transport');
  assert.equal(conflict[0].status,'review');assert.match(conflict[0].reason,/申请证件号不一致/);assert.equal(calls.length,2);
});

test('oversize uses the current resolve source, not the request creator or another strategy cooldown', async t => {
  const calls=[];const f=storeFixture(t,async keyword=>{calls.push(keyword);if(keyword==='跨系统错误名称')throw new Error('private provider error');return{name:'正确运输企业',creditCode:code,legalPerson:'法人'};});
  const input={name:'跨系统错误名称',creditCode:code};
  const first=await f.resolve([input],'government-info');assert.equal(first[0].status,'error');
  const second=await f.resolve([input],'oversize-transport');assert.equal(second[0].status,'success');assert.equal(second[0].requestId,first[0].requestId);
  assert.deepEqual(calls,['跨系统错误名称',code]);
  assert.equal(f.db.prepare('SELECT source_system FROM enterprise_requests WHERE id=?').get(first[0].requestId).source_system,'government-info');
  assert.deepEqual(f.db.prepare('SELECT strategy FROM enterprise_resolution_queries ORDER BY strategy').all().map(row=>row.strategy),['code-first','name-first']);
});

test('name-first not-found cooldown does not suppress oversize strategy, while shared provider misses remain cached', async t => {
  const calls=[];const f=storeFixture(t,async keyword=>{calls.push(keyword);return null;});const input={name:'尚未收录公司',creditCode:code};
  const ordinary=await f.resolve([input],'government-info');assert.equal(ordinary[0].status,'not_found');assert.deepEqual(calls,['尚未收录公司',code]);
  const oversize=await f.resolve([input],'oversize-transport');assert.equal(oversize[0].status,'not_found');assert.match(oversize[0].reason,/未按名称/);
  assert.equal(f.db.prepare('SELECT attempts FROM enterprise_requests').get().attempts,2,'the current code policy executes despite the earlier name policy cooldown');
  assert.equal(f.db.prepare('SELECT count(*) n FROM enterprise_resolution_queries').get().n,2);
  assert.deepEqual(calls,['尚未收录公司',code],'the global exact-code negative cache prevents another paid query');
  f.store.close();const resumed=createEnterpriseStore(f.db,f.options);
  await resumed.resolve([input],'oversize-transport',{username:'client:test'});assert.equal(f.db.prepare('SELECT attempts FROM enterprise_requests').get().attempts,2,'per-policy cooldown persists after restart');
  assert.equal(calls.length,2);resumed.close();
});

test('oversize partial code cache supplements the missing legal person by code and preserves existing canonical fields', async t => {
  const calls=[];const f=storeFixture(t,async keyword=>{calls.push(keyword);return{name:'规范企业',creditCode:code,legalPerson:'补充法人'};});
  f.db.prepare('INSERT INTO enterprises VALUES(?,?,?,?,?,?)').run('partial','规范企业',code,'','manual',1);
  const resolved=await f.resolve([{name:'错误企业名',creditCode:code}],'oversize-transport');
  assert.equal(resolved[0].status,'success');assert.equal(resolved[0].enterprise.id,'partial');assert.equal(resolved[0].enterprise.name,'规范企业');assert.equal(resolved[0].enterprise.legalPerson,'补充法人');assert.deepEqual(calls,[code]);
  await f.resolve([{name:'另一个别名',creditCode:code}],'oversize-transport');assert.equal(calls.length,1);
});

test('concurrent strategies do not share request execution/results while exact provider keywords remain globally deduplicated', async t => {
  const calls=[];const f=storeFixture(t,async keyword=>{calls.push(keyword);await new Promise(resolve=>setTimeout(resolve,10));if(keyword==='并发错误名称')throw new Error('private error');return{name:'规范并发运输公司',creditCode:code,legalPerson:'并发法人'};});
  const input={name:'并发错误名称',creditCode:code};
  const [ordinary,oversize]=await Promise.all([f.resolve([input],'online-car-permit'),f.resolve([input],'oversize-transport')]);
  assert.equal(ordinary[0].status,'error','first caller receives its own result rather than a later strategy success');
  assert.equal(oversize[0].status,'success');assert.equal(oversize[0].enterprise.creditCode,code);assert.deepEqual(calls,['并发错误名称',code]);
  const sharedCode=credit('91440300111111111');
  // Two aliases with the same source code must still share the global provider boundary.
  const concurrent=storeFixture(t,async keyword=>{calls.push(keyword);await new Promise(resolve=>setTimeout(resolve,10));return{name:'共享代码公司',creditCode:sharedCode,legalPerson:'共享法人'};});
  const [one,two]=await Promise.all([concurrent.resolve([{name:'别名一',creditCode:sharedCode}],'oversize-transport'),concurrent.resolve([{name:'别名二',creditCode:sharedCode}],'oversize-transport')]);
  assert.equal(one[0].status,'success');assert.equal(two[0].status,'success');assert.equal(calls.filter(value=>value===sharedCode).length,1);
});

test('oversize preserves an existing review and manual fields even when the provider responds during a correction', async t => {
  let release;const started=new Promise(resolve=>{release=resolve;});let finish;
  const f=storeFixture(t,async()=>{release();return new Promise(resolve=>{finish=resolve;});});
  const input={name:'人工维护公司',creditCode:code};const inflight=f.resolve([input],'oversize-transport');await started;
  const request=f.db.prepare('SELECT * FROM enterprise_requests').get();
  f.db.prepare('INSERT INTO enterprises VALUES(?,?,?,?,?,?)').run('manual','人工维护公司',code,'人工法人','manual',1);
  f.db.prepare("UPDATE enterprise_requests SET enterprise_id='manual',status='success' WHERE id=?").run(request.id);
  finish({name:'人工维护公司',creditCode:code,legalPerson:'云端不同法人'});
  const corrected=await inflight;assert.equal(corrected[0].status,'success');assert.equal(corrected[0].enterprise.legalPerson,'人工法人');
  f.db.prepare("UPDATE enterprise_requests SET status='review',reason='人工待核对' WHERE id=?").run(request.id);
  const protectedResult=await f.resolve([input],'oversize-transport');assert.equal(protectedResult[0].status,'review');assert.equal(protectedResult[0].reason,'人工待核对');assert.equal(protectedResult[0].enterprise,null);
});

test('authorized oversize client source selects code-first without adding a user-controlled priority field', async t => {
  const calls=[];const f=await fixture(t,async keyword=>{calls.push(keyword);return{name:'授权运输企业',creditCode:code,legalPerson:'法人'};});
  await f.api(`${f.base}/settings`,{enabled:true},'PATCH');
  const customer=(await f.api('/api/admin/customers',{name:'大件运输客户'})).body.id;
  const issued=(await f.api('/api/admin/licenses',{customerId:customer,mode:'online',maxDevices:1,expiresAt:Date.now()+86400000,allowedSystems:['oversize-transport'],allowedMatters:{'oversize-transport':['oversize-transport-return']}})).body;
  const deviceId='d'.repeat(64),proof=(await f.api('/api/activate',{key:issued.activationCode,deviceId})).body;
  const body={proof,deviceId,systemId:'oversize-transport',matterId:'oversize-transport-return',items:[{name:'旧运输企业名称',creditCode:code}]};
  const resolved=await f.api('/api/enterprises/resolve',body);assert.equal(resolved.status,200);assert.equal(resolved.body.results[0].status,'success');assert.deepEqual(calls,[code]);
  assert.equal((await f.api('/api/enterprises/resolve',{...body,systemId:'online-car-permit'})).status,403);
});

test('strategy cooldown migration is additive and idempotent without changing enterprise, request, history or provider cache rows', t => {
  const f=storeFixture(t,async()=>null);
  f.db.prepare('INSERT INTO enterprises VALUES(?,?,?,?,?,?)').run('existing','已维护公司',code,'已维护法人','manual',123);
  const request=f.store.register({name:'已维护公司',creditCode:code});
  f.db.prepare("UPDATE enterprise_requests SET status='review',reason='待人工核对',attempts=3,queried_at=456 WHERE id=?").run(request.requestId);
  f.db.prepare('INSERT INTO enterprise_provider_queries VALUES(?,?,?,?)').run(code,'not_found','',456);
  f.store.close();f.db.exec('DROP TABLE enterprise_resolution_queries');
  const tables=['enterprises','enterprise_requests','enterprise_history','enterprise_provider_queries','enterprise_settings'];
  const snapshot=()=>tables.map(table=>[table,JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all())]);
  const before=snapshot();
  const upgraded=createEnterpriseStore(f.db,f.options);assert.deepEqual(snapshot(),before);upgraded.close();
  assert.equal(f.db.prepare('SELECT count(*) n FROM enterprise_resolution_queries').get().n,0);
  const repeated=createEnterpriseStore(f.db,f.options);assert.deepEqual(snapshot(),before);repeated.close();
});

test('Aliyun adapter encodes keywords and separates HTTP/business/malformed failures from empty results',async()=>{
  let captured;
  const provider=aliyunProvider('fixture-only',async(url,options)=>{captured={url,options};return new Response(JSON.stringify({data:{data:{companyName:'测试公司',creditNo:code,legalPerson:'法人'}}}));});
  assert.equal((await provider('公司 & 名称')).creditCode,code);
  assert.equal(new URL(captured.url).searchParams.get('keyword'),'公司 & 名称'); assert.equal(captured.options.redirect,'error');
  assert.equal(await aliyunProvider('x',async()=>new Response(JSON.stringify({data:{data:{}}})))('x'),null);
  await assert.rejects(aliyunProvider('x',async()=>new Response('private',{status:403}))('x'),/HTTP 403/);
  await assert.rejects(aliyunProvider('x',async()=>new Response(JSON.stringify({code:500,msg:'private'})))('x'),/业务错误/);
  await assert.rejects(aliyunProvider('x',async()=>new Response('not json'))('x'),/格式异常/);
});
