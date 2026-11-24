import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAdminServer } from '../app.mjs';
import catalog from '../../src/plugins/guangdong-hrss/matter-catalog.json' with { type: 'json' };
import foodDrugCatalog from '../../src/plugins/guangdong-food-drug/matter-catalog.json' with { type: 'json' };
import populationCatalog from '../../src/plugins/guangdong-population/matter-catalog.json' with { type: 'json' };
import shenzhenServicesCatalog from '../../src/plugins/shenzhen-integrated-services/matter-catalog.json' with { type: 'json' };
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';

const SYSTEM = 'guangdong-hrss';
const addedSystems = [populationCatalog, shenzhenServicesCatalog];
const subdistrictMatters = catalog.filter(matter => matter.departmentId === 'subdistrict-office');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

async function fixture(t) {
  const server = createAdminServer({ dataPath: ':memory:', privateKey, initialPassword: password, captchaFactory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function api(path, body, authenticated = true) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', cookie: authenticated ? cookie : '' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const login = await loginCaptcha(base, { username: 'admin', password });
  const response = await fetch(base + '/api/admin/login', { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: login.token }, body: JSON.stringify(login.body) });
  assert.equal(response.status, 200);
  cookie = response.headers.getSetCookie().find(value => value.startsWith('df_admin=')).split(';')[0];
  const customer = await api('/api/admin/customers', { name: '人社组件本地测试单位' });
  assert.equal(customer.status, 201);
  const issue = extra => api('/api/admin/licenses', { customerId: customer.body.id, mode: 'online',
    expiresAt: Date.now() + 86_400_000, maxDevices: 1, allowedSystems: [SYSTEM],
    allowedMatters: { [SYSTEM]: catalog.map(matter => matter.id) }, allowExport: true, ...extra });
  return { api, issue };
}

function grant(envelope) {
  assert.equal(verify('RSA-SHA256', Buffer.from(envelope.payload, 'base64url'), publicKey,
    Buffer.from(envelope.signature, 'base64url')), true);
  return JSON.parse(Buffer.from(envelope.payload, 'base64url'));
}

test('catalog exposes the four HRSS subdistrict matters and the two new systems in the source order', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/admin/bootstrap', undefined, false)).status, 401);
  const bootstrap = (await f.api('/api/admin/bootstrap')).body;
  assert.deepEqual(bootstrap.systems.map(system => system.id).sort(), [
    'government-info', SYSTEM, 'market-access', 'online-car-permit', 'oversize-transport', 'transport-practitioner',
    'shenzhen-hazardous-chemicals', 'guangdong-special-equipment', 'shenzhen-one-window', foodDrugCatalog.id, ...addedSystems.map(system => system.id),
  ].sort());
  assert.equal(bootstrap.systems.find(system => system.id === SYSTEM).name, '广东省集中式人力资源和社会保障一体化门户系统');
  const matters = bootstrap.matters.filter(matter => matter.system_id === SYSTEM && matter.enabled);
  assert.equal(matters.length, 22);
  assert.equal(new Set(matters.map(matter => matter.department_id)).size, 5);
  assert.deepEqual(matters.map(matter => ({ id: matter.id, name: matter.name, departmentId: matter.department_id,
    departmentName: matter.department_name, departmentOrder: matter.department_order, matterOrder: matter.matter_order })),
  [...catalog].sort((a, b) => a.departmentOrder - b.departmentOrder || a.matterOrder - b.matterOrder || a.name.localeCompare(b.name))
    .map(({ id, name, departmentId, departmentName, departmentOrder, matterOrder }) => ({ id, name, departmentId, departmentName, departmentOrder, matterOrder })));
  assert.deepEqual(matters.filter(matter => matter.department_name === '街道办').map(matter => matter.name), [
    '企业招用困难人员补贴', '企业招用困难人员岗位补贴', '创业培训', '吸纳退役军人就业补贴',
  ]);
  assert.deepEqual(addedSystems.map(system => system.matters.length), [1, 10]);
  for (const system of addedSystems) {
    const actual = bootstrap.systems.find(item => item.id === system.id);
    assert.equal(actual?.name, system.name);
    assert.equal(actual?.enabled, 1);
    assert.deepEqual(bootstrap.matters.filter(matter => matter.system_id === system.id && matter.enabled).map(({ id, name }) => ({ id, name })),
      system.matters);
  }
});

