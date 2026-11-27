import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAdminServer } from '../app.mjs';
import housing from '../../src/plugins/shenzhen-housing-rental/matter-catalog.json' with { type: 'json' };
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const MATTER = 'house-code-binding';

async function fixture(t) {
  const server = createAdminServer({ dataPath: ':memory:', privateKey, initialPassword: password, captchaFactory });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const challenge = await loginCaptcha(base, { username: 'admin', password });
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: {
    'content-type': 'application/json', cookie: challenge.token,
  }, body: JSON.stringify(challenge.body) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('df_admin=')).split(';')[0];
  async function api(path, body, authenticated = true) {
    const result = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', cookie: authenticated ? cookie : '' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() };
  }
  return api;
}

test('housing catalog is available to administrator and has exactly the binding matter', async t => {
  const api = await fixture(t);
  assert.equal((await api('/api/admin/bootstrap', undefined, false)).status, 401);
  const bootstrap = await api('/api/admin/bootstrap');
  assert.equal(bootstrap.status, 200);
  const system = bootstrap.body.systems.find(row => row.id === housing.id);
  assert(system);
  assert.equal(system.name, '深圳市房屋租赁备案登记管理系统');
  assert.equal(system.version, housing.version);
  assert.equal(system.enabled, 1);
  assert.deepEqual(bootstrap.body.matters.filter(row => row.system_id === housing.id).map(({ id, name, enabled, matter_order }) => ({ id, name, enabled, matter_order })),
    [{ id: MATTER, name: '房屋编码自动绑定', enabled: 1, matter_order: 0 }]);
});

test('binding permission is explicit and may be signed without export or auto-sync privileges', async t => {
  const api = await fixture(t);
  const customer = await api('/api/admin/customers', { name: '租赁绑定隔离测试单位' });
  assert.equal(customer.status, 201);
  const request = { customerId: customer.body.id, mode: 'online', expiresAt: Date.now() + 86_400_000,
    maxDevices: 1, allowedSystems: [housing.id], allowedMatters: { [housing.id]: [MATTER] },
    allowExport: false, allowAutoSync: false, allowAutoUpdate: false };
  assert.equal((await api('/api/admin/licenses', { ...request, allowedMatters: { [housing.id]: ['business-application-query'] } })).status, 400);
  assert.equal((await api('/api/admin/licenses', { ...request, allowedMatters: { [housing.id]: [] } })).status, 400);
  const issued = await api('/api/admin/licenses', request);
  assert.equal(issued.status, 201);
  const activated = await api('/api/activate', { key: issued.body.activationCode, deviceId: '6'.repeat(64) }, false);
  assert.equal(activated.status, 200);
  const envelope = activated.body;
  assert(verify('RSA-SHA256', Buffer.from(envelope.payload, 'base64url'), publicKey, Buffer.from(envelope.signature, 'base64url')));
  const grant = JSON.parse(Buffer.from(envelope.payload, 'base64url'));
  assert.deepEqual(grant.allowedSystems, [housing.id]);
  assert.deepEqual(grant.allowedMatters, { [housing.id]: [MATTER] });
  assert.equal(grant.allowExport, false);
  assert.equal(grant.allowAutoSync, false);
});

test('adding rental catalog preserves all existing license rows and catalog disabling on repeat startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-housing-catalog-'));
  const dataPath = join(directory, 'fixture.sqlite');
  const boot = async () => {
    const server = createAdminServer({ dataPath, privateKey, initialPassword: password });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    await new Promise(done => server.close(done));
  };
  let db;
  try {
    await boot();
    db = new DatabaseSync(dataPath);
    db.prepare('INSERT INTO customers(id,name,created_at) VALUES(?,?,?)').run('original-customer', '原单位', 1);
    const add = db.prepare(`INSERT INTO licenses(id,customer_id,mode,expires_at,allowed_systems_json,allowed_matters_json,created_at)
      VALUES(?,'original-customer','online',?,?,?,1)`);
    add.run('explicit-existing', Date.now() + 86_400_000, '["market-access"]', '{"market-access":["business-application-query"]}');
    add.run('unscoped-existing', Date.now() + 86_400_000, '["market-access"]', null);
    const previous = db.prepare('SELECT * FROM licenses ORDER BY id').all();
    db.prepare('DELETE FROM system_matters WHERE system_id=?').run(housing.id);
    db.prepare('DELETE FROM systems WHERE id=?').run(housing.id);
    db.close(); db = undefined;
    await boot();
    db = new DatabaseSync(dataPath);
    assert.deepEqual(db.prepare('SELECT * FROM licenses ORDER BY id').all(), previous);
    assert.equal(db.prepare('SELECT count(*) count FROM systems WHERE id=?').get(housing.id).count, 1);
    assert.equal(db.prepare('SELECT count(*) count FROM system_matters WHERE system_id=?').get(housing.id).count, 1);
    db.prepare('UPDATE systems SET enabled=0 WHERE id=?').run(housing.id);
    db.prepare('UPDATE system_matters SET enabled=0 WHERE system_id=? AND id=?').run(housing.id, MATTER);
    db.close(); db = undefined;
    await boot(); await boot();
    db = new DatabaseSync(dataPath, { readOnly: true });
    assert.deepEqual(db.prepare('SELECT * FROM licenses ORDER BY id').all(), previous);
    assert.equal(db.prepare('SELECT enabled FROM systems WHERE id=?').get(housing.id).enabled, 0);
    assert.equal(db.prepare('SELECT enabled FROM system_matters WHERE system_id=? AND id=?').get(housing.id, MATTER).enabled, 0);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally {
    db?.close();
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert(absolute.startsWith(join(tmpdir(), 'fusion-housing-catalog-')));
    await rm(absolute, { recursive: true, force: true });
  }
});
