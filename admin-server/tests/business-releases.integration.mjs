import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, chmod } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createPackage } from '@electron/asar';
import { DatabaseSync } from 'node:sqlite';
import { createAdminServer } from '../app.mjs';
import { createBusinessOssStorage } from '../business-oss.mjs';
import { businessTarget, inspectBusinessAsar, validateBusinessMetadata } from '../business-asar.mjs';
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { endpoint: 'oss-cn-shenzhen.aliyuncs.com', bucket: 'fixture-bucket', prefix: 'data-fusion/updates/windows-x64/', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
const target = { platform: 'win32', arch: 'x64', variant: 'standard', electronMajor: 44 };
const metadata = (version = '1.1.0', value = target) => ({ schema: 1, product: 'data-fusion-desktop', version, minShellVersion: '1.1.0', target: value,
  backend: { origin: 'https://new-backend.example.invalid', revision: 2 }, entry: 'out/main/index.js' });
function mockOss() {
  const objects = new Map(), calls = []; let pauseLatest;
  const storage = createBusinessOssStorage(config, { fetcher: async (url, options) => {
    const parsed = new URL(url), key = decodeURIComponent(parsed.pathname).slice(1), item = objects.get(key); calls.push({ key, method: options.method, acl: options.headers['x-oss-object-acl'], forbidOverwrite: options.headers['x-oss-forbid-overwrite'] });
    assert(parsed.hostname === config.bucket + '.' + config.endpoint); assert.match(options.headers.authorization, /^OSS4-HMAC-SHA256 /);
    if (options.method === 'HEAD') return item ? new Response(null, { status: 200, headers: { etag: item.etag, 'content-length': String(item.body.length), 'x-oss-meta-sha256': item.sha256 } }) : new Response(null, { status: 404 });
    if (options.method === 'GET') {
      const headers = options.headers['accept-encoding'] === 'identity' ? { etag: item?.etag } : {};
      return item ? new Response(item.body, { headers }) : new Response(null, { status: 404 });
    }
    assert.equal(options.method, 'PUT');
    if (parsed.search === '?acl') { assert(item); item.acl = options.headers['x-oss-object-acl']; return new Response(null); }
    if (pauseLatest && key.endsWith('/latest.json')) await pauseLatest();
    const current = objects.get(key);
    if (options.headers['if-match'] || options.headers['if-none-match']) return new Response(null, { status: 400 });
    if (options.headers['x-oss-forbid-overwrite'] === 'true' && current) return new Response(null, { status: 409 });
    let body;
    if (Buffer.isBuffer(options.body)) body = options.body;
    else { const chunks = []; for await (const chunk of options.body) chunks.push(chunk); body = Buffer.concat(chunks); }
    assert.equal(Number(options.headers['content-length']), body.length);
    assert.equal(options.headers['content-md5'], createHash('md5').update(body).digest('base64'));
    objects.set(key, { body, sha256: options.headers['x-oss-meta-sha256'], acl: options.headers['x-oss-object-acl'], etag: '"' + createHash('md5').update(body).digest('hex') + '"' });
    return new Response(null);
  } });
  return { storage, objects, calls, setPause: fn => { pauseLatest = fn; } };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-business-release-')), dataPath = join(directory, 'admin.sqlite');
  const oss = mockOss();
  const server = createAdminServer({ dataPath, privateKey, initialPassword: password, captchaFactory, updatePublicOrigin: 'https://updates.example.invalid',
    businessReleaseDirectory: join(directory, 'business-releases'), businessOssStorage: oss.storage, ...options });
  await new Promise(resolveValue => server.listen(0, '127.0.0.1', resolveValue)); const base = 'http://127.0.0.1:' + server.address().port; let cookie = '';
  async function api(path, body, method = body === undefined ? 'GET' : 'POST', token = cookie, headers = {}) {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: token, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function login(username = 'admin') {
    const input = await loginCaptcha(base, { username, password });
    const response = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', cookie: input.token }, body: JSON.stringify(input.body) });
    assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0]; await response.json();
  }
  async function pack(version = '1.1.0', custom = {}) {
    const stage = await mkdtemp(join(directory, 'payload-')); await mkdir(join(stage, 'out/main'), { recursive: true });
    await writeFile(join(stage, 'business.json'), custom.metadataText ?? JSON.stringify(custom.metadata ?? metadata(version, custom.target ?? target)));
    await writeFile(join(stage, 'out/main/index.js'), 'module.exports = "synthetic business only";');
    const path = stage + '.asar'; await createPackage(stage, path); return readFile(path);
  }
  async function upload(version = '1.1.0', options = {}) {
    const bytes = options.bytes ?? await pack(version, options);
    const query = new URLSearchParams({ version, filename: `business-${version}.asar`, ...(options.target ?? target), ...options.query });
    const response = await fetch(base + '/api/admin/business-releases/upload?' + query, { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie, ...options.headers }, body: bytes });
    return { status: response.status, body: await response.json(), bytes };
  }
  await login();
  t.after(async () => { await new Promise(resolveValue => { server.close(resolveValue); server.closeAllConnections(); }); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  return { api, upload, pack, directory, dataPath, base, oss, login, publish: (id, enabled = true) => api('/api/admin/business-releases/' + id, { enabled, confirmPassword: password }, 'PATCH') };
}

test('business ASAR draft is private and publication writes a durable signed OSS discovery entry independent of backend IP', async t => {
  const f = await fixture(t), initial = await f.api('/api/admin/bootstrap'), uploaded = await f.upload();
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body)); assert.equal(uploaded.body.status, 'draft'); assert.equal(uploaded.body.enabled, false);
  assert.equal(uploaded.body.sha256, createHash('sha256').update(uploaded.bytes).digest('hex'));
  assert.equal(uploaded.body.metadata.backend.origin, 'https://new-backend.example.invalid');
  assert.equal((await fetch(f.base + new URL(uploaded.body.url).pathname, { redirect: 'manual' })).status, 404);
  const [draftKey, draft] = [...f.oss.objects][0]; assert.equal(draft.acl, 'private'); assert.equal(f.oss.objects.size, 1);
  assert.equal((await f.api('/api/admin/business-releases/' + uploaded.body.id, { enabled: true }, 'PATCH')).status, 400);
  const published = await f.publish(uploaded.body.id); assert.equal(published.status, 200, JSON.stringify(published.body)); assert.equal(published.body.status, 'published');
  assert.equal(f.oss.objects.get(draftKey).acl, 'public-read');
  const latest = f.oss.objects.get(draftKey.replace('/1.1.0/business-1.1.0.asar', '/latest.json'));
  assert.equal(latest.acl, 'public-read'); const envelope = JSON.parse(latest.body);
  assert(verify('RSA-SHA256', Buffer.from(envelope.payload, 'base64url'), publicKey, Buffer.from(envelope.signature, 'base64url')));
  const manifest = JSON.parse(Buffer.from(envelope.payload, 'base64url'));
  assert.equal(manifest.version, '1.1.0'); assert.equal(manifest.minShellVersion, '1.1.0'); assert.deepEqual(manifest.target, target); assert.equal(manifest.backend.revision, 2);
  assert(!new URL(manifest.url).search); assert(!manifest.url.includes('updates.example.invalid')); assert(manifest.url.startsWith('https://fixture-bucket.oss-cn-shenzhen.aliyuncs.com/'));
  assert.equal(published.body.feedUrl.endsWith('/win32/x64/standard/electron-44/latest.json'), true);
  assert.equal((await fetch(f.base + `/api/business-releases/${uploaded.body.id}/business-1.1.0.asar`, { redirect: 'manual' })).headers.get('location'), manifest.url);
  const after = await f.api('/api/admin/bootstrap'); for (const name of ['customers', 'licenses', 'devices', 'updates']) assert.deepEqual(after.body[name], initial.body[name]);
  assert.equal((await f.upload()).status, 409);
});

