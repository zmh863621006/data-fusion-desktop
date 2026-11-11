import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readdir, rm, chmod, writeFile, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { createAdminServer } from '../app.mjs';
import { updatePublicOrigin, createUpdateReleases } from '../update-releases.mjs';
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
function installer() {
  const bytes = Buffer.alloc(4096, 0x31); bytes.write('MZ'); bytes.writeUInt32LE(128, 0x3c);
  bytes.set([80,69,0,0], 128); bytes.writeUInt16LE(0x14c, 132); bytes.writeUInt16LE(0x10b, 152);
  bytes.set(Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex'), 1024);
  return bytes;
}
function tar(entries) {
  const blocks = [];
  for (const [name, contents] of entries) {
    const body = Buffer.from(contents), header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    const sum = header.reduce((total, value) => total + value, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
function deb(version = '1.0.3', arch = 'x64', { elfArch = arch, packageName = 'data-fusion-desktop', executable = true } = {}) {
  const elf = Buffer.alloc(64); elf.write('\x7fELF'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(elfArch === 'x64' ? 62 : 183, 18);
  const members = [
    ['debian-binary', Buffer.from('2.0\n')],
    ['control.tar.gz', gzipSync(tar([['./control', `Package: ${packageName}\nVersion: ${version}\nArchitecture: ${arch === 'x64' ? 'amd64' : 'arm64'}\n`], ['./postinst', '#!/bin/sh\nexit 99\n']]))],
    ['data.tar.gz', gzipSync(tar([[executable ? './opt/data-fusion/data-fusion' : './opt/data-fusion/other-file', elf]]))],
  ];
  const blocks = [Buffer.from('!<arch>\n')];
  for (const [name, bytes] of members) {
    const header = (name + '/').padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(bytes.length).padEnd(10) + '`\n';
    assert.equal(header.length, 60); blocks.push(Buffer.from(header), bytes, ...(bytes.length % 2 ? [Buffer.from('\n')] : []));
  }
  return Buffer.concat(blocks);
}
async function until(work, message = 'fixture condition') {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await work()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Timed out: ${message}`);
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-update-release-')), releaseDirectory = join(directory, 'releases');
  const dataPath = join(directory, 'admin.sqlite');
  const server = createAdminServer({ dataPath, releaseDirectory, privateKey, initialPassword: password, captchaFactory,
    updatePublicOrigin: 'https://updates.example.invalid', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function api(path, body, method = body === undefined ? 'GET' : 'POST', token = cookie, headers = {}) {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: token, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function login(username = 'admin') {
    const input = await loginCaptcha(base, { username, password });
    const response = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', cookie: input.token }, body: JSON.stringify(input.body) });
    assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0]; await response.json(); return cookie;
  }
  await login();
  async function upload(version = '1.0.3', bytes = installer(), extra = {}) {
    const query = new URLSearchParams({ version, filename: `DataFusion-Setup-${version}-x64.exe`, notes: '自动更新测试说明', ...extra.query });
    const response = await fetch(base + '/api/admin/updates/upload?' + query, { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie, ...extra.headers }, body: bytes });
    return { status: response.status, body: await response.json() };
  }
  async function client() {
    const customer = await api('/api/admin/customers', { name: 'Release fixture' });
    const license = await api('/api/admin/licenses', { customerId: customer.body.id, mode: 'online', expiresAt: Date.now() + 86400000,
      allowedSystems: [], allowedTools: ['health-publicity'], maxDevices: 1, allowAutoUpdate: true });
    const deviceId = 'f'.repeat(64);
    const activated = await api('/api/activate', { key: license.body.activationCode, deviceId });
    assert.equal(activated.status, 200);
    return { licenseId: license.body.id, deviceId, proof: activated.body };
  }
  async function manifest(identity) {
    const value = await api('/api/updates/manifest', identity, 'POST', '');
    assert.equal(value.status, 200); assert.equal(verify('RSA-SHA256', Buffer.from(value.body.payload, 'base64url'), publicKey, Buffer.from(value.body.signature, 'base64url')), true);
    return JSON.parse(Buffer.from(value.body.payload, 'base64url'));
  }
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert(directory.startsWith(join(tmpdir(), 'fusion-update-release-')));
    await rm(directory, { recursive: true, force: true });
  });
  return { api, upload, login, base, client, manifest, directory, releaseDirectory, dataPath, cookie: () => cookie };
}

test('installer upload is private draft, server hashes bytes, fixed HTTPS origin ignores Host and signed manifest excludes drafts', async t => {
  const f = await fixture(t), bytes = installer(), identity = await f.client();
  const value = await f.upload('1.0.3', bytes, { headers: { host: 'evil.example.invalid' } });
  assert.equal(value.status, 201); assert.equal(value.body.enabled, 0); assert.equal(value.body.status, 'draft'); assert.equal(value.body.managed, true);
  assert.equal(value.body.bytes, bytes.length); assert.equal(value.body.fileName, 'DataFusion-Setup-1.0.3-x64.exe');
  assert.equal(value.body.sha256, createHash('sha256').update(bytes).digest('hex')); assert.match(value.body.url, /^https:\/\/updates\.example\.invalid\/api\/releases\//);
  assert.equal((await fetch(f.base + new URL(value.body.url).pathname)).status, 404);
  assert.equal((await f.manifest(identity)).app, undefined);
  const bootstrap = await f.api('/api/admin/bootstrap'); assert.equal(bootstrap.body.updates[0].status, 'draft');
  assert.equal((await readdir(f.releaseDirectory)).length, 1); assert.match((await readdir(f.releaseDirectory))[0], /^[\da-f-]{36}\.exe$/);
});

test('publishing requires password and returns compatible signed update info; disabling blocks new manifest and downloads but keeps file', async t => {
  const f = await fixture(t), identity = await f.client(), value = await f.upload();
  assert.equal((await f.api(`/api/admin/updates/${value.body.id}`, { enabled: true }, 'PATCH')).status, 400);
  assert.equal((await f.api(`/api/admin/updates/${value.body.id}`, { enabled: true, confirmPassword: password }, 'PATCH')).status, 200);
  const result = (await f.manifest(identity)).app;
  assert.deepEqual(result, { id: value.body.id, version: '1.0.3', url: value.body.url, sha256: value.body.sha256, notes: '自动更新测试说明', bytes: 4096, fileName: value.body.fileName,
    installer: 'nsis', platform: 'win32', arch: 'x64' });
  assert.equal((await f.api('/api/admin/bootstrap')).body.updates[0].status, 'published');
  const download = await fetch(f.base + new URL(result.url).pathname); assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), installer());
  assert.equal((await f.api(`/api/admin/updates/${value.body.id}`, { enabled: false, confirmPassword: password }, 'PATCH')).status, 200);
  assert.equal((await f.api('/api/admin/bootstrap')).body.updates[0].status, 'disabled');
  assert.equal((await f.manifest(identity)).app, undefined); assert.equal((await fetch(f.base + new URL(result.url).pathname)).status, 404);
  assert.equal((await readdir(f.releaseDirectory)).length, 1);
});

test('public GET/HEAD/range/ETag download cannot traverse files or download a mismatched name', async t => {
  const f = await fixture(t), value = await f.upload();
  await f.api(`/api/admin/updates/${value.body.id}`, { enabled: true, confirmPassword: password }, 'PATCH');
  const path = new URL(value.body.url).pathname;
  const head = await fetch(f.base + path, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '4096'); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.match(head.headers.get('content-disposition'), /DataFusion-Setup-1\.0\.3-x64\.exe/);
  for (const [range, start, end] of [['bytes=0-31',0,31],['bytes=4000-',4000,4095],['bytes=-16',4080,4095],['bytes=4080-99999',4080,4095]]) {
    const response = await fetch(f.base + path, { headers: { range } }); assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/4096`); assert.deepEqual(Buffer.from(await response.arrayBuffer()), installer().subarray(start, end + 1));
  }
  for (const range of ['bytes=5000-', 'bytes=3-2', 'bytes=-0', 'bytes=0-1,5-6', 'bytes=oops', 'bytes=9007199254740992-']) {
    const response = await fetch(f.base + path, { headers: { range } }); assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */4096'); await response.arrayBuffer();
  }
  const staleRange = await fetch(f.base + path, { headers: { range: 'bytes=0-1', 'if-range': 'different' } }); assert.equal(staleRange.status, 200); await staleRange.arrayBuffer();
  const unchanged = await fetch(f.base + path, { headers: { 'if-none-match': head.headers.get('etag') } }); assert.equal(unchanged.status, 304);
  assert.equal((await fetch(f.base + path.replace('1.0.3', '9.9.9'))).status, 404);
  assert.equal((await fetch(f.base + `/api/releases/${value.body.id}/..%2F..%2Fadmin.sqlite`)).status, 404);
});

test('Chinese installer names survive upload, publication, signed manifest and UTF-8 downloads', async t => {
  const f = await fixture(t), identity = await f.client();
  const name = '数据融合助手-安装包-1.0.12-x64.exe';
  const value = await f.upload('1.0.12', installer(), { query: { filename: name } });
  assert.equal(value.status, 201); assert.equal(value.body.fileName, name);
  const path = new URL(value.body.url).pathname;
  assert.equal(decodeURIComponent(path.split('/').at(-1)), name);
  assert.equal((await fetch(f.base + path)).status, 404);
  assert.equal((await f.api(`/api/admin/updates/${value.body.id}`, { enabled: true, confirmPassword: password }, 'PATCH')).status, 200);
  const manifest = (await f.manifest(identity)).app;
  assert.equal(manifest.fileName, name); assert.equal(manifest.url, value.body.url);
  const response = await fetch(f.base + path);
  assert.equal(response.status, 200);
  assert.equal(decodeURIComponent(response.headers.get('content-disposition').split("filename*=UTF-8''")[1]), name);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), installer());
  const range = await fetch(f.base + path, { headers: { range: 'bytes=0-31' } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
  assert.equal((await fetch(f.base + path.replace('1.0.12', '1.0.13'))).status, 404);
  assert.equal((await fetch(f.base + path.replace(encodeURIComponent(name), '%E0%A4'))).status, 404);
  assert.equal((await f.upload('1.0.13', installer(), { query: { filename: name } })).status, 400);
});

test('unauthenticated, operator, viewer and cross-site requests cannot upload, publish or modify releases', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload('1.0.3', installer(), { headers: { cookie: '' } })).status, 401);
  assert.equal((await f.upload('1.0.3', installer(), { headers: { origin: 'https://evil.example.invalid' } })).status, 403);
  assert.equal((await f.upload('1.0.3', installer(), { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await f.upload('1.0.3', installer(), { headers: { 'content-type': 'application/json' } })).status, 415);
  for (const role of ['operator','viewer']) {
    await f.api('/api/admin/users', { username: role, role, password }); await f.login(role);
    assert.equal((await f.upload()).status, 403); await f.login();
  }
  assert.equal((await f.api('/api/admin/bootstrap')).body.updates.length, 0);
});

test('invalid Windows/PE/NSIS bytes, SHA mismatch and malformed metadata are rejected without retaining files or records', async t => {
  const f = await fixture(t);
  for (const bytes of [Buffer.alloc(4096), (() => { const b = installer(); b.writeUInt32LE(0x7fffffff, 60); return b; })(), (() => { const b = installer(); b.fill(0,1024,1040); return b; })()]) {
    assert.equal((await f.upload('1.0.3', bytes)).status, 400);
  }
  assert.equal((await f.upload('1.0.3', installer(), { headers: { 'x-content-sha256': 'a'.repeat(64) } })).status, 400);
  assert.equal((await f.upload('1.0.3', installer(), { headers: { 'x-content-sha256': 'not-sha' } })).status, 400);
  assert.equal((await f.upload('1.0.3', installer(), { query: { filename: '../bad.exe' } })).status, 400);
  assert.equal((await f.upload('1.0.3oops')).status, 400);
  assert.equal((await f.upload('1.0.3', installer(), { query: { notes: 'x'.repeat(1001) } })).status, 400);
  assert.deepEqual(await readdir(f.releaseDirectory), []); assert.equal((await f.api('/api/admin/bootstrap')).body.updates.length, 0);
});

test('size limits, missing configured storage/origin and invalid origin fail closed without writing artifacts', async t => {
  const f = await fixture(t, { updateMaxBytes: 1024 }); assert.equal((await f.upload()).status, 413);
  const missing = await fixture(t, { updatePublicOrigin: undefined, publicOrigin: undefined }); assert.equal((await missing.upload()).status, 503);
  for (const value of ['https://example.test/', 'https://user:password@example.test', 'file:///C:/bad', 'http://example.test/path', 'https://example.test?token=x', 'https://example.test#hash']) assert.throws(() => updatePublicOrigin(value));
  assert.equal(updatePublicOrigin('http://193.112.96.168:9087'), 'http://193.112.96.168:9087');
});

test('fixed HTTP public origin is supported separately from management origin and existing HTTPS-link releases remain compatible', async t => {
  const f = await fixture(t, { updatePublicOrigin: 'http://193.112.96.168:9087', publicOrigin: 'https://management.example.invalid' });
  const value = await f.upload(); assert.match(value.body.url, /^http:\/\/193\.112\.96\.168:9087\/api\/releases\//);
  assert.equal((await f.api('/api/admin/updates', { version: '1.0.4', url: 'https://existing.example.invalid/1.0.4.exe', sha256: 'a'.repeat(64), confirmPassword: password })).status, 201);
  assert.equal((await f.api('/api/admin/updates', { version: '1.0.3', url: 'https://evil.example.invalid/replace.exe', sha256: 'a'.repeat(64), confirmPassword: password })).status, 409);
  assert.equal((await f.upload('1.0.4')).status, 409);
});

test('publishing refuses a modified on-disk artifact and neither uploads nor PATCH can replace an existing version', async t => {
  const f = await fixture(t), value = await f.upload();
  assert.equal((await f.upload()).status, 409);
  const disk = join(f.releaseDirectory, (await readdir(f.releaseDirectory))[0]); await chmod(disk, 0o600);
  const corrupted = installer(); corrupted[4095] ^= 0xff; await writeFile(disk, corrupted);
  assert.equal((await f.api(`/api/admin/updates/${value.body.id}`, { enabled: true, confirmPassword: password, url: 'https://evil.invalid/payload.exe' }, 'PATCH')).status, 409);
  assert.equal((await f.api('/api/admin/bootstrap')).body.updates[0].status, 'draft');
});

test('parallel same-version uploads are rejected and cancellation cleans only its unfinished draft', async t => {
  const f = await fixture(t), bytes = installer();
  const path = '/api/admin/updates/upload?' + new URLSearchParams({ version: '1.0.3', filename: 'DataFusion-Setup-1.0.3-x64.exe' });
  const slow = httpRequest(f.base + path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: f.cookie(), 'content-length': bytes.length } });
  slow.on('error', () => {}); slow.write(bytes.subarray(0,512));
  await until(async () => (await f.api('/api/admin/bootstrap')).body.updates[0]?.status === 'uploading');
  assert.equal((await f.upload()).status, 409);
  slow.destroy(); await until(async () => (await f.api('/api/admin/bootstrap')).body.updates.length === 0, 'cancelled upload cleanup');
  assert.deepEqual(await readdir(f.releaseDirectory), []);
  assert.equal((await f.upload()).status, 201);
});

