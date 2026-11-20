import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAdminServer } from '../app.mjs';
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const A = 'market-access', B = 'government-info', TOOL = 'health-publicity';
const MATTER_A = 'business-application-query';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-license-scope-'));
  const dataPath = join(directory, 'fixture.sqlite');
  const server = createAdminServer({ dataPath, privateKey, initialPassword: password, captchaFactory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const db = new DatabaseSync(dataPath);
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    db.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.startsWith(join(tmpdir(), 'fusion-license-scope-'))) throw new Error('Unexpected scope test directory');
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = '';
  async function api(path, body, { method = body === undefined ? 'GET' : 'POST', cookie = token, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.getSetCookie().find(value => value.startsWith('df_admin='))?.split(';')[0] };
  }
  async function login(username = 'admin') {
    const input = await loginCaptcha(base, { username, password });
    const result = await api('/api/admin/login', input.body, { cookie: input.token });
    assert.equal(result.status, 200);
    return result.cookie;
  }
  token = await login();
  const customer = await api('/api/admin/customers', { name: '授权范围测试单位' });
  assert.equal(customer.status, 201);
  const matters = db.prepare('SELECT * FROM system_matters WHERE system_id=? AND enabled=1 ORDER BY id').all(B).map(row => row.id);
  async function license(extra = {}) {
    const result = await api('/api/admin/licenses', { customerId: customer.body.id, mode: 'online', expiresAt: Date.now() + 86_400_000,
      allowedSystems: [A], allowedTools: [], allowedMatters: { [A]: [MATTER_A] }, maxDevices: 3,
      allowExport: true, allowAutoSync: true, allowAutoUpdate: true, ...extra });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  }
  const row = id => db.prepare('SELECT * FROM licenses WHERE id=?').get(id);
  const scope = id => {
    const value = row(id);
    return { allowedSystems: JSON.parse(value.allowed_systems_json), allowedTools: JSON.parse(value.allowed_tools_json ?? '[]'),
      allowedMatters: value.allowed_matters_json ? JSON.parse(value.allowed_matters_json) : null };
  };
  const update = (id, next, extra = {}, options) => api(`/api/admin/licenses/${id}/scope`, { ...next, expectedScope: scope(id), ...extra }, options);
  const grant = proof => {
    assert.equal(verify('RSA-SHA256', Buffer.from(proof.payload, 'base64url'), publicKey, Buffer.from(proof.signature, 'base64url')), true);
    return JSON.parse(Buffer.from(proof.payload, 'base64url'));
  };
  const activate = (key, deviceId) => api('/api/activate', { key, deviceId }, { cookie: '' });
  const refresh = (licenseId, deviceId, proof) => api('/api/license/status', { licenseId, deviceId, proof }, { cookie: '' });
  const auditRows = id => db.prepare("SELECT * FROM admin_audit_events WHERE action='license.scope_updated' AND target_id=? ORDER BY created_at,id").all(id);
  return { api, login, license, row, scope, update, grant, activate, refresh, auditRows, db, matters, customerId: customer.body.id };
}

const both = matter => ({ allowedSystems: [A, B], allowedTools: [], allowedMatters: { [A]: [MATTER_A], [B]: [matter] } });
const onlyA = () => ({ allowedSystems: [A], allowedTools: [], allowedMatters: { [A]: [MATTER_A] } });
const onlyTool = () => ({ allowedSystems: [], allowedTools: [TOOL], allowedMatters: {} });

test('issuance verifies every granted matter including empty catalogs', async t => {
  const f = await fixture(t);
  const body = { customerId: f.customerId, mode: 'online', expiresAt: Date.now() + 86_400_000, ...onlyA() };
  for (const selected of [[MATTER_A, 7], MATTER_A, null]) {
    assert.equal((await f.api('/api/admin/licenses', { ...body, allowedMatters: { [A]: selected } })).status, 400);
  }
  f.db.prepare('UPDATE system_matters SET enabled=0 WHERE system_id=?').run(A);
  assert.equal((await f.api('/api/admin/licenses', body)).status, 400);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM licenses').get().total, 0);
});