test('business channels isolate Win7, modern Windows, ordinary ARM64 and Kirin990; only the channel head is forced', async t => {
  const f = await fixture(t);
  for (const lane of [target, { ...target, electronMajor: 22 }, { platform: 'linux', arch: 'arm64', variant: 'standard', electronMajor: 44 }, { platform: 'linux', arch: 'arm64', variant: 'kirin990', electronMajor: 44 }]) {
    const row = await f.upload('1.1.0', { target: lane }); assert.equal(row.status, 201); assert.equal((await f.publish(row.body.id)).status, 200);
  }
  assert.equal([...f.oss.objects.keys()].filter(key => key.endsWith('latest.json')).length, 4);
  const original = (await f.api('/api/admin/business-releases')).body.rows.find(row => row.target.platform === 'win32' && row.target.electronMajor === 44);
  assert.equal((await f.publish(original.id, false)).status, 409);
  const newer = await f.upload('1.1.1'); assert.equal((await f.publish(newer.body.id)).status, 200);
  assert.equal((await f.publish(original.id, false)).status, 200); assert.equal((await f.publish(original.id)).status, 409);
  assert.equal(f.oss.objects.get(decodeURIComponent(new URL(original.url).pathname).slice(1)).acl, 'private');
});

test('business targets reject non-object input without throwing', () => {
  for (const value of [null, [], false, 'win32', 44]) assert.equal(businessTarget(value), null);
  for (const target of [{ platform: 'win32', arch: 'x64', variant: 'standard', electronMajor: '44' }, { platform: 'win32', arch: 'x64', extra: true, electronMajor: 44 }])
    assert.throws(() => validateBusinessMetadata(metadata('1.1.0', target)), { status: 400 });
});