test('upload timeout removes its incomplete draft and does not publish half a file', async t => {
  const f = await fixture(t, { uploadTimeoutMs: 100 }), bytes = installer();
  const path = '/api/admin/updates/upload?' + new URLSearchParams({ version: '1.0.3', filename: 'DataFusion-Setup-1.0.3-x64.exe' });
  const slow = httpRequest(f.base + path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: f.cookie(), 'content-length': bytes.length } });
  let ended = false; slow.on('error', () => { ended = true; }); slow.on('close', () => { ended = true; }); slow.write(bytes.subarray(0,512));
  await until(() => ended, 'upload timeout');
  await until(async () => (await f.api('/api/admin/bootstrap')).body.updates.length === 0);
  assert.deepEqual(await readdir(f.releaseDirectory), []);
});

test('UTF-8 base64 release notes avoid long query strings and malformed or oversized notes fail closed', async t => {
  const f = await fixture(t), notes = '修复回流并保留企业信息。'.repeat(80);
  const value = await f.upload('1.0.3', installer(), { headers: { 'x-release-notes-base64': Buffer.from(notes).toString('base64') } });
  assert.equal(value.status, 201); assert.equal(value.body.notes, notes);
  assert.equal((await f.upload('1.0.4', installer(), { headers: { 'x-release-notes-base64': 'not base64' } })).status, 400);
  assert.equal((await f.upload('1.0.4', installer(), { headers: { 'x-release-notes-base64': Buffer.from([255,255]).toString('base64') } })).status, 400);
  assert.equal((await f.upload('1.0.4', installer(), { headers: { 'x-release-notes-base64': Buffer.from('汉'.repeat(1001)).toString('base64') } })).status, 400);
});

