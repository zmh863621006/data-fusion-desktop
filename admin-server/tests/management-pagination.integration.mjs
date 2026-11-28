import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAdminServer } from '../app.mjs';
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'df-management-')), dataPath = join(dir, 'admin.sqlite');
  const server = createAdminServer({ dataPath, privateKey, initialPassword: password, captchaFactory, enterpriseProvider: async () => null, returnUploadsEnabled: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`; let cookie = '';
  async function api(path, body, method = body === undefined ? 'GET' : 'POST', auth = cookie) {
    const response = await fetch(origin + path, { method, headers: { cookie: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function login(username) { const input = await loginCaptcha(origin, { username, password }); return (await api('/api/admin/login', input.body, 'POST', input.token)).cookie; }
  cookie = await login('admin');
  const mutate = fn => { const db = new DatabaseSync(dataPath); try { return fn(db); } finally { db.close(); } };
  async function paused(path, auth, prefix = '{"name":') {
    let resolve, reject;
    const result = new Promise((r, j) => { resolve = r; reject = j; });
    const request = httpRequest(origin + path, { method: path.endsWith('/settings') ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json', cookie: auth } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.on('error', reject); request.write(prefix);
    await new Promise(resolve => setTimeout(resolve, 100));
    return { result, finish: suffix => request.end(suffix) };
  }
  return { api, login, mutate, paused };
}

test('revocation and role changes during a JSON body read cannot commit management writes', async t => {
  const f = await fixture(t);
  const operator = (await f.api('/api/admin/users', { username: 'fixture-operator', password, role: 'operator' })).body.id;
  const token = await f.login('fixture-operator');
  const pending = await f.paused('/api/admin/customers', token);
  assert.equal((await f.api(`/api/admin/users/${operator}`, { enabled: false }, 'PATCH')).status, 200);
  pending.finish('"must not exist"}');
  assert.equal((await pending.result).status, 401);
  assert.equal((await f.api('/api/admin/customers?name=must%20not%20exist')).body.total, 0);
  const second = (await f.api('/api/admin/users', { username: 'fixture-admin', password, role: 'admin' })).body.id;
  const secondToken = await f.login('fixture-admin');
  const setting = await f.paused('/api/admin/enterprises/settings', secondToken, '{"enabled":');
  // Keep the same session to prove role equality is checked, independently of session revocation.
  f.mutate(db => db.prepare("UPDATE admin_users SET role='operator' WHERE id=?").run(second));
  setting.finish('true}'); assert.equal((await setting.result).status, 403);
  assert.equal((await f.api('/api/admin/enterprises/settings')).body.enabled, false);
  assert.equal((await f.api('/api/admin/customers', { name: 'operator still allowed' }, 'POST', secondToken)).status, 201);
  const changingPassword = await f.paused('/api/admin/password', secondToken, `{"oldPassword":${JSON.stringify(password)},"newPassword":`);
  const previousHash = f.mutate(db => { const hash = db.prepare('SELECT password_hash FROM admin_users WHERE id=?').get(second).password_hash; db.prepare('DELETE FROM admin_sessions WHERE user_id=?').run(second); return hash; });
  changingPassword.finish('"ReplacedFixture!987"}'); assert.equal((await changingPassword.result).status, 403);
  assert.equal(f.mutate(db => db.prepare('SELECT password_hash FROM admin_users WHERE id=?').get(second).password_hash), previousHash);
});

test('compact bootstrap is bounded and management lists paginate, filter and preserve full legacy bootstrap', async t => {
  const f = await fixture(t), timestamp = Date.now();
  f.mutate(db => {
    for (let i = 0; i < 125; i++) {
      db.prepare('INSERT INTO customers(id,name,contact,enabled,created_at) VALUES(?,?,?,?,?)').run(`customer-${i}`, `客户 ${String(i).padStart(3, '0')}`, '备注', i === 0 ? 0 : 1, timestamp);
      db.prepare(`INSERT INTO licenses(id,customer_id,mode,expires_at,allowed_systems_json,allowed_matters_json,max_devices,created_at,status)
        VALUES(?,?,'online',?,?,?,1,?,?)`).run(`license-${i}`, `customer-${i}`, i === 2 ? timestamp - 1 : timestamp + 86400000, '["shenzhen-one-window"]', '{"shenzhen-one-window":["outdoor-advertising-approval"]}', timestamp, i === 1 ? 'revoked' : 'active');
      db.prepare('INSERT INTO devices(id,license_id,device_id,activated_at,last_seen_at) VALUES(?,?,?,?,?)').run(`device-${i}`, `license-${i}`, i.toString(16).padStart(64, '0'), timestamp, timestamp);
      db.prepare(`INSERT INTO updates(id,target_type,version,url,sha256,notes,published_at,enabled) VALUES(?,'app',?,'https://fixture.invalid/package',?,'fixture',?,1)`)
        .run(`update-${i}`, `8.0.${i}`, 'a'.repeat(64), timestamp);
    }
  });
  const compact = (await f.api('/api/admin/bootstrap?compact=1')).body;
  assert.equal(compact.paginated, true); for (const name of ['customers','licenses','devices','updates','audits']) assert.equal(compact[name].length, 0);
  assert.equal(compact.summary.customers, 125); assert.equal(compact.summary.activeLicenses, 122); assert.equal(compact.summary.activeDevices, 125);
  assert.equal(compact.summary.recentLicenses.length, 6); assert.equal(compact.summary.systemLicenseCounts['shenzhen-one-window'], 125);
  assert.equal((await f.api('/api/admin/bootstrap')).body.licenses.length, 125);
  for (const resource of ['customers', 'licenses', 'devices', 'updates']) {
    const first = (await f.api(`/api/admin/${resource}?page=1&pageSize=10`)).body;
    const second = (await f.api(`/api/admin/${resource}?page=2&pageSize=10`)).body;
    assert.equal(first.total, 125); assert.equal(first.rows.length, 10); assert.equal(second.rows.length, 10);
    assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 20);
    assert.equal((await f.api(`/api/admin/${resource}?pageSize=99999`)).body.rows.length, 100);
  }
  assert.equal((await f.api('/api/admin/customers?name=%25')).body.total, 0, 'search treats SQL wildcards literally');
  const fractional = (await f.api('/api/admin/customers?page=0.5&pageSize=0.5')).body;
  assert.equal(fractional.page, 1); assert.equal(fractional.rows.length, 1);
  assert.equal((await f.api('/api/admin/customers?name=004&enabled=1')).body.rows[0].id, 'customer-4');
  assert.equal((await f.api('/api/admin/licenses?status=customerDisabled')).body.rows[0].customer_enabled, 0);
  assert.equal((await f.api('/api/admin/licenses?status=expired')).body.rows[0].id, 'license-2');
  assert.equal((await f.api('/api/admin/licenses?status=revoked')).body.rows[0].id, 'license-1');
  assert.equal((await f.api('/api/admin/licenses?component=system%3Ashenzhen-one-window&status=active')).body.total, 122);
  const device = '000000000000…00000004';
  assert.equal((await f.api(`/api/admin/licenses?reference=${encodeURIComponent(device)}`)).body.rows[0].id, 'license-4');
  assert.equal((await f.api('/api/admin/devices?licenseId=license-4&status=active')).body.total, 1);
  assert.equal((await f.api('/api/admin/updates?platform=linux')).body.total, 0);
  assert.equal((await f.api('/api/admin/business-releases?paginated=1&page=1&pageSize=10')).body.total, 0);
});

test('catalog disabling only prevents new allocations and preserves existing valid return uploads', async t => {
  const f = await fixture(t), systemId = 'shenzhen-one-window', matterId = 'outdoor-advertising-approval';
  const customerId = (await f.api('/api/admin/customers', { name: '既有授权测试' })).body.id;
  const scope = { customerId, mode: 'online', expiresAt: Date.now() + 86400000, allowedSystems: [systemId], allowedMatters: { [systemId]: [matterId] }, allowExport: true };
  const issued = (await f.api('/api/admin/licenses', scope)).body, deviceId = 'b'.repeat(64);
  const proof = (await f.api('/api/activate', { key: issued.activationCode, deviceId })).body;
  f.mutate(db => { db.prepare('UPDATE systems SET enabled=0 WHERE id=?').run(systemId); db.prepare('UPDATE system_matters SET enabled=0 WHERE system_id=? AND id=?').run(systemId, matterId); });
  assert.equal((await f.api('/api/admin/licenses', scope)).status, 400);
  const input = { schema: 1, proof, deviceId, clientBatchId: randomUUID(), systemId, matterId, startedAt: Date.now() - 2000, finishedAt: Date.now() - 1000, rowCount: 0 };
  const prepared = await f.api('/api/returns/batches', input);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal((await f.api(`/api/admin/licenses/${issued.id}/revoke`, {})).status, 200);
  assert.equal((await f.api('/api/returns/batches', { ...input, clientBatchId: randomUUID() })).status, 403);
});
