import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAdminServer } from '../app.mjs';
import catalog from '../../src/plugins/shenzhen-hazardous-chemicals/matter-catalog.json' with { type: 'json' };
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';

const SYSTEM = 'shenzhen-hazardous-chemicals';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

async function fixture(t) {
  let paid = 0;
  const server = createAdminServer({ dataPath: ':memory:', privateKey, initialPassword: password, captchaFactory,
    enterpriseProvider: async () => { paid++; return null; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function api(path, body, authenticated = true, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + path, { method,
      headers: { 'content-type': 'application/json', cookie: authenticated ? cookie : '' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const login = await loginCaptcha(base, { username: 'admin', password });
  const response = await fetch(base + '/api/admin/login', { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: login.token }, body: JSON.stringify(login.body) });
  assert.equal(response.status, 200);
  cookie = response.headers.getSetCookie().find(value => value.startsWith('df_admin=')).split(';')[0];
  const customer = await api('/api/admin/customers', { name: '危化品组件本地测试单位' });
  assert.equal(customer.status, 201);
  const issue = extra => api('/api/admin/licenses', { customerId: customer.body.id, mode: 'online',
    expiresAt: Date.now() + 86_400_000, maxDevices: 1, allowedSystems: [SYSTEM],
    allowedMatters: { [SYSTEM]: catalog.map(matter => matter.id) }, allowExport: true, ...extra });
  return { api, issue, paid: () => paid };
}

function grant(envelope) {
  assert.equal(verify('RSA-SHA256', Buffer.from(envelope.payload, 'base64url'), publicKey,
    Buffer.from(envelope.signature, 'base64url')), true);
  return JSON.parse(Buffer.from(envelope.payload, 'base64url'));
}

test('hazardous catalog exposes five ordered matters with independent system authorization', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/admin/bootstrap', undefined, false)).status, 401);
  const bootstrap = (await f.api('/api/admin/bootstrap')).body;
  assert.equal(bootstrap.systems.find(system => system.id === SYSTEM)?.name, '危化品管理');
  const matters = bootstrap.matters.filter(matter => matter.system_id === SYSTEM);
  assert.equal(matters.length, 5);
  assert.equal(new Set(matters.map(matter => matter.id)).size, 5);
  assert.deepEqual(matters.map(matter => ({ id: matter.id, name: matter.name, departmentId: matter.department_id,
    departmentName: matter.department_name, departmentOrder: matter.department_order, matterOrder: matter.matter_order })),
  [...catalog].sort((a, b) => a.departmentOrder - b.departmentOrder || a.matterOrder - b.matterOrder || a.name.localeCompare(b.name))
    .map(({ id, name, departmentId, departmentName, departmentOrder, matterOrder }) => ({ id, name, departmentId, departmentName, departmentOrder, matterOrder })));
  assert.equal((await f.issue({ allowedMatters: { [SYSTEM]: [] } })).status, 400);
  assert.equal((await f.issue({ allowedMatters: { [SYSTEM]: ['business-application-query'] } })).status, 400);
  const issued = await f.issue({ allowedMatters: { [SYSTEM]: [catalog[0].id] } });
  assert.equal(issued.status, 201);
  const deviceId = 'd'.repeat(64);
  const activation = await f.api('/api/activate', { key: issued.body.activationCode, deviceId }, false);
  assert.equal(activation.status, 200);
  assert.deepEqual(grant(activation.body).allowedSystems, [SYSTEM]);
  assert.deepEqual(grant(activation.body).allowedMatters, { [SYSTEM]: [catalog[0].id] });
  const refreshed = await f.api('/api/license/status', { licenseId: issued.body.id, deviceId, proof: activation.body }, false);
  assert.equal(refreshed.status, 200);
  assert.deepEqual(grant(refreshed.body).allowedMatters, { [SYSTEM]: [catalog[0].id] });
});

test('existing licenses can explicitly add hazardous matters through the normal scope editor', async t => {
  const f = await fixture(t);
  const issued = await f.issue({ allowedSystems: ['market-access'], allowedMatters: { 'market-access': ['business-application-query'] } });
  assert.equal(issued.status, 201);
  const expectedScope = { allowedSystems: ['market-access'], allowedTools: [], allowedMatters: { 'market-access': ['business-application-query'] } };
  const expanded = { allowedSystems: ['market-access', SYSTEM], allowedTools: [],
    allowedMatters: { ...expectedScope.allowedMatters, [SYSTEM]: [catalog[0].id] }, expectedScope };
  const change = await f.api(`/api/admin/licenses/${issued.body.id}/scope`, expanded);
  assert.equal(change.status, 200);
  assert.equal(change.body.changed, true);
  const proof = await f.api('/api/activate', { key: issued.body.activationCode, deviceId: 'e'.repeat(64) }, false);
  assert.equal(proof.status, 200);
  assert.deepEqual(grant(proof.body).allowedSystems, expanded.allowedSystems);
  assert.deepEqual(grant(proof.body).allowedMatters, expanded.allowedMatters);
});

test('hazardous enterprise supplement requires the selected matter and a live licensed device', async t => {
  const f = await fixture(t), selected = catalog[0].id;
  const issued = await f.issue({ allowedMatters: { [SYSTEM]: [selected] } });
  const deviceId = 'f'.repeat(64);
  const proof = (await f.api('/api/activate', { key: issued.body.activationCode, deviceId }, false)).body;
  const body = { proof, deviceId, systemId: SYSTEM, matterId: selected, items: [{ name: '危化品本地测试企业' }] };
  const resolved = await f.api('/api/enterprises/resolve', body, false);
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.results[0].status, 'pending');
  assert.equal(f.paid(), 0, 'Paid resolution remains disabled until explicitly enabled');
  assert.equal((await f.api('/api/enterprises/resolve', { ...body, matterId: catalog[1].id }, false)).status, 403);
  assert.equal((await f.api('/api/enterprises/resolve', { ...body, proof: undefined }, false)).status, 403);
  assert.equal((await f.api('/api/enterprises/resolve', { ...body, deviceId: '0'.repeat(64) }, false)).status, 403);
  assert.equal((await f.api('/api/enterprises/resolve', { ...body, systemId: 'government-info' }, false)).status, 403);
  const device = (await f.api('/api/admin/bootstrap')).body.devices[0];
  assert.equal((await f.api(`/api/admin/devices/${device.id}/revoke`, {})).status, 200);
  assert.equal((await f.api('/api/enterprises/resolve', body, false)).status, 403);
});

test('repeated hazardous registration preserves existing license scope and disabled metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-hazardous-catalog-'));
  const dataPath = join(directory, 'fixture.sqlite');
  const boot = async () => {
    const server = createAdminServer({ dataPath, privateKey, initialPassword: password });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => server.close(resolve));
  };
  let db;
  try {
    await boot();
    db = new DatabaseSync(dataPath);
    db.prepare('INSERT INTO customers(id,name,created_at) VALUES(?,?,?)').run('original', '原单位', 1);
    db.prepare(`INSERT INTO licenses(id,customer_id,mode,expires_at,allowed_systems_json,allowed_matters_json,created_at)
      VALUES('existing','original','online',?,'["market-access"]','{"market-access":["business-application-query"]}',1)`).run(Date.now() + 86_400_000);
    const previous = { ...db.prepare("SELECT * FROM licenses WHERE id='existing'").get() };
    db.prepare('UPDATE systems SET name=?, enabled=0 WHERE id=?').run('深圳市危险化学品安全生产风险监测预警系统', SYSTEM);
    db.prepare('UPDATE system_matters SET enabled=0 WHERE system_id=? AND id=?').run(SYSTEM, catalog[0].id);
    db.close(); db = undefined;
    await boot(); await boot();
    db = new DatabaseSync(dataPath, { readOnly: true });
    assert.deepEqual({ ...db.prepare("SELECT * FROM licenses WHERE id='existing'").get() }, previous);
    assert.deepEqual({ ...db.prepare('SELECT name, enabled FROM systems WHERE id=?').get(SYSTEM) }, { name: '危化品管理', enabled: 0 });
    assert.equal(db.prepare('SELECT enabled FROM system_matters WHERE system_id=? AND id=?').get(SYSTEM, catalog[0].id).enabled, 0);
    assert.equal(db.prepare('SELECT count(*) count FROM system_matters WHERE system_id=?').get(SYSTEM).count, 5);
    db.close(); db = undefined;
  } finally {
    db?.close();
    const absolute = resolve(directory);
    if (dirname(absolute) !== resolve(tmpdir()) || !absolute.startsWith(join(tmpdir(), 'fusion-hazardous-catalog-'))) throw new Error('Unexpected hazardous test directory');
    await rm(absolute, { recursive: true, force: true });
  }
});
