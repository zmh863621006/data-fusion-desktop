import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createAdminServer } from '../app.mjs';
import governmentMatters from '../../src/plugins/government-info/matter-catalog.json' with { type: 'json' };
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const systemId = 'guangdong-hrss', matterId = 'unemployment';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-return-http-')), dataPath = join(directory, 'admin.sqlite');
  const server = createAdminServer({ dataPath, privateKey, initialPassword: password, captchaFactory, returnUploadsEnabled: true, ...options });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    await new Promise(done => { server.close(done); server.closeAllConnections(); });
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert(directory.startsWith(join(tmpdir(), 'fusion-return-http-')));
    await rm(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port; let cookie = '';
  async function api(path, body, admin = false) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(admin ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' });
    return { status: response.status, body: await response.json() };
  }
  async function activate(selectedSystem = systemId, selectedMatter = matterId) {
    const login = await loginCaptcha(base, { username: 'admin', password });
    const signedIn = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', cookie: login.token }, body: JSON.stringify(login.body) });
    assert.equal(signedIn.status, 200); cookie = signedIn.headers.get('set-cookie').split(';')[0]; await signedIn.json();
    const customer = (await api('/api/admin/customers', { name: '合成惠州测试客户' }, true)).body;
    const license = (await api('/api/admin/licenses', { customerId: customer.id, mode: 'online', expiresAt: Date.now() + 86400_000,
      allowedSystems: [selectedSystem], allowedMatters: { [selectedSystem]: [selectedMatter] }, maxDevices: 2, allowExport: true }, true)).body;
    const deviceId = 'e'.repeat(64), activation = await api('/api/activate', { key: license.activationCode, deviceId });
    assert.equal(activation.status, 200);
    return { license, customer, auth: { deviceId, proof: activation.body } };
  }
  const mutate = (sql, ...values) => { const db = new DatabaseSync(dataPath); try { return db.prepare(sql).run(...values); } finally { db.close(); } };
  return { api, base, activate, mutate };
}
const metadata = auth => ({ ...auth, clientBatchId: randomUUID(), systemId, matterId, startedAt: Date.now() - 2000, finishedAt: Date.now() - 1000, rowCount: 1 });
const rows = [{ recordKey: 'synthetic-1', data: { name: '合成记录', status: '待受理', note: '<script>fixture</script>' }, firstSeenAt: 1, updatedAt: 2 }];

test('intranet deployment rejects accidental OSS modes, disabled receiving and an external update origin', () => {
  for (const wrong of [{ businessStorageMode: 'oss' }, { updateStorageMode: 'oss' },
    { returnUploadsEnabled: false }, { updatePublicOrigin: 'https://other.example.invalid' }]) {
    assert.throws(() => createAdminServer({ dataPath: ':memory:', privateKey, initialPassword: password,
      deployment: 'huizhou-intranet', publicOrigin: 'https://fusion.example.invalid', ...wrong }), /惠州部署/);
  }
});

test('signed desktop upload completes, appears in authenticated paginated admin data and downloads original JSON', async t => {
  const f = await fixture(t), { auth, customer } = await f.activate();
  const capability = await f.api('/api/returns/capabilities'); assert.deepEqual(capability.body, { schema: 1, enabled: true });
  const start = await f.api('/api/returns/batches', metadata(auth)); assert.equal(start.status, 200, JSON.stringify(start.body));
  const id = start.body.id;
  assert.equal((await f.api('/api/admin/returns')).status, 401);
  assert.equal((await f.api(`/api/admin/returns/${id}/export`, undefined, true)).status, 409);
  const chunk = await f.api(`/api/returns/batches/${id}/chunks`, { ...auth, index: 0, rows });
  assert.equal(chunk.status, 200, JSON.stringify(chunk.body));
  assert.equal(chunk.body.sha256, createHash('sha256').update(JSON.stringify(rows)).digest('hex'));
  const complete = await f.api(`/api/returns/batches/${id}/complete`, { ...auth, chunks: [chunk.body.sha256] });
  assert.equal(complete.status, 200); assert.equal(complete.body.state, 'completed');
  const list = await f.api('/api/admin/returns?page=1&pageSize=1&customerId=' + customer.id, undefined, true);
  assert.equal(list.body.total, 1); assert.equal(list.body.rows[0].customerName, '合成惠州测试客户');
  assert.equal(list.body.rows[0].receivedRows, 1);
  const detail = await f.api(`/api/admin/returns/${id}?page=1&pageSize=1`, undefined, true);
  assert.deepEqual(detail.body.rows[0].data, rows[0].data);
  const exported = await f.api(`/api/admin/returns/${id}/export`, undefined, true);
  assert.equal(exported.status, 200); assert.deepEqual(exported.body.rows[0].data, rows[0].data);
  assert(!JSON.stringify(exported.body).includes(auth.proof.signature));
  assert.equal((await f.api(`/api/admin/returns/${id}/export`)).status, 401);
});