test('scope changes preserve license identity, features, devices and activation codes; every old device proof refreshes to the current scope', async t => {
  const f = await fixture(t), l = await f.license();
  const one = '1'.repeat(64), two = '2'.repeat(64), three = '3'.repeat(64);
  const first = await f.activate(l.activationCode, one); assert.equal(first.status, 200);
  const secondCode = await f.api(`/api/admin/licenses/${l.id}/codes`, {}); assert.equal(secondCode.status, 201);
  const second = await f.activate(secondCode.body.activationCode, two); assert.equal(second.status, 200);
  const unusedCode = await f.api(`/api/admin/licenses/${l.id}/codes`, {}); assert.equal(unusedCode.status, 201);
  const original = { ...f.row(l.id) };
  const originalDevices = f.db.prepare('SELECT * FROM devices WHERE license_id=? ORDER BY id').all(l.id);
  const originalCodes = f.db.prepare('SELECT * FROM activation_codes WHERE license_id=? ORDER BY id').all(l.id);
  const added = await f.update(l.id, both(f.matters[0]));
  assert.equal(added.status, 200); assert.equal(added.body.ok, true); assert.equal(added.body.changed, true); assert.equal(added.body.requiresOfflineReissue, false);
  const changed = { ...f.row(l.id) };
  for (const key of ['allowed_systems_json', 'allowed_tools_json', 'allowed_matters_json']) { delete original[key]; delete changed[key]; }
  assert.deepEqual(changed, original);
  assert.deepEqual(f.db.prepare('SELECT * FROM devices WHERE license_id=? ORDER BY id').all(l.id), originalDevices);
  assert.deepEqual(f.db.prepare('SELECT * FROM activation_codes WHERE license_id=? ORDER BY id').all(l.id), originalCodes);
  for (const [deviceId, proof] of [[one, first.body], [two, second.body]]) {
    const refreshed = await f.refresh(l.id, deviceId, proof); assert.equal(refreshed.status, 200);
    assert.deepEqual(f.grant(refreshed.body).allowedSystems, [A, B]);
  }
  const third = await f.activate(unusedCode.body.activationCode, three); assert.equal(third.status, 200);
  assert.deepEqual(f.grant(third.body).allowedSystems, [A, B]);
  assert.equal((await f.update(l.id, onlyA())).status, 200);
  const withdrawn = await f.refresh(l.id, three, third.body); assert.equal(withdrawn.status, 200);
  assert.deepEqual(f.grant(withdrawn.body).allowedSystems, [A]);
  assert.equal(Object.hasOwn(f.grant(withdrawn.body).allowedMatters, B), false);
});

test('legacy all-matter grants refresh and resolve enterprises only for actual matters in the granted system', async t => {
  const f = await fixture(t), deviceId = 'f'.repeat(64), matterId = f.matters[0];
  const license = await f.license({ allowedSystems: [B], allowedMatters: { [B]: [matterId] } });
  const writeScope = f.db.prepare('UPDATE licenses SET allowed_matters_json=? WHERE id=?');
  const resolveItem = (proof, requestedMatter = matterId, systemId = B) => f.api('/api/enterprises/resolve',
    { deviceId, proof, systemId, matterId: requestedMatter, items: [{ name: '本地授权测试单位' }] }, { cookie: '' });
  for (const stored of [null, 'null', '{}', JSON.stringify({ [B]: null })]) {
    writeScope.run(stored, license.id);
    const activation = await f.activate(license.activationCode, deviceId);
    assert.equal(activation.status, 200);
    const refresh = await f.refresh(license.id, deviceId, activation.body);
    assert.equal(refresh.status, 200);
    const scope = f.grant(refresh.body).allowedMatters;
    assert.equal(scope?.[B], undefined);
    assert.notEqual(scope, null);
    assert.equal((await resolveItem(refresh.body)).status, 200);
    assert.equal((await resolveItem(refresh.body, MATTER_A)).status, 403);
    assert.equal((await resolveItem(refresh.body, 'oversize-transport-return', 'oversize-transport')).status, 403);
    writeScope.run(JSON.stringify({ [B]: [] }), license.id);
    assert.equal((await resolveItem(refresh.body)).status, 403);
    assert.deepEqual(f.grant((await f.refresh(license.id, deviceId, refresh.body)).body).allowedMatters[B], []);
  }
});