test('two simultaneous upload streams are bounded and a revoked login cannot complete an upload', async t => {
  const f = await fixture(t), bytes = installer();
  const slow = version => {
    const path = '/api/admin/updates/upload?' + new URLSearchParams({ version, filename: `DataFusion-Setup-${version}-x64.exe` });
    const request = httpRequest(f.base + path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: f.cookie(), 'content-length': bytes.length } });
    request.on('error', () => {}); request.write(bytes.subarray(0,512));
    return request;
  };
  const first = slow('1.0.3'), second = slow('1.0.4');
  await until(async () => (await f.api('/api/admin/bootstrap')).body.updates.length === 2);
  assert.equal((await f.upload('1.0.5')).status, 429);
  const completed = new Promise(resolve => first.once('response', response => { let data = ''; response.on('data', value => { data += value; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) })); }));
  await f.api('/api/admin/logout', {});
  first.end(bytes.subarray(512)); const result = await completed; assert.equal(result.status, 403);
  second.destroy(); await f.login();
  await until(async () => (await f.api('/api/admin/bootstrap')).body.updates.length === 0);
  assert.deepEqual(await readdir(f.releaseDirectory), []);
});

test('release migration is additive, restart keeps existing business rows, drafts and immutable artifact bytes', async t => {
  const f = await fixture(t), bytes = installer(), value = await f.upload();
  const db = new DatabaseSync(f.dataPath, { readOnly: true });
  const tables = ['customers','licenses','devices','enterprises','enterprise_requests','enterprise_history'];
  const before = Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])); db.close();
  const second = createAdminServer({ dataPath: f.dataPath, releaseDirectory: f.releaseDirectory, privateKey, updatePublicOrigin: 'https://updates.example.invalid' });
  await new Promise(resolve => second.listen(0, '127.0.0.1', resolve)); await new Promise(resolve => second.close(resolve));
  const after = new DatabaseSync(f.dataPath, { readOnly: true });
  for (const table of tables) assert.deepEqual(after.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), before[table]);
  assert.equal(after.prepare('SELECT state FROM update_artifacts WHERE update_id=?').get(value.body.id).state, 'ready'); after.close();
  assert.deepEqual(await readFile(join(f.releaseDirectory, (await readdir(f.releaseDirectory))[0])), bytes);
});

