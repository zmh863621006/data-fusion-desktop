import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAdminServer } from '../app.mjs';
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const userAgent = 'Fusion password-manager test browser';
const digest = value => createHash('sha256').update(value).digest('hex');
const cookie = (result, name) => result.cookies.find(value => value.startsWith(`${name}=`))?.split(';')[0] ?? '';
const jar = result => cookie(result, 'df_admin');
async function start(options = {}) {
  const server = createAdminServer({ dataPath: ':memory:', privateKey, initialPassword: password, captchaFactory, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(path, body, token = '', headers = {}, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', 'user-agent': userAgent, cookie: token, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
  }
  async function login(values = {}, token = '') {
    const input = await loginCaptcha(base, { username: 'admin', password, ...values }, token);
    return api('/api/admin/login', input.body, input.token);
  }
  const restore = (token, headers = {}) => api('/api/admin/session/restore', {}, token, headers);
  return { api, login, restore, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
async function fixture(t, options) { const f = await start(options); t.after(f.close); return f; }
async function diskFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-login-retirement-')), dataPath = join(directory, 'admin.sqlite');
  let f = await start({ dataPath, ...options });
  t.after(async () => {
    await f.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), 'fusion-login-retirement-')));
    await rm(directory, { recursive: true, force: true });
  });
  return { get f() { return f; }, dataPath, async restart(beforeStart) { await f.close(); beforeStart?.(); f = await start({ dataPath, ...options }); } };
}

test('password login never issues a persistent device token, including requests from cached old pages', async t => {
  const f = await fixture(t);
  for (const remember of [undefined, false, true, 'true']) {
    const result = await f.login(remember === undefined ? {} : { remember });
    assert.equal(result.status, 200);
    assert.ok(cookie(result, 'df_admin'));
    assert.ok(result.cookies.some(value => value.startsWith('df_remember=;') && value.includes('Max-Age=0')));
    assert.equal((await f.restore('df_remember=' + 'x'.repeat(43))).body.code, 'PASSWORD_LOGIN_REQUIRED');
  }
  assert.equal((await f.login({ password: 'wrong', remember: true })).status, 401);
  assert.equal((await f.api('/api/admin/login', { username: 'admin', password, remember: true })).body.code, 'CAPTCHA_INVALID');
});

test('ordinary login keeps its eight-hour HttpOnly Strict cookie and does not expose passwords', async t => {
  const disk = await diskFixture(t, { secureCookie: true });
  const result = await disk.f.login();
  assert.equal(result.status, 200);
  assert.match(result.cookies.find(value => value.startsWith('df_admin=')), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800; Secure$/);
  const db = new DatabaseSync(disk.dataPath, { readOnly: true });
  try {
    const session = db.prepare('SELECT * FROM admin_sessions').get();
    assert.equal(session.remember_device_id, null);
    assert.equal(session.expires_at - session.created_at, 8 * 60 * 60 * 1000);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_remember_devices'").get(), undefined);
  } finally { db.close(); }
  for (const path of ['/api/admin/bootstrap', '/api/admin/sessions', '/api/admin/security-events']) {
    const value = await disk.f.api(path, undefined, jar(result));
    assert.equal(value.status, 200);
    assert.equal(JSON.stringify(value.body).includes(password), false);
  }
});

test('existing short passwords continue to authenticate without applying the new-password minimum', async t => {
  const disk = await diskFixture(t), existingPassword = 'Abc@2026x';
  await disk.restart(() => {
    const salt = randomBytes(16);
    const stored = `s2:${salt.toString('base64url')}:${scryptSync(existingPassword, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 }).toString('base64url')}`;
    const db = new DatabaseSync(disk.dataPath);
    try { db.prepare('UPDATE admin_users SET password_hash=?').run(stored); }
    finally { db.close(); }
  });
  const loggedIn = await disk.f.login({ password: existingPassword });
  assert.equal(loggedIn.status, 200);
  assert.equal((await disk.f.api('/api/admin/bootstrap', undefined, jar(loggedIn))).status, 200);
});

