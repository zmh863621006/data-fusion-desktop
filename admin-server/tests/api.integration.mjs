import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createAdminServer } from '../app.mjs';
import catalog from '../../src/plugins/government-info/matter-catalog.json' with { type: 'json' };
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
async function fixture(t, secureCookie = false) {
  const server = createAdminServer({ dataPath: ':memory:', privateKey, initialPassword: password, secureCookie, captchaFactory });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function api(path, body, method = body === undefined ? 'GET' : 'POST', cookieOverride = cookie, headers = {}) {
    if (path === '/api/admin/login') { const input=await loginCaptcha(base,body,cookieOverride,headers); body=input.body; cookieOverride=input.token; }
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: cookieOverride, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  const login = await api('/api/admin/login', { username: 'admin', password });
  assert.equal(login.status, 200); cookie = login.cookie.split(';')[0];
  const customer = await api('/api/admin/customers', { name: '测试单位' });
  async function license(extra = {}) {
    return api('/api/admin/licenses', { customerId: customer.body.id, mode: 'online', expiresAt: Date.now() + 86400000,
      allowedSystems: ['government-info'], allowedMatters: { 'government-info': catalog.map(m => m.id) }, maxDevices: 2, allowAutoUpdate: true, ...extra });
  }
  return { api, license, customerId: customer.body.id, login, base };
}
function grant(envelope) {
  assert.equal(verify('RSA-SHA256', Buffer.from(envelope.payload, 'base64url'), publicKey, Buffer.from(envelope.signature, 'base64url')), true);
  return JSON.parse(Buffer.from(envelope.payload, 'base64url'));
}

test('shared catalog exposes 18 department-grouped government matters; auth is required', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/admin/bootstrap', undefined, 'GET', '')).status, 401);
  const b = (await f.api('/api/admin/bootstrap')).body;
  const matters = b.matters.filter(m => m.system_id === 'government-info' && m.enabled);
  assert.equal(matters.length, 18); assert.equal(new Set(matters.map(m=>m.department_id)).size, 3);
  assert.deepEqual([...new Set(matters.map(m=>m.department_id))], ['water-affairs','urban-management','other']);
  assert.deepEqual(matters.map(m=>m.id).sort(), catalog.map(m=>m.id).sort());
  assert.equal((await f.license({ allowedMatters: { 'government-info': ['double-publicity-return'] } })).status, 400);
});

test('catalog migration preserves existing grants and is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-admin-test-'));
  const dataPath = join(directory, 'fixture.sqlite');
  async function boot() {
    const server = createAdminServer({ dataPath, privateKey, initialPassword: password });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    await new Promise(resolve => server.close(resolve));
  }
  try {
    await boot();
    let db = new DatabaseSync(dataPath);
    db.prepare('INSERT INTO customers(id,name,created_at) VALUES(?,?,?)').run('legacy-customer','fixture',1);
    db.prepare("INSERT INTO licenses(id,customer_id,mode,expires_at,allowed_systems_json,allowed_matters_json,created_at) VALUES('legacy','legacy-customer','online',?, ?, ?,1)")
      .run(Date.now()+86400000,JSON.stringify(['government-info']),JSON.stringify({'government-info':['double-publicity-return']}));
    db.prepare("INSERT INTO system_matters(id,system_id,name,created_at) VALUES('double-publicity-return','government-info','legacy',1)").run();
    db.close(); await boot(); await boot();
    db = new DatabaseSync(dataPath,{readOnly:true});
    assert.equal(JSON.parse(db.prepare("SELECT allowed_matters_json FROM licenses WHERE id='legacy'").get().allowed_matters_json)['government-info'].length,18);
    assert.equal(db.prepare("SELECT count(*) n FROM system_matters WHERE system_id='government-info' AND enabled=1").get().n,18);
    assert.equal(db.prepare("SELECT enabled FROM system_matters WHERE id='double-publicity-return'").get().enabled,0);
    assert.equal(db.prepare('SELECT count(*) n FROM customers').get().n,1); db.close();
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.startsWith(join(tmpdir(),'fusion-admin-test-'))) throw new Error('Unexpected test directory');
    await rm(directory,{recursive:true,force:true});
  }
});

test('multiple devices, activation retry, capacity and controlled replacement', async t => {
  const f = await fixture(t); const l = await f.license(); assert.equal(l.status, 201);
  const one = 'a'.repeat(64), two = 'b'.repeat(64), three = 'c'.repeat(64);
  const first = await f.api('/api/activate', { key: l.body.activationCode, deviceId: one }, 'POST', '');
  assert.equal(first.status, 200); assert.equal(grant(first.body).deviceId, one);
  assert.equal((await f.api('/api/activate', { key: l.body.activationCode, deviceId: one }, 'POST', '')).status, 200);
  assert.equal((await f.api('/api/activate', { key: l.body.activationCode, deviceId: two }, 'POST', '')).status, 403);
  const extra = await f.api(`/api/admin/licenses/${l.body.id}/codes`, {}); assert.equal(extra.status, 201);
  assert.equal((await f.api('/api/activate', { key: extra.body.activationCode, deviceId: two }, 'POST', '')).status, 200);
  assert.equal((await f.api(`/api/admin/licenses/${l.body.id}/codes`, {})).status, 409);
  const device = (await f.api('/api/admin/bootstrap')).body.devices.find(d=>d.device_id===one);
  assert.equal((await f.api(`/api/admin/devices/${device.id}/revoke`, {})).status, 200);
  assert.equal((await f.api('/api/activate', { key: l.body.activationCode, deviceId: one }, 'POST', '')).status, 403);
  const replacement = await f.api(`/api/admin/licenses/${l.body.id}/codes`, {});
  assert.equal((await f.api('/api/activate', { key: replacement.body.activationCode, deviceId: three }, 'POST', '')).status, 200);
});