test('HRSS grants carry only selected list ledgers and never permit enterprise enrichment', async t => {
  const f = await fixture(t), selected = [catalog[0].id, catalog[1].id];
  assert.equal((await f.issue({ allowedMatters: { [SYSTEM]: [] } })).status, 400);
  assert.equal((await f.issue({ allowedMatters: { [SYSTEM]: ['business-application-query'] } })).status, 400);
  const issued = await f.issue({ allowedMatters: { [SYSTEM]: selected } });
  assert.equal(issued.status, 201);
  const deviceId = '9'.repeat(64);
  const activation = await f.api('/api/activate', { key: issued.body.activationCode, deviceId }, false);
  assert.equal(activation.status, 200);
  assert.deepEqual(grant(activation.body).allowedSystems, [SYSTEM]);
  assert.deepEqual(grant(activation.body).allowedMatters, { [SYSTEM]: selected });
  const refreshed = await f.api('/api/license/status', { licenseId: issued.body.id, deviceId, proof: activation.body }, false);
  assert.equal(refreshed.status, 200);
  assert.deepEqual(grant(refreshed.body).allowedMatters, { [SYSTEM]: selected });
  const enterprise = await f.api('/api/enterprises/resolve', { proof: activation.body, deviceId, systemId: SYSTEM,
    matterId: selected[0], items: [{ name: '测试单位，无付费请求' }] }, false);
  assert.equal(enterprise.status, 403);
  assert.match(enterprise.body.error, /没有该事项的企业补全权限/);
  const offline = await f.issue({ mode: 'offline', deviceId: '8'.repeat(64), allowedMatters: { [SYSTEM]: selected } });
  assert.equal(offline.status, 201);
  assert.deepEqual(grant(JSON.parse(Buffer.from(offline.body.offlineKey.slice(5), 'base64url'))).allowedMatters, { [SYSTEM]: selected });
});

test('added matters can be assigned individually in a signed grant', async t => {
  const f = await fixture(t);
  const allowedSystems = [SYSTEM, ...addedSystems.map(system => system.id)];
  const allowedMatters = {
    [SYSTEM]: [subdistrictMatters[1].id],
    [populationCatalog.id]: ['birth-registration'],
    [shenzhenServicesCatalog.id]: [shenzhenServicesCatalog.matters[9].id],
  };
  const rejected = await f.issue({ allowedSystems, allowedMatters: { ...allowedMatters,
    [populationCatalog.id]: [subdistrictMatters[1].id] } });
  assert.equal(rejected.status, 400);
  const issued = await f.issue({ allowedSystems, allowedMatters });
  assert.equal(issued.status, 201);
  const activated = await f.api('/api/activate', { key: issued.body.activationCode, deviceId: '7'.repeat(64) }, false);
  assert.equal(activated.status, 200);
  assert.deepEqual(grant(activated.body).allowedSystems, allowedSystems);
  assert.deepEqual(grant(activated.body).allowedMatters, allowedMatters);
});

test('catalog upgrade preserves explicit grants, legacy HRSS scope and disabled state across restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-hrss-catalog-'));
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
    // Recreate the previous catalog and both representations of an unscoped HRSS grant.
    db.prepare('DELETE FROM system_matters WHERE system_id=? AND department_id=?').run(SYSTEM, 'subdistrict-office');
    const legacy = db.prepare(`INSERT INTO licenses(id,customer_id,mode,expires_at,allowed_systems_json,allowed_matters_json,created_at)
      VALUES(?,'original','online',?,'["guangdong-hrss","market-access"]',?,1)`);
    const expires = Date.now() + 86_400_000;
    legacy.run('legacy-all', expires, null);
    legacy.run('legacy-hrss', expires, '{"market-access":["business-application-query"]}');
    legacy.run('explicit-hrss', expires, '{"guangdong-hrss":["unemployment"]}');
    const disabledCatalogs = [{ id: SYSTEM, matters: catalog }, foodDrugCatalog, ...addedSystems];
    for (const { id, matters } of disabledCatalogs) {
      db.prepare('UPDATE systems SET enabled=0 WHERE id=?').run(id);
      db.prepare('UPDATE system_matters SET enabled=0 WHERE system_id=? AND id=?').run(id, matters[0].id);
    }
    db.close(); db = undefined;
    await boot(); await boot();
    db = new DatabaseSync(dataPath, { readOnly: true });
    assert.deepEqual({ ...db.prepare("SELECT * FROM licenses WHERE id='existing'").get() }, previous);
    const originalHrss = catalog.filter(matter => matter.departmentId !== 'subdistrict-office').map(matter => matter.id);
    const scope = db.prepare('SELECT allowed_matters_json FROM licenses WHERE id=?');
    assert.equal(originalHrss.length, 18);
    assert.deepEqual(JSON.parse(scope.get('legacy-all').allowed_matters_json), { [SYSTEM]: originalHrss });
    assert.deepEqual(JSON.parse(scope.get('legacy-hrss').allowed_matters_json), {
      'market-access': ['business-application-query'], [SYSTEM]: originalHrss,
    });
    assert.equal(scope.get('explicit-hrss').allowed_matters_json, '{"guangdong-hrss":["unemployment"]}');
    for (const { id, matters } of disabledCatalogs) {
      assert.equal(db.prepare('SELECT enabled FROM systems WHERE id=?').get(id).enabled, 0);
      assert.equal(db.prepare('SELECT enabled FROM system_matters WHERE system_id=? AND id=?').get(id, matters[0].id).enabled, 0);
      assert.equal(db.prepare('SELECT count(*) count FROM system_matters WHERE system_id=?').get(id).count, matters.length);
    }
    db.close(); db = undefined;
  } finally {
    db?.close();
    const absolute = resolve(directory);
    if (dirname(absolute) !== resolve(tmpdir()) || !absolute.startsWith(join(tmpdir(), 'fusion-hrss-catalog-'))) throw new Error('Unexpected HRSS test directory');
    await rm(absolute, { recursive: true, force: true });
  }
});
