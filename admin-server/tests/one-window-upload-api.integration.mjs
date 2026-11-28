import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createAdminServer } from '../app.mjs';
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';

const systemId = 'shenzhen-one-window', matterId = 'outdoor-advertising-approval';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-one-window-upload-api-'));
  const dataPath = join(directory, 'admin.sqlite');
  const storage = { prepare: row => ({ url: 'https://fixture.invalid/' + row.id, method: 'PUT', headers: {}, expiresAt: Date.now() + 600_000 }),
    verify: async () => {}, download: row => ({ url: 'https://fixture.invalid/' + row.id, expiresAt: Date.now() + 600_000 }) };
  const server = createAdminServer({ dataPath, privateKey, initialPassword: password, captchaFactory, oneWindowOssStorage: storage });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert(directory.startsWith(join(tmpdir(), 'fusion-one-window-upload-api-')));
    await rm(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  async function api(path, body, admin = false) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      'content-type': 'application/json', ...(admin ? { cookie } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const login = await loginCaptcha(base, { username: 'admin', password });
  const signedIn = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', cookie: login.token }, body: JSON.stringify(login.body) });
  assert.equal(signedIn.status, 200);
  cookie = signedIn.headers.get('set-cookie').split(';')[0];
  await signedIn.json();
  const customer = (await api('/api/admin/customers', { name: '一窗上传接口测试客户' }, true)).body;
  async function issue(extra = {}) {
    const result = await api('/api/admin/licenses', { customerId: customer.id, mode: 'online', expiresAt: Date.now() + 86400_000,
      allowedSystems: [systemId], allowedMatters: { [systemId]: [matterId] }, maxDevices: 2, allowExport: true, ...extra }, true);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  }
  const license = await issue(), deviceId = 'e'.repeat(64);
  const activated = await api('/api/activate', { key: license.activationCode, deviceId });
  assert.equal(activated.status, 200);
  const bytes = Buffer.alloc(128, 'synthetic');
  const metadata = { taskId: randomUUID(), systemId, matterId, fileName: '一窗回流-接口测试.xlsx', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), md5: createHash('md5').update(bytes).digest('base64') };
  const body = { ...metadata, deviceId, proof: activated.body };
  function mutate(sql, ...values) {
    const database = new DatabaseSync(dataPath);
    try { database.prepare(sql).run(...values); } finally { database.close(); }
  }
  return { api, body, license, deviceId, issue, mutate, customer };
}

test('one-window upload HTTP routes use the current signed device and selected matter permissions', async t => {
  const f = await fixture(t);
  const catalog = (await f.api('/api/admin/bootstrap', undefined, true)).body;
  assert.equal(catalog.matters.filter(row => row.system_id === systemId && row.enabled).length, 2);
  const prepared = await f.api('/api/one-window/uploads/prepare', f.body);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal(prepared.body.state, 'prepared');
  const uploadId = prepared.body.uploadId;
  const completed = await f.api('/api/one-window/uploads/complete', { deviceId: f.deviceId, proof: f.body.proof, uploadId });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.state, 'uploaded');
  assert.equal((await f.api('/api/one-window/uploads/download', { deviceId: f.deviceId, proof: f.body.proof, uploadId })).status, 200);
  assert.equal((await f.api('/api/one-window/uploads/prepare', { ...f.body, deviceId: 'f'.repeat(64) })).status, 403);
  assert.equal((await f.api('/api/one-window/uploads/prepare', { ...f.body, proof: { ...f.body.proof, signature: 'forged-signature' } })).status, 403);

  f.mutate('UPDATE licenses SET allowed_matters_json=? WHERE id=?', JSON.stringify({ [systemId]: ['storefront-signboard-filing'] }), f.license.id);
  assert.equal((await f.api('/api/one-window/uploads/prepare', f.body)).status, 403);
  f.mutate('UPDATE licenses SET allowed_matters_json=? WHERE id=?', JSON.stringify({ [systemId]: [matterId] }), f.license.id);
  f.mutate('UPDATE systems SET enabled=0 WHERE id=?', systemId);
  assert.equal((await f.api('/api/one-window/uploads/prepare', f.body)).status, 200, 'catalog disabling prevents new allocation without revoking existing scopes');
  f.mutate('UPDATE system_matters SET enabled=0 WHERE system_id=? AND id=?', systemId, matterId);
  assert.equal((await f.api('/api/one-window/uploads/prepare', { ...f.body, taskId: randomUUID() })).status, 200);
  assert.equal((await f.api('/api/one-window/uploads/download', { deviceId: f.deviceId, proof: f.body.proof, uploadId })).status, 200);
  f.mutate('UPDATE systems SET enabled=1 WHERE id=?', systemId);
  f.mutate('UPDATE devices SET status=? WHERE license_id=? AND device_id=?', 'revoked', f.license.id, f.deviceId);
  assert.equal((await f.api('/api/one-window/uploads/download', { deviceId: f.deviceId, proof: f.body.proof, uploadId })).status, 403);
});

test('no-export and incorrectly bound grants cannot upload, while a valid bound offline grant keeps the same device rules', async t => {
  const f = await fixture(t);
  const noExport = await f.issue({ allowExport: false });
  const activation = await f.api('/api/activate', { key: noExport.activationCode, deviceId: f.deviceId });
  assert.equal(activation.status, 200);
  assert.equal((await f.api('/api/one-window/uploads/prepare', { ...f.body, proof: activation.body })).status, 403);
  const offline = await f.issue({ mode: 'offline', maxDevices: 1, deviceId: '7'.repeat(64) });
  const proof = JSON.parse(Buffer.from(offline.offlineKey.slice(5), 'base64url').toString('utf8'));
  assert.equal((await f.api('/api/one-window/uploads/prepare', { ...f.body, deviceId: '7'.repeat(64), proof })).status, 200);
  assert.equal((await f.api('/api/one-window/uploads/prepare', { ...f.body, deviceId: '6'.repeat(64), proof })).status, 403);
});