test('scope can change selected matters and become tools-only without recreating the license', async t => {
  const f = await fixture(t), l = await f.license({ ...both(f.matters[0]), allowedMatters: { [A]: [MATTER_A], [B]: f.matters.slice(0, 2) } });
  const active = await f.activate(l.activationCode, '4'.repeat(64)); assert.equal(active.status, 200);
  assert.equal((await f.update(l.id, both(f.matters[1]))).status, 200);
  let refreshed = await f.refresh(l.id, '4'.repeat(64), active.body);
  assert.deepEqual(f.grant(refreshed.body).allowedMatters[B], [f.matters[1]]);
  assert.equal((await f.update(l.id, onlyTool())).status, 200);
  refreshed = await f.refresh(l.id, '4'.repeat(64), active.body);
  assert.deepEqual(f.grant(refreshed.body).allowedSystems, []);
  assert.deepEqual(f.grant(refreshed.body).allowedTools, [TOOL]);
  assert.deepEqual(f.grant(refreshed.body).allowedMatters, {});
});

test('offline scope changes require a reissued key bound to the original device and cannot rewrite the old signed key', async t => {
  const f = await fixture(t), deviceId = '5'.repeat(64), l = await f.license({ mode: 'offline', maxDevices: 1, deviceId });
  const originalProof = JSON.parse(Buffer.from(l.offlineKey.slice(5), 'base64url'));
  const original = f.grant(originalProof);
  const result = await f.update(l.id, both(f.matters[0]));
  assert.equal(result.status, 200); assert.equal(result.body.changed, true); assert.equal(result.body.requiresOfflineReissue, true);
  assert.deepEqual(f.grant(originalProof), original); assert.deepEqual(original.allowedSystems, [A]);
  const reissued = await f.api(`/api/admin/licenses/${l.id}/offline-key`, {}); assert.equal(reissued.status, 200);
  const grant = f.grant(JSON.parse(Buffer.from(reissued.body.offlineKey.slice(5), 'base64url')));
  assert.deepEqual(grant.allowedSystems, [A, B]); assert.equal(grant.deviceId, deviceId); assert.equal(grant.licenseId, l.id);
  assert.equal(grant.expiresAt, original.expiresAt); assert.equal(grant.maxDevices, 1);
  assert.deepEqual(f.db.prepare('SELECT device_id,status FROM devices WHERE license_id=?').all(l.id).map(row => ({ ...row })), [{ device_id: deviceId, status: 'active' }]);
});