test('idle and maximum session expiry require password login; legacy restore can never revive a session', async t => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now });
  const first = await f.login();
  now += 31 * 60_000;
  assert.equal((await f.api('/api/admin/bootstrap', undefined, jar(first))).status, 401);
  assert.equal((await f.restore(jar(first) + '; df_remember=' + 'x'.repeat(43))).status, 401);
  const second = await f.login();
  for (let step = 0; step < 23; step++) {
    now += 20 * 60_000;
    assert.equal((await f.api('/api/admin/bootstrap', undefined, jar(second))).status, 200);
  }
  now += 20 * 60_000 + 1;
  assert.equal((await f.api('/api/admin/bootstrap', undefined, jar(second))).status, 401);
  assert.equal((await f.restore(jar(second))).status, 401);
});

test('upgrade revokes old devices and their derived sessions but preserves ordinary sessions, passwords and business data', async t => {
  const disk = await diskFixture(t);
  const ordinary = await disk.f.login();
  const customer = await disk.f.api('/api/admin/customers', { name: 'Retained customer' }, jar(ordinary));
  assert.equal(customer.status, 201);
  const oldToken = randomBytes(32).toString('base64url'), oldSession = randomBytes(32).toString('base64url');
  let passwordHash;
  await disk.restart(() => {
    const db = new DatabaseSync(disk.dataPath);
    try {
      const user = db.prepare('SELECT * FROM admin_users').get(); passwordHash = user.password_hash;
      const deviceId = randomUUID(), timestamp = Date.now();
      db.exec(`CREATE TABLE admin_remember_devices(
        id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL,
        agent_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES admin_users(id));`);
      db.prepare('INSERT INTO admin_remember_devices VALUES(?,?,?,?,?,?,?)')
        .run(deviceId, digest(oldToken), user.id, digest(userAgent), timestamp, timestamp, timestamp + 7 * 86400000);
      db.prepare('INSERT INTO admin_sessions(token_hash,user_id,expires_at,created_at,id,last_seen_at,ip_address,user_agent,remember_device_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(digest(oldSession), user.id, timestamp + 8 * 3600000, timestamp, randomUUID(), timestamp, '127.0.0.1', userAgent, deviceId);
    } finally { db.close(); }
  });
  assert.equal((await disk.f.api('/api/admin/bootstrap', undefined, 'df_admin=' + oldSession)).status, 401);
  assert.equal((await disk.f.restore('df_remember=' + oldToken)).status, 401);
  const bootstrap = await disk.f.api('/api/admin/bootstrap', undefined, jar(ordinary));
  assert.equal(bootstrap.status, 200);
  assert.ok(bootstrap.body.customers.some(row => row.id === customer.body.id));
  const db = new DatabaseSync(disk.dataPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM admin_remember_devices').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM admin_sessions WHERE remember_device_id IS NOT NULL').get().n, 0);
    assert.equal(db.prepare('SELECT password_hash FROM admin_users').get().password_hash, passwordHash);
  } finally { db.close(); }
  await disk.restart();
  assert.equal((await disk.f.api('/api/admin/bootstrap', undefined, jar(ordinary))).status, 200, 'cleanup is repeatable');
});

test('retired restore clears only the old device cookie, never a live ordinary session, and logout clears authentication', async t => {
  const f = await fixture(t), loggedIn = await f.login();
  const result = await f.restore(jar(loggedIn) + '; df_remember=' + 'x'.repeat(43));
  assert.equal(result.status, 401);
  assert.equal(result.cookies.length, 1);
  assert.match(result.cookies[0], /^df_remember=;.*Max-Age=0/);
  assert.equal((await f.api('/api/admin/bootstrap', undefined, jar(loggedIn))).status, 200);
  const out = await f.api('/api/admin/logout', {}, jar(loggedIn));
  assert.equal(out.status, 200);
  for (const name of ['df_admin', 'df_remember']) assert.ok(out.cookies.some(value => value.startsWith(name + '=;') && value.includes('Max-Age=0')));
  assert.equal((await f.api('/api/admin/bootstrap', undefined, jar(loggedIn))).status, 401);
});

test('retired restore still rejects cross-site requests and is rate limited without authenticating any token', async t => {
  const f = await fixture(t), token = 'df_remember=' + 'x'.repeat(43);
  assert.equal((await f.restore(token, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await f.restore(token, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.api('/api/admin/session/restore', undefined, token)).status, 404);
  for (let i = 0; i < 29; i++) assert.equal((await f.restore(token)).status, 401);
  assert.equal((await f.restore(token)).status, 429);
});