test('business upload rejects duplicate JSON identity and undeclared trailing bytes like the startup verifier', async t => {
  const f = await fixture(t);
  const duplicate = await f.pack('1.1.0', { metadataText: JSON.stringify(metadata()).replace('"schema":1', '"schema":0,"schema":1') });
  assert.equal((await f.upload('1.1.0', { bytes: duplicate })).status, 400);
  const trailing = Buffer.concat([await f.pack(), Buffer.from('undeclared')]);
  assert.equal((await f.upload('1.1.0', { bytes: trailing })).status, 400);
  assert.equal((await f.api('/api/admin/business-releases')).body.rows.length, 0); assert.equal(f.oss.objects.size, 0);
});

test('uploaded business metadata and archive paths are checked before storing drafts', async t => {
  const f = await fixture(t);
  for (const value of [null, { ...metadata(), product: 'other' }, { ...metadata(), entry: '../escape.js' }, { ...metadata(), backend: { origin: 'http://unsafe.invalid', revision: 2 } }, { ...metadata(), target: null }, { ...metadata(), target: { ...target, electronMajor: 22 } }]) {
    const bytes = await f.pack('1.1.0', { metadata: value === null ? {} : value });
    assert.equal((await f.upload('1.1.0', { bytes })).status, 400);
  }
  for (const query of [{ variant: 'other' }, { platform: 'linux', electronMajor: 22 }, { arch: 'arm64' }, { filename: 'any.asar' }]) assert.equal((await f.upload('1.1.0', { query })).status, 400);
  const raw = Buffer.alloc(64); assert.equal((await f.upload('1.1.0', { bytes: raw })).status, 400);
  assert.equal((await f.api('/api/admin/business-releases')).body.rows.length, 0);
  assert.deepEqual(await readdir(join(f.directory, 'business-releases')), []);
  const bytes = await f.pack(), path = join(f.directory, 'changed.asar'); await writeFile(path, bytes);
  const parsed = await inspectBusinessAsar(path, { version: '1.1.0', target }); assert.equal(parsed.entries, 2);
  // Mutating the ASAR pickle size cannot trigger allocation of an attacker-controlled header.
  bytes.writeUInt32LE(0x7fffffff, 4); await writeFile(path, bytes); await assert.rejects(inspectBusinessAsar(path), { status: 400 });
});

test('public business listing remains read-only and write routes retain administrator, origin, format and password checks', async t => {
  const f = await fixture(t), bytes = await f.pack();
  assert.equal((await f.api('/api/admin/business-releases', undefined, 'GET', '')).status, 401);
  const row = await f.upload();
  assert.equal((await f.api('/api/admin/business-releases/' + row.body.id, { enabled: true, confirmPassword: 'wrong' }, 'PATCH')).status, 400);
  const query = new URLSearchParams({ version: '1.1.1', filename: 'business-1.1.1.asar', ...target });
  assert.equal((await fetch(f.base + '/api/admin/business-releases/upload?' + query, { method: 'POST', headers: { 'content-type': 'application/octet-stream', origin: 'https://attacker.invalid' }, body: bytes })).status, 403);
  assert.equal((await f.api('/api/admin/business-releases/upload?' + query, {}, 'POST')).status, 415);
  await f.api('/api/admin/users', { username: 'viewer-fixture', password, role: 'viewer' }); await f.login('viewer-fixture');
  assert.equal((await f.api('/api/admin/business-releases')).status, 200);
  assert.equal((await f.api('/api/admin/business-releases/' + row.body.id, { enabled: true, confirmPassword: password }, 'PATCH')).status, 403);
});

test('channel publication is serialized and persistent version floors reject stale publishing', async t => {
  const f = await fixture(t), first = await f.upload(), second = await f.upload('1.1.1');
  let release, entered; const waiting = new Promise(resolveValue => { release = resolveValue; }), started = new Promise(resolveValue => { entered = resolveValue; });
  f.oss.setPause(async () => { entered(); await waiting; }); const pending = f.publish(first.body.id); await started;
  assert.equal((await f.publish(second.body.id)).status, 409); release(); assert.equal((await pending).status, 200); f.oss.setPause(null);
  assert.equal((await f.publish(second.body.id)).status, 200);
  assert.deepEqual(f.oss.calls.filter(call => call.method === 'PUT' && call.key.endsWith('/latest.json')).map(call => call.forbidOverwrite), ['true', undefined]);
  const db = new DatabaseSync(f.dataPath);
  try { assert.equal(db.prepare("SELECT max_version FROM business_release_channels WHERE lane='win32/x64/standard/electron-44'").get().max_version, '1.1.1');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0); } finally { db.close(); }
  assert.equal((await f.publish(first.body.id)).status, 409);
});