test('live scope, device, customer and proof checks reject revoked, spoofed and cross-device requests', async t => {
  const f = await fixture(t), { auth, license, customer } = await f.activate(), input = metadata(auth);
  assert.equal((await f.api('/api/returns/batches', { ...input, proof: { ...auth.proof, signature: 'forged' } })).status, 403);
  const start = await f.api('/api/returns/batches', input); assert.equal(start.status, 200);
  const path = `/api/returns/batches/${start.body.id}/chunks`;
  assert.equal((await f.api(path, { ...auth, deviceId: 'f'.repeat(64), index: 0, rows })).status, 403);
  f.mutate('UPDATE licenses SET allowed_matters_json=? WHERE id=?', JSON.stringify({ [systemId]: [] }), license.id);
  assert.equal((await f.api(path, { ...auth, index: 0, rows })).status, 403);
  f.mutate('UPDATE licenses SET allowed_matters_json=? WHERE id=?', JSON.stringify({ [systemId]: [matterId] }), license.id);
  f.mutate('UPDATE customers SET enabled=0 WHERE id=?', customer.id);
  assert.equal((await f.api(path, { ...auth, index: 0, rows })).status, 403);
  f.mutate('UPDATE customers SET enabled=1 WHERE id=?', customer.id);
  f.mutate("UPDATE devices SET status='revoked' WHERE license_id=?", license.id);
  assert.equal((await f.api(path, { ...auth, index: 0, rows })).status, 403);
  const detail = await f.api(`/api/admin/returns/${start.body.id}`, undefined, true); assert.equal(detail.body.total, 0);
});

test('disabled receiver never accepts business data and public local update paths bypass only management IP gating', async t => {
  const f = await fixture(t, { returnUploadsEnabled: false });
  assert.equal((await f.api('/api/returns/capabilities')).body.enabled, false);
  assert.equal((await f.api('/api/returns/batches', {})).status, 503);
  const isolated = await fixture(t, { publicOrigin: 'https://fusion.example.invalid', businessStorageMode: 'local', updateStorageMode: 'local', managementAllowedIps: ['192.0.2.10'] });
  assert.equal((await fetch(isolated.base + '/')).status, 403);
  assert.equal((await fetch(isolated.base + '/business-updates/win32-x64-standard-electron-44/latest.json')).status, 404);
  assert.equal((await fetch(isolated.base + '/api/admin/returns')).status, 403);
});

test('Huizhou business data is JSON-only and does not load or accept the legacy workbook upload service', async t => {
  const f = await fixture(t, { deployment: 'huizhou-intranet', publicOrigin: 'https://fusion.example.invalid' });
  const selectedSystem = 'shenzhen-one-window', selectedMatter = 'outdoor-advertising-approval';
  const { auth, license } = await f.activate(selectedSystem, selectedMatter), clientBatchId = randomUUID();
  f.mutate('UPDATE licenses SET allow_export=0 WHERE id=?', license.id);
  assert.equal((await f.api('/api/one-window/uploads/prepare', { ...auth })).status, 404);
  const batch = await f.api('/api/returns/batches', { ...metadata(auth), clientBatchId, systemId: selectedSystem, matterId: selectedMatter });
  assert.equal(batch.status, 200, JSON.stringify(batch.body));
  const chunk = await f.api(`/api/returns/batches/${batch.body.id}/chunks`, { ...auth, index: 0, rows });
  assert.equal(chunk.status, 200);
  assert.equal((await f.api(`/api/returns/batches/${batch.body.id}/complete`, { ...auth, chunks: [chunk.body.sha256] })).status, 200);
  const detail = await f.api(`/api/admin/returns/${batch.body.id}`, undefined, true);
  assert.deepEqual(detail.body.rows[0].data, rows[0].data);
  assert.equal(detail.body.attachments, undefined);
  assert.equal((await fetch(f.base + `/api/one-window/files/${randomUUID()}`)).status, 404);
});

test('a valid old combined government proof is normalized but still constrained by the current live matter scope', async t => {
  const f = await fixture(t), selectedMatter = governmentMatters[0].id;
  const { auth, license } = await f.activate('government-info', selectedMatter);
  const grant = JSON.parse(Buffer.from(auth.proof.payload, 'base64url'));
  grant.allowedMatters = { 'government-info': ['double-publicity-return'] };
  const payload = Buffer.from(JSON.stringify(grant));
  const legacy = { deviceId: auth.deviceId, proof: { algorithm: 'RSA-SHA256', payload: payload.toString('base64url'), signature: sign('RSA-SHA256', payload, privateKey).toString('base64url') } };
  const body = { ...metadata(legacy), systemId: 'government-info', matterId: selectedMatter };
  assert.equal((await f.api('/api/returns/batches', body)).status, 200);
  f.mutate('UPDATE licenses SET allowed_matters_json=? WHERE id=?', JSON.stringify({ 'government-info': [] }), license.id);
  assert.equal((await f.api('/api/returns/batches', { ...body, clientBatchId: randomUUID() })).status, 403);
});