test('a new authenticated retry recovers only an expired crash-interrupted upload, never a ready or previously published version', async t => {
  const f = await fixture(t), initial = await f.upload();
  const db = new DatabaseSync(f.dataPath);
  db.prepare("UPDATE update_artifacts SET state='uploading',bytes=0,sha256='',created_at=? WHERE update_id=?").run(Date.now() - 12 * 60_000 - 1000, initial.body.id);
  db.prepare("UPDATE updates SET sha256='' WHERE id=?").run(initial.body.id); db.close();
  const recovered = await f.upload(); assert.equal(recovered.status, 201); assert.notEqual(recovered.body.id, initial.body.id);
  assert.equal((await readdir(f.releaseDirectory)).length, 1);
  assert.equal((await f.upload()).status, 409);
  await f.api(`/api/admin/updates/${recovered.body.id}`, { enabled: true, confirmPassword: password }, 'PATCH');
  await f.api(`/api/admin/updates/${recovered.body.id}`, { enabled: false, confirmPassword: password }, 'PATCH');
  assert.equal((await f.upload()).status, 409);
});

test('same-version Windows, Kylin x64 and ARM64 releases remain independent and old clients only receive Windows', async t => {
  const f = await fixture(t), identity = await f.client();
  const windows = await f.upload(); assert.equal(windows.status, 201);
  const releases = [windows.body];
  for (const arch of ['x64', 'arm64']) {
    const query = { platform: 'linux', arch, filename: `数据融合助手-麒麟版-1.0.3-${arch}.deb` };
    const uploaded = await f.upload('1.0.3', deb('1.0.3', arch), { query });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.platform, 'linux'); assert.equal(uploaded.body.arch, arch); assert.equal(uploaded.body.installer, 'deb');
    assert.equal((await f.upload('1.0.3', deb('1.0.3', arch), { query })).status, 409);
    releases.push(uploaded.body);
  }
  for (const row of releases) assert.equal((await f.api(`/api/admin/updates/${row.id}`, { enabled: true, confirmPassword: password }, 'PATCH')).status, 200);
  assert.equal((await f.manifest(identity)).app.id, windows.body.id);
  assert.equal((await f.manifest({ ...identity, platform: 'win32', arch: 'x64' })).app.installer, 'nsis');
  for (const arch of ['x64', 'arm64']) {
    const result = (await f.manifest({ ...identity, platform: 'linux', arch })).app;
    assert.equal(result.id, releases.find(row => row.platform === 'linux' && row.arch === arch).id);
    assert.equal(result.platform, 'linux'); assert.equal(result.arch, arch); assert.equal(result.installer, 'deb');
    const downloadPath = new URL(result.url).pathname;
    const download = await fetch(f.base + downloadPath); assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), deb('1.0.3', arch));
    assert(download.headers.get('content-disposition').includes(`DataFusion-Kylin-1.0.3-${arch}.deb`));
    const partial = await fetch(f.base + downloadPath, { headers: { range: 'bytes=0-7' } });
    assert.equal(partial.status, 206); assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), '!<arch>\n');
  }
  const newerArm = await f.upload('9.0.0', deb('9.0.0', 'arm64'), { query: { platform: 'linux', arch: 'arm64', filename: '数据融合助手-麒麟版-9.0.0-arm64.deb' } });
  assert.equal(newerArm.status, 201); await f.api(`/api/admin/updates/${newerArm.body.id}`, { enabled: true, confirmPassword: password }, 'PATCH');
  assert.equal((await f.manifest(identity)).app.version, '1.0.3');
  assert.equal((await f.manifest({ ...identity, platform: 'linux', arch: 'x64' })).app.version, '1.0.3');
  assert.equal((await f.manifest({ ...identity, platform: 'linux', arch: 'arm64' })).app.version, '9.0.0');
  assert.equal((await f.api('/api/updates/manifest', { ...identity, platform: 'win32', arch: 'arm64' }, 'POST', '')).status, 400);
  assert.equal((await f.api('/api/updates/manifest', { ...identity, platform: 'darwin', arch: 'x64' }, 'POST', '')).status, 400);
});