test('scope validates string arrays, exact selected-system matter maps and nonempty permissions without silently granting all matters', async t => {
  const f = await fixture(t), l = await f.license(), before = f.scope(l.id);
  const invalid = [
    ['systems string', { ...onlyA(), allowedSystems: A }],
    ['systems missing', { allowedTools: [], allowedMatters: {} }],
    ['systems mixed', { ...onlyA(), allowedSystems: [A, 7] }],
    ['systems null', { ...onlyA(), allowedSystems: null }],
    ['unknown system', { allowedSystems: ['unknown-system'], allowedTools: [], allowedMatters: { 'unknown-system': [] } }],
    ['tools string', { ...onlyA(), allowedTools: TOOL }],
    ['tools mixed', { ...onlyA(), allowedTools: [TOOL, 7] }],
    ['tools null', { ...onlyA(), allowedTools: null }],
    ['unknown tool', { ...onlyA(), allowedTools: ['unknown-tool'] }],
    ['empty scope', { allowedSystems: [], allowedTools: [], allowedMatters: {} }],
    ['matters null', { ...onlyA(), allowedMatters: null }],
    ['matters missing', { allowedSystems: [A], allowedTools: [] }],
    ['matters array', { ...onlyA(), allowedMatters: [] }],
    ['selected map omitted', { ...onlyA(), allowedMatters: {} }],
    ['selected matters empty', { ...onlyA(), allowedMatters: { [A]: [] } }],
    ['selected matters string', { ...onlyA(), allowedMatters: { [A]: MATTER_A } }],
    ['selected matters mixed', { ...onlyA(), allowedMatters: { [A]: [MATTER_A, 7] } }],
    ['unknown matter', { ...onlyA(), allowedMatters: { [A]: ['unknown-matter'] } }],
    ['cross-system matter', { ...onlyA(), allowedMatters: { [A]: [f.matters[0]] } }],
    ['extra unselected system map', { ...onlyA(), allowedMatters: { [A]: [MATTER_A], [B]: [f.matters[0]] } }],
    ['new system missing explicit map', { allowedSystems: [A, B], allowedTools: [], allowedMatters: { [A]: [MATTER_A] } }],
    ['new system empty explicit map', { ...both(f.matters[0]), allowedMatters: { [A]: [MATTER_A], [B]: [] } }],
    ['tool-only extra matter map', { ...onlyTool(), allowedMatters: { [A]: [MATTER_A] } }],
  ];
  for (const [label, body] of invalid) {
    const response = await f.update(l.id, body);
    assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.body)}`);
    assert.deepEqual(f.scope(l.id), before, label);
  }
  for (const extra of [{ maxDevices: 100 }, { expiresAt: Date.now() + 999_999_999 }, { mode: 'offline' },
    { allowExport: false }, { allowAutoSync: false }, { allowAutoUpdate: false }, { customerId: 'not-another-customer' }, { deviceId: 'f'.repeat(64) }]) {
    const response = await f.update(l.id, both(f.matters[0]), extra);
    assert.equal(response.status, 400, JSON.stringify(extra));
    assert.deepEqual(f.scope(l.id), before);
  }
  assert.equal(f.auditRows(l.id).length, 0);
});

test('disabled systems can be retained or removed only when already granted, never newly added', async t => {
  const f = await fixture(t), existing = await f.license(), other = await f.license({ ...onlyTool() });
  f.db.prepare('UPDATE systems SET enabled=0 WHERE id=?').run(A);
  assert.equal((await f.update(existing.id, { ...onlyA(), allowedTools: [TOOL] })).status, 200);
  assert.equal((await f.update(other.id, onlyA())).status, 400);
  assert.equal((await f.update(existing.id, onlyTool())).status, 200);
  assert.equal((await f.update(existing.id, onlyA())).status, 400);
});

test('disabled matters can only be retained when already authorized and remain removable', async t => {
  const f = await fixture(t), [oldMatter, newMatter] = f.matters;
  const l = await f.license({ ...both(oldMatter) });
  f.db.prepare('UPDATE system_matters SET enabled=0 WHERE system_id=? AND id IN (?,?)').run(B, oldMatter, newMatter);
  assert.equal((await f.update(l.id, { ...both(oldMatter), allowedTools: [TOOL] })).status, 200);
  assert.equal((await f.update(l.id, both(newMatter))).status, 400);
  assert.equal((await f.update(l.id, both(f.matters[2]))).status, 200);
  assert.equal((await f.update(l.id, both(oldMatter))).status, 400);
});

test('retaining a disabled system cannot add enabled matters outside its original permission', async t => {
  const f = await fixture(t), l = await f.license({ ...both(f.matters[0]) });
  f.db.prepare('UPDATE systems SET enabled=0 WHERE id=?').run(B);
  assert.equal((await f.update(l.id, { ...both(f.matters[0]), allowedMatters: { [A]: [MATTER_A], [B]: f.matters.slice(0, 2) } })).status, 400);
  assert.equal((await f.update(l.id, { ...both(f.matters[0]), allowedTools: [TOOL] })).status, 200);
  assert.equal((await f.update(l.id, onlyA())).status, 200);
});

test('legacy null and omitted system matter scopes may be converted to an explicit list including previously covered disabled matters', async t => {
  const f = await fixture(t), disabled = f.matters[0];
  f.db.prepare('UPDATE system_matters SET enabled=0 WHERE system_id=? AND id=?').run(B, disabled);
  const allKnownMatters = f.db.prepare('SELECT id FROM system_matters WHERE system_id=? ORDER BY id').all(B).map(row => row.id);
  for (const legacyValue of [null, JSON.stringify({ [A]: [MATTER_A] })]) {
    const l = await f.license({ allowedSystems: [A, B], allowedMatters: { [A]: [MATTER_A], [B]: [f.matters[1]] } });
    f.db.prepare('UPDATE licenses SET allowed_matters_json=? WHERE id=?').run(legacyValue, l.id);
    assert.equal((await f.update(l.id, { ...both(disabled), allowedMatters: { [A]: [MATTER_A], [B]: allKnownMatters } })).status, 200);
    assert.deepEqual(f.scope(l.id).allowedMatters[B], allKnownMatters);
  }
});

test('scope writes require a complete prior scope snapshot and stale snapshots conflict without overwriting newer changes', async t => {
  const f = await fixture(t), l = await f.license(), path = `/api/admin/licenses/${l.id}/scope`, before = f.scope(l.id);
  for (const invalidSnapshot of [undefined, null, [], {}, { allowedSystems: [A] }, { ...before, allowedSystems: A }, { ...before, allowedTools: null }]) {
    const result = await f.api(path, { ...both(f.matters[0]), ...(invalidSnapshot === undefined ? {} : { expectedScope: invalidSnapshot }) });
    assert.equal(result.status, 400, JSON.stringify(invalidSnapshot));
  }
  assert.equal((await f.api(path, { ...both(f.matters[0]), expectedScope: before })).status, 200);
  const stale = await f.api(path, { ...onlyTool(), expectedScope: before });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'LICENSE_SCOPE_CONFLICT');
  assert.deepEqual(f.scope(l.id), both(f.matters[0]));
  assert.equal(f.auditRows(l.id).length, 1);
});

test('two simultaneous editors cannot both replace the same scope snapshot', async t => {
  const f = await fixture(t), l = await f.license(), expectedScope = f.scope(l.id), path = `/api/admin/licenses/${l.id}/scope`;
  const results = await Promise.all([f.api(path, { ...both(f.matters[0]), expectedScope }), f.api(path, { ...onlyTool(), expectedScope })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(results.find(result => result.status === 409).body.code, 'LICENSE_SCOPE_CONFLICT');
  assert.equal(f.auditRows(l.id).length, 1);
});

test('scope mutation requires management authentication, denies viewers and cross-origin CSRF, and supports operators', async t => {
  const f = await fixture(t), l = await f.license(), next = both(f.matters[0]);
  assert.equal((await f.update(l.id, next, {}, { cookie: '' })).status, 401);
  assert.equal((await f.update(l.id, next, {}, { headers: { origin: 'https://evil.invalid' } })).status, 403);
  for (const role of ['viewer', 'operator']) {
    assert.equal((await f.api('/api/admin/users', { username: `scope-${role}`, password, role })).status, 201);
    const cookie = await f.login(`scope-${role}`);
    assert.equal((await f.update(l.id, next, {}, { cookie })).status, role === 'viewer' ? 403 : 200);
  }
  assert.equal(f.auditRows(l.id).length, 1);
  assert.equal(f.auditRows(l.id)[0].username, 'scope-operator');
});

test('expired, revoked, unknown and disabled-customer licenses reject scope changes without modifying data', async t => {
  const f = await fixture(t), l = await f.license(), original = { ...f.row(l.id) };
  f.db.prepare('UPDATE licenses SET expires_at=? WHERE id=?').run(Date.now() - 1, l.id);
  const expired = await f.update(l.id, both(f.matters[0]));
  assert.equal(expired.status, 409); assert.match(expired.body.error, /续期/);
  f.db.prepare("UPDATE licenses SET expires_at=?,status='revoked' WHERE id=?").run(original.expires_at, l.id);
  assert.equal((await f.update(l.id, both(f.matters[0]))).status, 404);
  assert.equal((await f.api('/api/admin/licenses/nonexistent/scope', { ...onlyA(), expectedScope: onlyA() })).status, 404);
  f.db.prepare("UPDATE licenses SET status='active' WHERE id=?").run(l.id);
  f.db.prepare('UPDATE customers SET enabled=0 WHERE id=?').run(f.customerId);
  assert.equal((await f.update(l.id, both(f.matters[0]))).status, 409);
  assert.deepEqual({ ...f.row(l.id) }, original);
  assert.equal(f.auditRows(l.id).length, 0);
});

test('scope audit records exact before/after permissions but no activation credential; no-op requests do not add audit rows', async t => {
  const f = await fixture(t), l = await f.license(), before = f.scope(l.id);
  let result = await f.update(l.id, before);
  assert.equal(result.status, 200); assert.equal(result.body.changed, false); assert.equal(result.body.requiresOfflineReissue, false);
  assert.equal(f.auditRows(l.id).length, 0);
  const after = both(f.matters[0]); result = await f.update(l.id, after);
  assert.equal(result.status, 200); assert.equal(result.body.changed, true);
  const events = f.auditRows(l.id); assert.equal(events.length, 1);
  assert.equal(events[0].target_type, 'license'); assert.equal(events[0].target_id, l.id);
  const metadata = JSON.parse(events[0].metadata_json);
  assert.deepEqual(metadata.before, before); assert.deepEqual(metadata.after, after);
  assert.equal(JSON.stringify(metadata).includes(l.activationCode), false);
  assert.equal(/password|signature|code_hash|activationCode|offlineKey/.test(JSON.stringify(metadata)), false);
  result = await f.update(l.id, after);
  assert.equal(result.status, 200); assert.equal(result.body.changed, false);
  assert.equal(f.auditRows(l.id).length, 1);
});
