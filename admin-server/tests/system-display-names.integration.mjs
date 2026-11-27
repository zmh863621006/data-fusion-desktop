import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAdminServer } from '../app.mjs';
import housing from '../../src/plugins/shenzhen-housing-rental/matter-catalog.json' with { type: 'json' };
import oneWindow from '../../src/plugins/shenzhen-one-window/matter-catalog.json' with { type: 'json' };
import { captchaFactory, loginCaptcha, password } from './helpers.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const expectedNames = new Map([
  [housing.id, '深圳市房屋租赁备案登记管理系统'],
  [oneWindow.id, '深圳市一窗综合服务受理系统'],
]);

async function launch(dataPath) {
  const server = createAdminServer({ dataPath, privateKey, initialPassword: password, captchaFactory });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    close: () => new Promise(done => { server.close(done); server.closeAllConnections(); }),
    async admin() {
      const challenge = await loginCaptcha(base, { username: 'admin', password });
      const result = await fetch(base + '/api/admin/login', { method: 'POST',
        headers: { 'content-type': 'application/json', cookie: challenge.token }, body: JSON.stringify(challenge.body) });
      assert.equal(result.status, 200);
      const cookie = result.headers.getSetCookie().find(value => value.startsWith('df_admin=')).split(';')[0];
      return async path => {
        const response = await fetch(base + path, { headers: { cookie } });
        assert.equal(response.status, 200);
        return response.json();
      };
    },
  };
}

const snapshot = db => ({
  systems: db.prepare('SELECT * FROM systems WHERE id IN (?,?) ORDER BY id').all(housing.id, oneWindow.id),
  matters: db.prepare('SELECT * FROM system_matters WHERE system_id IN (?,?) ORDER BY system_id,id').all(housing.id, oneWindow.id),
  customers: db.prepare('SELECT * FROM customers ORDER BY id').all(),
  licenses: db.prepare('SELECT * FROM licenses ORDER BY id').all(),
  activationCodes: db.prepare('SELECT * FROM activation_codes ORDER BY id').all(),
  devices: db.prepare('SELECT * FROM devices ORDER BY id').all(),
  batches: db.prepare('SELECT * FROM return_batches ORDER BY id').all(),
});

test('fresh admin database displays full system names while retaining the existing system and matter identifiers', async () => {
  const app = await launch(':memory:');
  try {
    const api = await app.admin(), bootstrap = await api('/api/admin/bootstrap');
    for (const catalog of [housing, oneWindow]) {
      const system = bootstrap.systems.find(row => row.id === catalog.id);
      assert.equal(system.name, expectedNames.get(catalog.id));
      assert.notEqual(system.name, catalog.clientName);
      assert.equal(system.version, catalog.version);
      assert.equal(system.enabled, 1);
      assert.deepEqual(bootstrap.matters.filter(row => row.system_id === catalog.id).map(row => row.id).sort(),
        catalog.matters.map(row => row.id).sort());
    }
  } finally { await app.close(); }
});

for (const oldNames of [
  ['房屋租赁管理信息系统', '深圳市一窗综合服务受理平台'],
  ['房屋租赁', '一窗受理平台'],
]) test(`renames existing default labels ${oldNames.join(' / ')} without changing permissions, metadata or history`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-system-names-'));
  const dataPath = join(directory, 'fixture.sqlite');
  let db;
  try {
    await (await launch(dataPath)).close();
    db = new DatabaseSync(dataPath);
    db.exec('PRAGMA foreign_keys=ON');
    for (const [index, catalog] of [housing, oneWindow].entries()) {
      db.prepare('UPDATE systems SET name=?,version=?,enabled=0,created_at=7 WHERE id=?')
        .run(oldNames[index], '9.8.7', catalog.id);
      db.prepare('UPDATE system_matters SET enabled=0 WHERE system_id=?').run(catalog.id);
    }
    db.prepare('INSERT INTO customers(id,name,created_at) VALUES(?,?,?)').run('fixture-customer', '合成客户', 1);
    db.prepare(`INSERT INTO licenses(id,customer_id,mode,expires_at,allowed_systems_json,allowed_matters_json,created_at)
      VALUES(?,'fixture-customer','online',?,?,?,1)`).run('fixture-license', Date.now() + 86_400_000,
      JSON.stringify([housing.id, oneWindow.id]), JSON.stringify({
        [housing.id]: housing.matters.map(matter => matter.id), [oneWindow.id]: oneWindow.matters.map(matter => matter.id),
      }));
    db.prepare(`INSERT INTO activation_codes(id,license_id,code_hash,created_at) VALUES(?,'fixture-license',?,1)`)
      .run('fixture-code', 'a'.repeat(64));
    db.prepare(`INSERT INTO devices(id,license_id,device_id,activated_at,last_seen_at) VALUES(?,'fixture-license',?,1,2)`)
      .run('fixture-device', 'b'.repeat(64));
    db.prepare(`INSERT INTO return_batches(id,customer_id,license_id,device_id,client_batch_id,system_id,matter_id,
      started_at,finished_at,row_count,state,created_at,completed_at)
      VALUES(?,'fixture-customer','fixture-license',?,?,?,?,1,2,0,'completed',2,2)`)
      .run('fixture-history', 'b'.repeat(64), 'fixture-client-batch', oneWindow.id, oneWindow.matters[0].id);
    const original = snapshot(db);
    db.close(); db = undefined;
    const expected = { ...original, systems: original.systems.map(row => Object.assign(
      Object.create(Object.getPrototypeOf(row)), row, { name: expectedNames.get(row.id) })) };
    for (let pass = 0; pass < 2; pass++) {
      const app = await launch(dataPath);
      try {
        const api = await app.admin();
        const history = await api('/api/admin/returns');
        assert.equal(history.total, 1);
        assert.equal(history.rows[0].systemId, oneWindow.id);
        assert.equal(history.rows[0].systemName, expectedNames.get(oneWindow.id));
      } finally { await app.close(); }
      db = new DatabaseSync(dataPath, { readOnly: true });
      assert.deepEqual(snapshot(db), expected);
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      db.close(); db = undefined;
    }
  } finally {
    db?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert(resolve(directory).startsWith(join(tmpdir(), 'fusion-system-names-')));
    await rm(directory, { recursive: true, force: true });
  }
});

test('repeat startup preserves administrator-defined names instead of replacing arbitrary labels', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-system-names-'));
  const dataPath = join(directory, 'fixture.sqlite');
  let db;
  try {
    await (await launch(dataPath)).close();
    db = new DatabaseSync(dataPath);
    for (const catalog of [housing, oneWindow]) db.prepare('UPDATE systems SET name=? WHERE id=?')
      .run('管理员自定义-' + catalog.id, catalog.id);
    const original = snapshot(db);
    db.close(); db = undefined;
    await (await launch(dataPath)).close();
    db = new DatabaseSync(dataPath, { readOnly: true });
    assert.deepEqual(snapshot(db), original);
  } finally {
    db?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert(resolve(directory).startsWith(join(tmpdir(), 'fusion-system-names-')));
    await rm(directory, { recursive: true, force: true });
  }
});
