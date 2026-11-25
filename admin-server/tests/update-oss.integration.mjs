import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createOssUpdateStorage, updateOssSignature } from '../update-oss.mjs';
import { createUpdateReleases } from '../update-releases.mjs';

const config = { endpoint: 'oss-cn-shenzhen.aliyuncs.com', bucket: 'fixture-bucket', prefix: 'data-fusion/updates/windows-x64/',
  accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
const key = config.prefix + '1.0.6/DataFusion-Setup-1.0.6-x64.exe';
async function localFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-update-oss-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('synthetic installer bytes, no real credentials'), path = join(directory, 'fixture.exe');
  await writeFile(path, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex'), md5 = createHash('md5').update(bytes).digest('hex');
  const head = () => new Response(null, { status: 200, headers: { 'content-length': String(bytes.length), 'x-oss-meta-sha256': sha256, etag: `"${md5}"` } });
  return { directory, bytes, sha256, md5, head, entry: { path, bytes: bytes.length, sha256, version: '1.0.6', fileName: 'DataFusion-Setup-1.0.6-x64.exe' } };
}

test('OSS V4 agrees with the official SDK vector and query downloads expire without exposing the secret', () => {
  const query = new URLSearchParams({ param1: 'value1', '+param1': 'value3', '|param1': 'value4', '+param2': '', '|param2': '', param2: '' }).toString();
  assert.equal(updateOssSignature({ secret: 'sk', region: 'cn-hangzhou', timestamp: '20231216T162057Z', method: 'PUT', resource: '/bucket/1234%2B-/123/1.txt', query,
    headers: { 'content-type': 'text/plain', 'x-oss-head1': 'value', 'x-oss-content-sha256': 'UNSIGNED-PAYLOAD', 'x-oss-date': '20231216T162057Z' } }), 'e21d18daa82167720f9b1047ae7e7f1ce7cb77a31e8203a7d5f4624fa0284afe');
  const now = Date.parse('2026-10-29T10:59:59Z'), storage = createOssUpdateStorage(config, { now: () => now });
  const url = new URL(storage.downloadUrl(key));
  assert.equal(url.hostname, 'fixture-bucket.oss-cn-shenzhen.aliyuncs.com');
  assert.equal(url.pathname, '/' + key); assert.equal(url.searchParams.get('x-oss-expires'), '86400');
  assert.equal(url.searchParams.get('x-oss-date'), '20261029T100000Z');
  assert(!url.href.includes(config.accessKeySecret));
  assert.notEqual(storage.downloadUrl(key, 'HEAD'), storage.downloadUrl(key));
  for (const value of [config.prefix + '../bad.exe', 'szjx/establishments/1.0.6/DataFusion-Setup-1.0.6-x64.exe', key.replace('1.0.6/', '/1.0.6/')]) assert.throws(() => storage.downloadUrl(value));
});

test('Chinese OSS object names use the same encoded path for upload and download signatures', async t => {
  const f = await localFile(t);
  const fileName = '数据融合助手-安装包-1.0.6-x64.exe', chineseKey = config.prefix + '1.0.6/' + fileName;
  const encodedPath = '/' + chineseKey.split('/').map(encodeURIComponent).join('/');
  const requests = []; let present = false;
  const storage = createOssUpdateStorage(config, { now: () => Date.parse('2026-11-04T12:00:00Z'), fetcher: async (url, options) => {
    assert.equal(new URL(url).pathname, encodedPath);
    requests.push(options.method);
    if (options.method === 'PUT') {
      for await (const _part of options.body) { }
      present = true; return new Response(null, { status: 200 });
    }
    return present ? f.head() : new Response(null, { status: 404 });
  } });
  assert.equal(await storage.ensureUploaded({ ...f.entry, fileName }), chineseKey);
  assert.deepEqual(requests, ['HEAD', 'PUT', 'HEAD']);
  const url = new URL(storage.downloadUrl(chineseKey));
  assert.equal(url.pathname, encodedPath);
  assert.equal(decodeURIComponent(url.pathname), '/' + chineseKey);
  const query = new URLSearchParams(url.searchParams), signature = query.get('x-oss-signature'); query.delete('x-oss-signature');
  assert.equal(signature, updateOssSignature({ secret: config.accessKeySecret, region: 'cn-shenzhen',
    timestamp: query.get('x-oss-date'), method: 'GET', resource: '/' + config.bucket + encodedPath, query: query.toString() }));
  assert.throws(() => storage.downloadUrl(chineseKey.replace('1.0.6/', '1.0.7/')));
});

test('upload is streamed, private, checksum protected and immutable, and reuses an identical existing object', async t => {
  const f = await localFile(t), requests = []; let exists = false;
  const storage = createOssUpdateStorage(config, { fetcher: async (url, options) => {
    requests.push(options.method); assert.equal(new URL(url).pathname, '/' + key); assert.equal(options.redirect, 'error');
    if (options.method === 'HEAD') return exists ? f.head() : new Response(null, { status: 404 });
    assert.equal(options.method, 'PUT'); assert.equal(options.headers['x-oss-object-acl'], 'private');
    assert.equal(options.headers['x-oss-forbid-overwrite'], 'true'); assert.equal(options.headers['x-oss-meta-sha256'], f.sha256);
    assert.equal(options.headers['content-md5'], Buffer.from(f.md5, 'hex').toString('base64'));
    const parts = []; for await (const part of options.body) parts.push(part);
    assert.deepEqual(Buffer.concat(parts), f.bytes); exists = true; return new Response(null, { status: 200 });
  } });
  assert.equal(await storage.ensureUploaded(f.entry), key);
  assert.equal(await storage.ensureUploaded(f.entry), key);
  assert.deepEqual(requests, ['HEAD', 'PUT', 'HEAD', 'HEAD']);
});

test('a conflicting remote object, denied permissions, or changed local bytes never overwrite an object', async t => {
  const f = await localFile(t);
  for (const response of [new Response(null, { status: 403 }), new Response(null, { status: 200, headers: { 'content-length': String(f.bytes.length), 'x-oss-meta-sha256': '0'.repeat(64), etag: `"${f.md5}"` } })]) {
    let calls = 0;
    const storage = createOssUpdateStorage(config, { fetcher: async (_url, options) => { calls++; assert.equal(options.method, 'HEAD'); return response; } });
    await assert.rejects(storage.ensureUploaded(f.entry)); assert.equal(calls, 1);
  }
  await writeFile(f.entry.path, Buffer.from('changed'));
  await assert.rejects(createOssUpdateStorage(config, { fetcher: () => assert.fail('No request for changed bytes') }).ensureUploaded(f.entry));
});

async function releaseFixture(t, mirror, oldSchema = false) {
  const f = await localFile(t), directory = join(f.directory, 'releases'); await mkdir(directory);
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE updates(id TEXT PRIMARY KEY,target_type TEXT,system_id TEXT,version TEXT,url TEXT,sha256 TEXT,notes TEXT,published_at INTEGER,enabled INTEGER)');
  if (oldSchema) db.exec(`CREATE TABLE update_artifacts(update_id TEXT PRIMARY KEY,version TEXT NOT NULL UNIQUE,storage_name TEXT NOT NULL UNIQUE,file_name TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,sha256 TEXT NOT NULL DEFAULT '',state TEXT NOT NULL,created_at INTEGER NOT NULL,published_once INTEGER NOT NULL DEFAULT 0)`);
  const id = '11111111-1111-4111-8111-111111111111', storage = id + '.exe';
  await writeFile(join(directory, storage), f.bytes);
  const user = { id: 'fixture', role: 'admin' }, transaction = work => { db.exec('BEGIN'); try { work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const options = { directory, publicOrigin: 'https://backend.example.invalid', transaction, audit: () => {}, authorize: () => user, ossStorage: mirror };
  const releases = createUpdateReleases(db, options); t.after(() => releases.close());
  db.prepare('INSERT INTO updates(id,target_type,version,url,sha256,notes,published_at,enabled) VALUES(?,?,?,?,?,?,?,?)').run(id, 'app', '1.0.6', 'https://backend.example.invalid/local.exe', f.sha256, 'fixture', 1, 0);
  db.prepare('INSERT INTO update_artifacts(update_id,version,storage_name,file_name,bytes,sha256,state,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, '1.0.6', storage, f.entry.fileName, f.bytes.length, f.sha256, 'ready', 1);
  return { ...f, db, id, user, releases, options, row: () => db.prepare('SELECT * FROM updates WHERE id=?').get(id), storagePath: join(directory, storage) };
}

test('only successful publication exposes OSS URLs; stable fast links redirect and disabled releases retain both files', async t => {
  const calls = [], mirror = { ensureUploaded: async entry => { calls.push(entry); return key; }, downloadUrl: () => 'https://fixture-bucket.oss-cn-shenzhen.aliyuncs.com/' + key + '?fixture-signature' };
  const f = await releaseFixture(t, mirror, true);
  assert.match(f.releases.describe(f.row()).url, /^https:\/\/backend\.example\.invalid/);
  assert.equal(await f.releases.publish(f.id, true, {}, f.user), true);
  assert.equal(calls.length, 1); assert.equal(calls[0].sha256, f.sha256);
  const manifest = f.releases.manifest(f.row()); assert.equal(manifest.url, mirror.downloadUrl());
  assert.equal(manifest.sha256, f.sha256); assert.equal(manifest.bytes, f.bytes.length); assert.equal(manifest.installer, 'nsis');
  let status, headers, ended = false;
  const url = new URL(`https://backend.example.invalid/api/releases/${f.id}/${f.entry.fileName}?download=oss`);
  assert.equal(await f.releases.serve({ method: 'GET' }, { writeHead: (s, h) => { status = s; headers = h; }, end: () => { ended = true; } }, url), true);
  assert.equal(status, 302); assert.equal(headers.location, manifest.url); assert(ended);
  await f.releases.publish(f.id, false, {}, f.user);
  assert.equal(calls.length, 1); assert.equal(f.row().enabled, 0); assert.deepEqual(await readFile(f.storagePath), f.bytes);
  await assert.rejects(f.releases.serve({ method: 'GET' }, {}, url), { status: 404 });
  const second = createUpdateReleases(f.db, f.options); await second.close();
  assert.equal(f.db.prepare('SELECT oss_key FROM update_artifacts').get().oss_key, key);
});

test('explicit local installers ignore invalid OSS files and injected storage, including legacy external manifest rows', async t => {
  const f = await releaseFixture(t, { ensureUploaded: () => assert.fail('Local mode must not upload to OSS'), downloadUrl: () => assert.fail('Local mode must not sign OSS URLs') });
  await writeFile(join(f.directory, 'update-oss.secure.json'), 'unread invalid OSS configuration');
  const local = createUpdateReleases(f.db, { ...f.options, storageMode: 'local' }); t.after(() => local.close());
  f.db.prepare('UPDATE update_artifacts SET oss_key=? WHERE update_id=?').run(key, f.id);
  assert.equal(await local.publish(f.id, true, {}, f.user), true);
  assert.equal(local.manifest(f.row()).url, `https://backend.example.invalid/api/releases/${f.id}/DataFusion-Setup-1.0.6-x64.exe`);
  assert(!local.manifest(f.row()).url.includes('aliyuncs'));
  assert.equal(local.manifest({ id: 'unmanaged-fixture', version: '1.0.7', url: 'https://fixture-bucket.oss-cn-shenzhen.aliyuncs.com/external.exe', platform: 'win32', arch: 'x64', variant: 'standard' }), null);
  assert.throws(() => createUpdateReleases(f.db, { ...f.options, storageMode: 'unknown' }), { status: 503 });
  // Default mode is intentionally unchanged and still rejects the bad OSS file.
  assert.throws(() => createUpdateReleases(f.db, { ...f.options, ossStorage: undefined }), /OSS 更新配置文件无法读取/);
});

test('failed OSS publication or revoked authorization leaves the existing publication state and URL unchanged', async t => {
  const f = await releaseFixture(t, { ensureUploaded: async () => { throw new Error('fixture denied'); }, downloadUrl: () => assert.fail('No unverified URL') });
  const before = f.row(); await assert.rejects(f.releases.publish(f.id, true, {}, f.user)); assert.deepEqual(f.row(), before);
  assert.equal(f.db.prepare('SELECT oss_key FROM update_artifacts').get().oss_key, null);
  let second;
  second = await releaseFixture(t, { ensureUploaded: async () => { second.user.role = 'viewer'; return key; }, downloadUrl: () => assert.fail('Revoked publication') });
  const prior = second.row();
  await assert.rejects(second.releases.publish(second.id, true, {}, second.user), { status: 403 });
  assert.deepEqual(second.row(), prior);
  assert.equal(second.db.prepare('SELECT oss_key FROM update_artifacts').get().oss_key, null);
});

test('draft upload mirrors only validated bytes, keeps its URL private, and rolls back failed or revoked uploads', async t => {
  for (const outcome of ['success', 'denied', 'revoked']) {
    let f, observed = 0;
    const newKey = config.prefix + '1.0.7/DataFusion-Setup-1.0.7-x64.exe';
    const mirror = { downloadUrl: () => assert.fail('A draft must not expose an OSS download token'), ensureUploaded: async entry => {
      observed++; assert.equal(entry.version, '1.0.7'); assert.equal(entry.bytes, 4096);
      assert.equal(createHash('sha256').update(await readFile(entry.path)).digest('hex'), entry.sha256);
      if (outcome === 'denied') throw new Error('fixture denied');
      if (outcome === 'revoked') f.user.role = 'viewer';
      return newKey;
    } };
    f = await releaseFixture(t, mirror);
    const bytes = Buffer.alloc(4096, 0x31); bytes.write('MZ'); bytes.writeUInt32LE(128, 0x3c);
    bytes.set([80, 69, 0, 0], 128); bytes.writeUInt16LE(0x14c, 132); bytes.writeUInt16LE(0x10b, 152);
    bytes.set(Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex'), 1024);
    const request = Readable.from([bytes]); request.headers = { 'content-length': String(bytes.length) };
    const timeouts = []; request.setTimeout = value => { timeouts.push(value); };
    const pending = f.releases.upload(request, {}, new URL('https://backend.example.invalid/api/admin/updates/upload?version=1.0.7&filename=DataFusion-Setup-1.0.7-x64.exe'), f.user);
    if (outcome === 'success') {
      const draft = await pending;
      assert.equal(draft.status, 'draft'); assert.match(draft.url, /^https:\/\/backend\.example\.invalid/);
      assert.equal(f.db.prepare('SELECT oss_key FROM update_artifacts WHERE version=?').get('1.0.7').oss_key, newKey);
    } else {
      await assert.rejects(pending);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM updates').get().n, 1);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM update_artifacts').get().n, 1);
      assert.deepEqual(await readFile(f.storagePath), f.bytes);
    }
    assert.equal(observed, 1); assert.deepEqual(timeouts, [60_000, 600_000]);
  }
});

test('new platform namespaces isolate equal versions and allow signed Linux downloads while legacy Windows keys remain valid', async t => {
  const f = await localFile(t), observed = [];
  for (const target of [{ platform: 'win32', arch: 'x64', fileName: '数据融合助手-安装包-1.0.6-x64.exe' },
    { platform: 'linux', arch: 'x64', fileName: '数据融合助手-麒麟版-1.0.6-x64.deb' },
    { platform: 'linux', arch: 'arm64', fileName: '数据融合助手-麒麟版-1.0.6-arm64.deb' }]) {
    const expected = `${config.prefix}${target.platform}/${target.arch}/1.0.6/${target.fileName}`;
    let exists = false;
    const storage = createOssUpdateStorage(config, { fetcher: async (url, options) => {
      assert.equal(decodeURIComponent(new URL(url).pathname), '/' + expected);
      if (options.method === 'HEAD') return exists ? f.head() : new Response(null, { status: 404 });
      assert.equal(options.method, 'PUT');
      for await (const chunk of options.body) assert(chunk.length > 0);
      exists = true; return new Response(null, { status: 200 });
    } });
    const actual = await storage.ensureUploaded({ ...f.entry, ...target });
    assert.equal(actual, expected); observed.push(actual);
    assert.equal(decodeURIComponent(new URL(storage.downloadUrl(actual)).pathname), '/' + expected);
    assert.doesNotThrow(() => storage.downloadUrl(key));
    assert.throws(() => storage.downloadUrl(`${config.prefix}win32/arm64/1.0.6/数据融合助手-安装包-1.0.6-x64.exe`));
    assert.throws(() => storage.downloadUrl(`${config.prefix}linux/arm64/1.0.6/数据融合助手-麒麟版-1.0.6-x64.deb`));
  }
  assert.equal(new Set(observed).size, 3);
});

test('Kirin990 OSS objects use a separate immutable namespace and never alias standard ARM64 or legacy keys', async t => {
  const f = await localFile(t), target = { platform: 'linux', arch: 'arm64', variant: 'kirin990', fileName: '数据融合助手-麒麟海思990版-1.0.6-arm64.deb' };
  const expected = `${config.prefix}linux/arm64/kirin990/1.0.6/${target.fileName}`;
  let exists = false;
  const storage = createOssUpdateStorage(config, { fetcher: async (url, options) => {
    assert.equal(decodeURIComponent(new URL(url).pathname), '/' + expected);
    if (options.method === 'HEAD') return exists ? f.head() : new Response(null, { status: 404 });
    assert.equal(options.method, 'PUT'); assert.equal(options.headers['x-oss-forbid-overwrite'], 'true');
    for await (const chunk of options.body) assert(chunk.length > 0);
    exists = true; return new Response(null, { status: 200 });
  } });
  const key = await storage.ensureUploaded({ ...f.entry, ...target }); assert.equal(key, expected);
  assert.equal(decodeURIComponent(new URL(storage.downloadUrl(key)).pathname), '/' + expected);
  for (const invalid of [
    `${config.prefix}linux/arm64/1.0.6/${target.fileName}`,
    `${config.prefix}linux/x64/kirin990/1.0.6/${target.fileName}`,
    `${config.prefix}linux/arm64/other/1.0.6/${target.fileName}`,
    `${config.prefix}linux/arm64/kirin990/1.0.6/数据融合助手-麒麟版-1.0.6-arm64.deb`,
  ]) assert.throws(() => storage.downloadUrl(invalid));
  await assert.rejects(storage.ensureUploaded({ ...f.entry, ...target, variant: 'standard' }), /路径无效/);
});

test('a fully read DEB body switches socket timeout before validation, including rejected archives', async t => {
  const f = await releaseFixture(t, null), bytes = Buffer.alloc(4096), events = [];
  const request = Readable.from([bytes]); request.headers = { 'content-length': String(bytes.length) };
  request.on('end', () => events.push('body-end'));
  request.setTimeout = value => { events.push(value); };
  const url = new URL('https://backend.example.invalid/api/admin/updates/upload?' + new URLSearchParams({
    version: '1.0.7', platform: 'linux', arch: 'arm64', filename: '数据融合助手-麒麟版-1.0.7-arm64.deb',
  }));
  await assert.rejects(f.releases.upload(request, {}, url, f.user), { status: 400 });
  assert.deepEqual(events, [60_000, 'body-end', 600_000]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM updates').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM update_artifacts').get().n, 1);
  assert.deepEqual(await readFile(f.storagePath), f.bytes);
});

test('an incomplete upload keeps the 60s idle timeout and never enters the post-body timeout phase', async t => {
  const f = await releaseFixture(t, null), timeouts = [];
  let started, reads = 0;
  const reading = new Promise(resolve => { started = resolve; });
  const request = new Readable({ read() { if (!reads++) { this.push(Buffer.alloc(512)); started(); } } });
  request.headers = { 'content-length': '4096' }; request.setTimeout = value => { timeouts.push(value); };
  const url = new URL('https://backend.example.invalid/api/admin/updates/upload?version=1.0.7&filename=DataFusion-Setup-1.0.7-x64.exe');
  const pending = f.releases.upload(request, {}, url, f.user);
  const rejected = assert.rejects(pending, /fixture cancelled/);
  await reading; assert.deepEqual(timeouts, [60_000]);
  request.destroy(new Error('fixture cancelled')); await rejected;
  assert.deepEqual(timeouts, [60_000]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM updates').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM update_artifacts').get().n, 1);
  assert.deepEqual(await readFile(f.storagePath), f.bytes);
});