test('reissue invalidates unused old code, disabled customers cannot activate/refresh/update', async t => {
  const f = await fixture(t); const l = await f.license();
  const code = await f.api(`/api/admin/licenses/${l.body.id}/codes`, {});
  const deviceId = 'a'.repeat(64);
  assert.equal((await f.api('/api/activate', { key: l.body.activationCode, deviceId }, 'POST', '')).status, 403);
  assert.equal((await f.api('/api/activate', { key: code.body.activationCode, deviceId }, 'POST', '')).status, 200);
  assert.equal((await f.api(`/api/admin/customers/${f.customerId}`, { enabled: false }, 'PATCH')).status, 200);
  assert.equal((await f.api('/api/activate', { key: code.body.activationCode, deviceId }, 'POST', '')).status, 403);
  assert.equal((await f.api('/api/license/status', { licenseId: l.body.id, deviceId }, 'POST', '')).status, 403);
  assert.equal((await f.api(`/api/updates/manifest?licenseId=${l.body.id}&deviceId=${deviceId}`, undefined, 'GET', '')).status, 403);
});

test('offline devices are recorded, keys can be reissued after renewal, invalid limits rejected', async t => {
  const f = await fixture(t); const deviceId = 'd'.repeat(64);
  assert.equal((await f.license({ maxDevices: 1.5 })).status, 400);
  assert.equal((await f.license({ mode: 'offline', deviceId, maxDevices: 2 })).status, 400);
  const l = await f.license({ mode: 'offline', deviceId, maxDevices: 1 }); assert.equal(l.status, 201);
  const b = (await f.api('/api/admin/bootstrap')).body;
  assert.equal(b.devices.find(d=>d.license_id===l.body.id).device_id, deviceId);
  const expiresAt = Date.now()+86400000*3;
  assert.equal((await f.api(`/api/admin/licenses/${l.body.id}/renew`, { expiresAt })).status, 200);
  const key = await f.api(`/api/admin/licenses/${l.body.id}/offline-key`, {}); assert.equal(key.status, 200);
  const envelope = JSON.parse(Buffer.from(key.body.offlineKey.slice(5), 'base64url'));
  assert.equal(grant(envelope).expiresAt, expiresAt); assert.equal(grant(envelope).deviceId, deviceId);
  assert.equal((await f.api('/api/license/status', { licenseId: l.body.id, deviceId }, 'POST', '')).status, 403);
});

test('viewer cannot mutate; password/role changes revoke sessions; last administrator is protected', async t => {
  const f = await fixture(t);
  const created = await f.api('/api/admin/users', { username: 'reader', password, role: 'viewer' }); assert.equal(created.status, 201);
  const login = await f.api('/api/admin/login', { username: 'reader', password }); const cookie = login.cookie.split(';')[0];
  assert.equal((await f.api('/api/admin/customers', { name: 'denied' }, 'POST', cookie)).status, 403);
  assert.equal((await f.api('/api/admin/users', undefined, 'GET', cookie)).status, 403);
  const users = (await f.api('/api/admin/users')).body;
  assert.equal((await f.api(`/api/admin/users/${users.find(u=>u.username==='admin').id}`, { enabled: false }, 'PATCH')).status, 409);
  assert.equal((await f.api(`/api/admin/users/${created.body.id}`, { enabled: false }, 'PATCH')).status, 200);
  assert.equal((await f.api('/api/admin/bootstrap', undefined, 'GET', cookie)).status, 401);
  assert.equal((await f.api('/api/admin/password', { oldPassword: password, newPassword: 'New-fixture-password-2026!' })).status, 200);
  assert.equal((await f.api('/api/admin/bootstrap')).status, 401);
});

test('login throttling, secure cookie, CSRF and safe request errors', async t => {
  const f = await fixture(t, true);
  assert.match(f.login.cookie, /; Secure/);
  assert.equal((await f.api('/api/admin/customers', { name: 'denied' }, 'POST', undefined, { origin: 'https://evil.invalid' })).status, 403);
  for (let i=0;i<5;i++) assert.equal((await f.api('/api/admin/login', { username:'admin', password:'incorrect' })).status, i===4 ? 429 : 401);
  assert.equal((await f.api('/api/admin/login', { username:'admin', password })).status, 429);
  const invalid = await fetch(f.base+'/api/activate', { method:'POST', body:'{' });
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error, '请求必须为 JSON 对象');
});

test('audit history paginates and update manifest selects highest version rather than latest insertion', async t => {
  const f = await fixture(t);
  for(let i=0;i<23;i++) await f.api('/api/admin/customers', { name:`fixture-${i}` });
  const first = await f.api('/api/admin/audits?page=1&action=customer.created');
  const second = await f.api('/api/admin/audits?page=2&action=customer.created');
  assert.equal(first.body.rows.length,20); assert.equal(second.body.rows.length,4); assert.equal(first.body.total,24);
  for(const version of ['2.0.0','1.0.0']) assert.equal((await f.api('/api/admin/updates',{version,url:'https://example.invalid/app.exe',sha256:'a'.repeat(64),confirmPassword:password})).status,201);
  assert.equal((await f.api('/api/admin/updates',{version:'1.0.0garbage',url:'https://example.invalid/app.exe',sha256:'a'.repeat(64),confirmPassword:password})).status,400);
  const l = await f.license(); const deviceId='e'.repeat(64);
  const activated=await f.api('/api/activate',{key:l.body.activationCode,deviceId},'POST','');
  const manifest=await f.api('/api/updates/manifest',{licenseId:l.body.id,deviceId,proof:activated.body},'POST','');
  assert.equal(grant(manifest.body).app.version,'2.0.0');
});
