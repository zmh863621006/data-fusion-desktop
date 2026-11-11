import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createAdminServer } from '../app.mjs';
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
async function fixture(t) {
  const server = createAdminServer({ dataPath: ':memory:', privateKey, initialPassword: password, captchaFactory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = '';
  async function api(path, body, override = token) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: override }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.getSetCookie()[0]?.split(';')[0] };
  }
  const login = await loginCaptcha(base, { username: 'admin', password });
  token = (await api('/api/admin/login', login.body, login.token)).cookie;
  const customerId = (await api('/api/admin/customers', { name: '工具测试单位' })).body.id;
  const grant = proof => { assert.equal(verify('RSA-SHA256', Buffer.from(proof.payload, 'base64url'), publicKey, Buffer.from(proof.signature, 'base64url')), true); return JSON.parse(Buffer.from(proof.payload, 'base64url')); };
  const license = extra => api('/api/admin/licenses', { customerId, mode: 'online', expiresAt: Date.now() + 600000, allowedSystems: [], allowedTools: ['health-publicity'], allowExport: true, ...extra });
  return { api, license, grant };
}
test('tools are a separate catalog; tools-only online licenses activate and refresh without business system access', async t => {
  const f = await fixture(t), bootstrap = await f.api('/api/admin/bootstrap');
  assert.equal(bootstrap.body.systems.length, 6);
  assert.equal(bootstrap.body.systems.some(system => system.id === 'health-publicity'), false);
  assert.equal(bootstrap.body.tools[0].id, 'health-publicity');
  const issued = await f.license({}); assert.equal(issued.status, 201);
  const activated = await f.api('/api/activate', { key: issued.body.activationCode, deviceId: 'a'.repeat(64) }); assert.equal(activated.status, 200);
  const grant = f.grant(activated.body); assert.deepEqual(grant.allowedSystems, []); assert.deepEqual(grant.allowedTools, ['health-publicity']); assert.equal(grant.allowExport, true);
  const refreshed = await f.api('/api/license/status', { licenseId: grant.licenseId, deviceId: grant.deviceId, proof: activated.body });
  assert.equal(refreshed.status, 200); assert.deepEqual(f.grant(refreshed.body).allowedTools, ['health-publicity']);
});
test('tools-only offline licenses retain the independent permission and reject invalid or empty scopes', async t => {
  const f = await fixture(t), issued = await f.license({ mode: 'offline', deviceId: 'b'.repeat(64) }); assert.equal(issued.status, 201);
  const proof = JSON.parse(Buffer.from(issued.body.offlineKey.slice(5), 'base64url'));
  assert.deepEqual(f.grant(proof).allowedTools, ['health-publicity']);
  for (const allowedTools of [[], ['unknown-tool'], 'health-publicity', [123]]) assert.equal((await f.license({ allowedTools })).status, 400);
  const licenses = (await f.api('/api/admin/bootstrap')).body.licenses;
  assert.deepEqual(JSON.parse(licenses[0].allowed_tools_json), ['health-publicity']);
});