test('Kylin upload validates archive/control version and architecture plus actual ELF and rejects renamed Windows files', async t => {
  const f = await fixture(t);
  const query = { platform: 'linux', arch: 'x64', filename: '数据融合助手-麒麟版-1.0.3-x64.deb' };
  for (const invalid of [installer(), Buffer.from('!<arch>\ntruncated'), deb('1.0.4'), deb('1.0.3\nVersion: 1.0.3'), deb('1.0.3', 'arm64'),
    deb('1.0.3', 'x64', { elfArch: 'arm64' }), deb('1.0.3', 'x64', { packageName: 'other-app' }), deb('1.0.3', 'x64', { executable: false })]) {
    const value = await f.upload('1.0.3', invalid, { query });
    assert.equal(value.status, 400, JSON.stringify(value.body));
  }
  assert.equal((await f.upload('1.0.3', deb(), { query: { ...query, platform: 'win32' } })).status, 400);
  assert.equal((await f.upload('1.0.3', deb(), { query: { ...query, arch: 'mips64' } })).status, 400);
  assert.equal((await f.api('/api/admin/bootstrap')).body.updates.length, 0);
  assert.deepEqual(await readdir(f.releaseDirectory), []);
});

test('Linux external links cannot be created or emitted and existing Windows external-link API remains compatible', async t => {
  const f = await fixture(t), identity = await f.client();
  const common = { version: '1.0.3', url: 'https://existing.example.invalid/1.0.3.deb', sha256: 'a'.repeat(64), confirmPassword: password };
  assert.equal((await f.api('/api/admin/updates', { ...common, platform: 'linux', arch: 'x64' })).status, 400);
  assert.equal((await f.api('/api/admin/updates', { ...common, platform: 'linux', arch: 'arm64' })).status, 400);
  assert.equal((await f.api('/api/admin/bootstrap')).body.updates.length, 0);
  const db = new DatabaseSync(f.dataPath);
  db.prepare('INSERT INTO updates(id,target_type,version,url,sha256,published_at,enabled,platform,arch) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('legacy-linux-external', 'app', '99.0.0', common.url, common.sha256, Date.now(), 1, 'linux', 'x64'); db.close();
  assert.equal((await f.manifest({ ...identity, platform: 'linux', arch: 'x64' })).app, undefined);
  const url = 'https://existing.example.invalid/1.0.3.msi';
  assert.equal((await f.api('/api/admin/updates', { ...common, url })).status, 201);
  const result = (await f.manifest(identity)).app;
  assert.equal(result.url, url); assert.equal(result.version, common.version); assert.equal(result.installer, undefined);
  assert.equal(result.platform, undefined); assert.equal(result.arch, undefined);
});

test('legacy global-version artifact migration preserves rows and old OSS keys while permitting other architecture versions', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE updates(id TEXT PRIMARY KEY,target_type TEXT,system_id TEXT,version TEXT,url TEXT,sha256 TEXT,notes TEXT,published_at INTEGER,enabled INTEGER);
    CREATE TABLE update_artifacts(update_id TEXT PRIMARY KEY REFERENCES updates(id),version TEXT NOT NULL UNIQUE,storage_name TEXT NOT NULL UNIQUE,file_name TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,sha256 TEXT NOT NULL DEFAULT '',state TEXT NOT NULL,created_at INTEGER NOT NULL,published_once INTEGER NOT NULL DEFAULT 0,oss_key TEXT);
    CREATE TABLE retained_business(value TEXT); INSERT INTO retained_business VALUES('unmodified');`);
  const id = '11111111-1111-4111-8111-111111111111';
  db.prepare('INSERT INTO updates VALUES(?,?,?,?,?,?,?,?,?)').run(id, 'app', null, '1.0.3', 'https://old.invalid/old.exe', 'a'.repeat(64), 'old notes', 123, 1);
  db.prepare('INSERT INTO update_artifacts VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, '1.0.3', id + '.exe', 'DataFusion-Setup-1.0.3-x64.exe', 4096, 'a'.repeat(64), 'ready', 123, 1, 'apps/1.0.3/DataFusion-Setup-1.0.3-x64.exe');
  const options = { publicOrigin: 'https://updates.example.invalid', transaction: work => work(), audit: () => {}, authorize: () => ({ role: 'admin' }) };
  const releases = createUpdateReleases(db, options); await releases.close();
  assert.equal(db.prepare('SELECT * FROM retained_business').get().value, 'unmodified');
  const row = db.prepare('SELECT * FROM updates WHERE id=?').get(id);
  assert.equal(row.platform, 'win32'); assert.equal(row.arch, 'x64'); assert.equal(row.notes, 'old notes'); assert.equal(row.published_at, 123);
  assert.equal(db.prepare('SELECT * FROM update_artifacts').get().oss_key, 'apps/1.0.3/DataFusion-Setup-1.0.3-x64.exe');
  assert.equal(db.prepare('SELECT * FROM update_artifacts').get().published_once, 1);
  for (const arch of ['x64', 'arm64']) {
    const linuxId = 'linux-' + arch;
    db.prepare('INSERT INTO updates(id,target_type,version,url,sha256,published_at,enabled,platform,arch) VALUES(?,?,?,?,?,?,?,?,?)').run(linuxId, 'app', '1.0.3', 'https://test.invalid/test.deb', 'b'.repeat(64), 124, 0, 'linux', arch);
    db.prepare('INSERT INTO update_artifacts(update_id,version,storage_name,file_name,state,created_at,platform,arch) VALUES(?,?,?,?,?,?,?,?)').run(linuxId, '1.0.3', linuxId + '.deb', `数据融合助手-麒麟版-1.0.3-${arch}.deb`, 'ready', 124, 'linux', arch);
  }
  const second = createUpdateReleases(db, options); await second.close();
  assert.equal(db.prepare('SELECT count(*) n FROM update_artifacts').get().n, 3);
  assert.equal(db.prepare('SELECT * FROM retained_business').get().value, 'unmodified');
  assert.throws(() => db.prepare('INSERT INTO updates(id,target_type,version,url,sha256,published_at,enabled,platform,arch) VALUES(?,?,?,?,?,?,?,?,?)').run('duplicate', 'app', '1.0.3', '', '', 0, 0, 'linux', 'x64'));
});