test('published backend address revisions cannot decrease and changing origin requires a higher revision', async t => {
  const f = await fixture(t), first = await f.upload(); assert.equal((await f.publish(first.body.id)).status, 200);
  for (const [version, backend] of [['1.1.1', { origin: 'https://old-backend.example.invalid', revision: 1 }], ['1.1.2', { origin: 'https://other-backend.example.invalid', revision: 2 }]]) {
    const row = await f.upload(version, { metadata: { ...metadata(version), backend } }); assert.equal(row.status, 201); assert.equal((await f.publish(row.body.id)).status, 409);
  }
  const moved = await f.upload('1.1.3', { metadata: { ...metadata('1.1.3'), backend: { origin: 'https://other-backend.example.invalid', revision: 3 } } });
  assert.equal((await f.publish(moved.body.id)).status, 200);
  const latest = [...f.oss.objects].find(([key]) => key.endsWith('/latest.json'))[1];
  assert.equal(JSON.parse(Buffer.from(JSON.parse(latest.body).payload, 'base64url')).backend.revision, 3);
});

test('ASAR traversal, aliases, links, native/private files, overlapping and out-of-range contents fail before becoming drafts', async t => {
  const f = await fixture(t), original = await f.pack(), oldHeaderSize = original.readUInt32LE(4);
  for (const mutate of [
    root => { root.extra = true; },
    root => { root.files['../escape.js'] = { size: 0, offset: '0' }; },
    root => { root.files['unsafe?.js'] = { size: 0, offset: '0' }; },
    root => { root.files['BUSINESS.JSON'] = { size: 0, offset: '0' }; },
    root => { root.files.out.files.main.files['index.js'].link = '../../escape.js'; },
    root => { root.files.out.files.main.files['index.js'].unpacked = true; },
    root => { root.files['private-key.pem'] = { size: 0, offset: '0' }; },
    root => { root.files['credentials.secure.json'] = { size: 0, offset: '0' }; },
    root => { root.files['database.node'] = { size: 0, offset: '0' }; },
    root => { root.files.out.files.main.files['index.js'].offset = root.files['business.json'].offset; },
    root => { root.files.out.files.main.files['index.js'].offset = '999999999'; },
  ]) {
    const root = JSON.parse(original.subarray(16, 16 + original.readUInt32LE(12))); mutate(root);
    const json = Buffer.from(JSON.stringify(root)), headerSize = Math.ceil((json.length + 8) / 4) * 4, header = Buffer.alloc(8 + headerSize);
    header.writeUInt32LE(4, 0); header.writeUInt32LE(headerSize, 4); header.writeUInt32LE(headerSize - 4, 8); header.writeUInt32LE(json.length, 12); json.copy(header, 16);
    const bad = Buffer.concat([header, original.subarray(8 + oldHeaderSize)]);
    assert.equal((await f.upload('1.1.0', { bytes: bad })).status, 400);
  }
  assert.equal((await f.api('/api/admin/business-releases')).body.rows.length, 0); assert.equal(f.oss.objects.size, 0);
});

test('publication rechecks stored payload bytes and refuses an untrusted existing OSS manifest', async t => {
  const f = await fixture(t), row = await f.upload();
  const path = join(f.directory, 'business-releases', row.body.id + '.asar'); await chmod(path, 0o600); await writeFile(path, Buffer.alloc(row.bytes.length));
  assert.equal((await f.publish(row.body.id)).status, 409); assert.equal([...f.oss.objects.values()][0].acl, 'private');
  const next = await f.upload('1.1.1'); assert.equal((await f.publish(next.body.id)).status, 200);
  const latestKey = [...f.oss.objects.keys()].find(key => key.endsWith('/latest.json')); const latest = f.oss.objects.get(latestKey);
  const envelope = JSON.parse(latest.body); envelope.signature = 'untrusted'; latest.body = Buffer.from(JSON.stringify(envelope));
  const candidate = await f.upload('1.1.2'); assert.equal((await f.publish(candidate.body.id)).status, 409);
  assert.equal((await f.api('/api/admin/business-releases')).body.rows.find(value => value.id === candidate.body.id).status, 'draft');
});
