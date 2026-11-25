import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPackage } from '@electron/asar';
import { createBusinessReleases } from '../business-releases.mjs';
import { createBusinessLocalStorage } from '../business-local-storage.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const target = { platform: 'win32', arch: 'x64', variant: 'standard', electronMajor: 44 };
const origin = 'https://intranet.example.invalid';
const feedBase = origin + '/business-updates/';
const lane = 'win32/x64/standard/electron-44';
const metadata = (version, overrides = {}) => ({ schema: 1, product: 'data-fusion-desktop', version, minShellVersion: '1.1.0', target,
  backend: { origin, revision: 2 }, entry: 'out/main/index.js', ...overrides });
const envelopeFor = (version, extra = {}) => {
  const bytes = Buffer.from(JSON.stringify({ schema: 1, product: 'data-fusion-desktop', version, minShellVersion: '1.1.0', target,
    backend: { origin, revision: 2 }, url: `${feedBase}${lane}/${version}/business-${version}.asar`, bytes: 123, sha256: 'a'.repeat(64), ...extra }));
  return { algorithm: 'RSA-SHA256', payload: bytes.toString('base64url'), signature: sign('RSA-SHA256', bytes, privateKey).toString('base64url') };
};
function transact(db, fn) {
  db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-business-local-')), root = join(directory, 'business-releases'), dataPath = join(directory, 'admin.sqlite');
  await mkdir(root);
  // Invalid unrelated OSS files prove that local mode never reads either file.
  await writeFile(join(directory, 'business-oss.secure.json'), 'invalid OSS configuration must remain unread');
  await writeFile(join(directory, 'update-oss.secure.json'), 'invalid OSS configuration must remain unread');
  let db = new DatabaseSync(dataPath), releases, failPublishAudit = false;
  function start() {
    releases = createBusinessReleases(db, { directory: root, publicOrigin: origin, privateKey,
      storageMode: 'local', localFeedBase: feedBase, transaction: fn => transact(db, fn),
      audit: (_user, action) => { if (failPublishAudit && action === 'business_update.published') throw Error('fixture simulated commit failure'); }, ...options });
  }
  start();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (await releases.serve(request, response, url)) return;
      let result;
      if (url.pathname === '/upload') result = await releases.upload(request, response, url, { id: 'fixture-admin', role: 'admin' });
      else if (url.pathname === '/publish') result = await releases.publish(url.searchParams.get('id'), url.searchParams.get('enabled') !== 'false', request, { id: 'fixture-admin', role: 'admin' });
      else if (url.pathname === '/list') result = releases.list();
      else throw Object.assign(Error('not found'), { status: 404 });
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error) { if (response.headersSent) response.destroy(error); else { response.writeHead(error.status ?? 500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function pack(version = '1.1.0', overrides = {}) {
    const stage = await mkdtemp(join(directory, 'stage-')); await mkdir(join(stage, 'out/main'), { recursive: true });
    await writeFile(join(stage, 'business.json'), JSON.stringify(metadata(version, overrides)));
    await writeFile(join(stage, 'out/main/index.js'), 'module.exports = "synthetic fixture";');
    const path = stage + '.asar'; await createPackage(stage, path); return readFile(path);
  }
  const get = (path, options) => fetch(base + (path.startsWith('https:') ? new URL(path).pathname : path), options);
  async function upload(version = '1.1.0', overrides = {}, query = {}) {
    const bytes = await pack(version, overrides), search = new URLSearchParams({ version, filename: `business-${version}.asar`, ...(overrides.target ?? target), ...query });
    const response = await get('/upload?' + search, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
    return { status: response.status, body: await response.json(), bytes };
  }
  async function publish(id, enabled = true) { const response = await get(`/publish?id=${id}&enabled=${enabled}`, { method: 'POST' }); return { status: response.status, body: await response.json() }; }
  t.after(async () => { await releases.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { root, directory, dataPath, get, upload, publish, pack, get db() { return db; }, get releases() { return releases; },
    failPublishAudit: value => { failPublishAudit = value; }, restart: async () => { await releases.close(); db.close(); db = new DatabaseSync(dataPath); start(); } };
}

test('required intranet backend origin rejects a wrong-region payload before it becomes a draft', async t => {
  const f = await fixture(t, { requiredBackendOrigin: origin });
  const wrong = await f.upload('1.2.0', { backend: { origin: 'https://other.example.invalid', revision: 3 } });
  assert.equal(wrong.status, 409); assert.equal(f.releases.list().rows.length, 0);
  const valid = await f.upload('1.2.0'); assert.equal(valid.status, 200);
  assert.equal((await f.publish(valid.body.id)).status, 200);
});

test('local mode ignores OSS files and atomically publishes signed HTTPS discovery and actual verified bytes', async t => {
  const f = await fixture(t, { localFeedBase: undefined, ossStorage: new Proxy({}, { get: () => assert.fail('Local mode must not use injected OSS storage') }) });
  const uploaded = await f.upload(); assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  assert.equal(f.releases.list().storageMode, 'local'); assert.equal(f.releases.list().feedBase, feedBase);
  const url = `${feedBase}${lane}/1.1.0/business-1.1.0.asar`, feed = `${feedBase}${lane}/latest.json`;
  assert.equal((await f.get(url)).status, 404); assert.equal((await f.get(feed)).status, 404);
  assert.equal((await f.publish(uploaded.body.id)).status, 200);
  const manifest = await f.get(feed), envelope = await manifest.json(), payload = JSON.parse(Buffer.from(envelope.payload, 'base64url'));
  assert(verify('RSA-SHA256', Buffer.from(envelope.payload, 'base64url'), publicKey, Buffer.from(envelope.signature, 'base64url')));
  assert.equal(payload.url, url); assert.deepEqual(payload.target, target); assert.equal(payload.backend.origin, origin);
  const download = await f.get(payload.url); assert.equal(download.status, 200); const bytes = Buffer.from(await download.arrayBuffer());
  assert.deepEqual(bytes, uploaded.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), payload.sha256);
  const head = await f.get(url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const feedHead = await f.get(feed, { method: 'HEAD' }); assert.equal(feedHead.status, 200); assert.equal((await feedHead.arrayBuffer()).byteLength, 0);
  assert.equal((await f.get(feed, { headers: { 'if-none-match': manifest.headers.get('etag') } })).status, 304);
  assert.equal((await f.get(url, { headers: { 'if-none-match': download.headers.get('etag') } })).status, 304);
  const range = await f.get(url, { headers: { range: 'bytes=5-19' } }); assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(5, 20));
  assert.equal((await f.get(url, { headers: { range: 'bytes=999999999-' } })).status, 416);
  assert.equal((await f.get(`/api/business-releases/${uploaded.body.id}/business-1.1.0.asar`)).status, 200);
  await f.restart(); assert.equal((await f.get(feed)).status, 200); assert.equal((await f.get(url)).status, 200);
});

test('failed publication rolls back feed, release and floor together and retries after restart', async t => {
  const f = await fixture(t), first = await f.upload(); assert.equal((await f.publish(first.body.id)).status, 200);
  const before = await (await f.get(`${feedBase}${lane}/latest.json`)).text(), candidate = await f.upload('1.1.1');
  f.failPublishAudit(true); assert.equal((await f.publish(candidate.body.id)).status, 500);
  assert.equal(await (await f.get(`${feedBase}${lane}/latest.json`)).text(), before);
  assert.equal((await f.get(`${feedBase}${lane}/1.1.1/business-1.1.1.asar`)).status, 404);
  assert.equal(f.db.prepare('SELECT max_version FROM business_release_channels WHERE lane=?').get(lane).max_version, '1.1.0');
  assert.equal(f.releases.list().rows.find(row => row.id === candidate.body.id).status, 'draft');
  f.failPublishAudit(false); await f.restart(); assert.equal((await f.publish(candidate.body.id)).status, 200);
  assert.equal((await f.publish(candidate.body.id)).status, 200); // idempotent reconciliation
  assert.equal((await f.publish(first.body.id)).status, 409);
});

test('a publishing process exiting before commit cannot expose its new head and a later retry completes normally', async t => {
  const f = await fixture(t), first = await f.upload(); assert.equal((await f.publish(first.body.id)).status, 200);
  const oldFeed = await (await f.get(`${feedBase}${lane}/latest.json`)).text(), candidate = await f.upload('1.1.1');
  const script = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE business_local_feeds SET envelope_json=? WHERE lane=?').run('uncommitted broken head',process.argv[2]);
    db.prepare('UPDATE business_releases SET enabled=1,published_once=1 WHERE id=?').run(process.argv[3]);
    process.exit(17);`;
  await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script, f.dataPath, lane, candidate.body.id], { windowsHide: true }, error => {
    if (error?.code === 17) resolve(); else reject(error ?? Error('Fixture process unexpectedly committed'));
  }));
  await f.restart(); assert.equal(await (await f.get(`${feedBase}${lane}/latest.json`)).text(), oldFeed);
  assert.equal((await f.get(`${feedBase}${lane}/1.1.1/business-1.1.1.asar`)).status, 404);
  assert.equal((await f.publish(candidate.body.id)).status, 200);
});

test('local publication preserves target isolation, backend revision floors, current-head protection and disable visibility', async t => {
  const f = await fixture(t), first = await f.upload(); assert.equal((await f.publish(first.body.id)).status, 200);
  assert.equal((await f.publish(first.body.id, false)).status, 409);
  const otherTarget = { platform: 'linux', arch: 'arm64', variant: 'kirin990', electronMajor: 44 };
  const other = await f.upload('1.1.0', { target: otherTarget }); assert.equal((await f.publish(other.body.id)).status, 200);
  assert.equal((await f.get(`${feedBase}linux/arm64/kirin990/electron-44/latest.json`)).status, 200);
  assert.equal((await f.get(`${feedBase}linux/arm64/standard/electron-44/latest.json`)).status, 404);
  const stale = await f.upload('1.1.1', { backend: { origin, revision: 1 } }); assert.equal((await f.publish(stale.body.id)).status, 409);
  const conflict = await f.upload('1.1.2', { backend: { origin: 'https://other.example.invalid', revision: 2 } }); assert.equal((await f.publish(conflict.body.id)).status, 409);
  const next = await f.upload('1.1.3', { backend: { origin: 'https://other.example.invalid', revision: 3 } }); assert.equal((await f.publish(next.body.id)).status, 200);
  assert.equal((await f.publish(first.body.id, false)).status, 200);
  assert.equal((await f.get(`${feedBase}${lane}/1.1.0/business-1.1.0.asar`)).status, 404);
  assert.equal((await f.publish(first.body.id)).status, 409);
});

test('local feed CAS is transactional, rejects stale writers and validates signed target and payload origin', async t => {
  const f = await fixture(t), storage = createBusinessLocalStorage({ database: f.db, directory: f.root, publicOrigin: origin, feedBase, publicKey });
  assert.throws(() => storage.commitLatest(target, envelopeFor('1.1.0'), null), { status: 500 });
  transact(f.db, () => storage.commitLatest(target, envelopeFor('1.1.0'), null)); const first = storage.readLatest(target);
  assert.throws(() => transact(f.db, () => storage.commitLatest(target, envelopeFor('1.1.1'), null)), { status: 409 });
  assert.deepEqual(storage.readLatest(target), first);
  for (const bad of [envelopeFor('1.1.1', { target: { ...target, electronMajor: 22 } }), envelopeFor('1.1.1', { url: 'https://elsewhere.example.invalid/payload.asar' }),
    { ...envelopeFor('1.1.1'), signature: 'invalid' }]) assert.throws(() => transact(f.db, () => storage.commitLatest(target, bad, first.etag)), { status: 409 });
  transact(f.db, () => storage.commitLatest(target, envelopeFor('1.1.1'), first.etag)); assert.notEqual(storage.readLatest(target).etag, first.etag);
  for (const config of [{ feedBase: 'http://intranet.example.invalid/updates/' }, { feedBase: 'https://other.example.invalid/updates/' },
    { feedBase: origin + '/' }, { feedBase: origin + '/api/updates/' }, { feedBase: origin + '/updates/?query=1' }, { feedBase: origin + '/updates/%2f/' }, { publicOrigin: 'http://intranet.example.invalid' }]) {
    assert.throws(() => createBusinessLocalStorage({ database: f.db, directory: f.root, publicOrigin: origin, feedBase, publicKey, ...config }), { status: 503 });
  }
});

test('payload tampering and symlink files/roots cannot be published or downloaded; encoded paths never escape', async t => {
  const f = await fixture(t), draft = await f.upload(), path = join(f.root, draft.body.id + '.asar');
  await chmod(path, 0o600); await writeFile(path, Buffer.alloc(draft.bytes.length)); assert.equal((await f.publish(draft.body.id)).status, 409);
  const good = await f.upload('1.1.1'); assert.equal((await f.publish(good.body.id)).status, 200);
  const goodPath = join(f.root, good.body.id + '.asar'), hidden = join(f.directory, 'hidden.asar'); await rename(goodPath, hidden); await symlink(hidden, goodPath, 'file');
  assert.equal((await f.get(`${feedBase}${lane}/1.1.1/business-1.1.1.asar`)).status, 409); await rm(goodPath); await rename(hidden, goodPath);
  await chmod(goodPath, 0o600); await writeFile(goodPath, Buffer.alloc(good.bytes.length));
  assert.equal((await f.get(`${feedBase}${lane}/1.1.1/business-1.1.1.asar`)).status, 409);
  for (const path of ['/business-updates/%2e%2e/admin.sqlite', '/business-updates/win32/x64/standard/electron-44/1.1.1/%2e%2e%2fadmin.sqlite', '/business-updates/win32/x64/standard/electron-44/1.1.1/business-1.1.2.asar'])
    assert.equal((await f.get(path)).status, 404);
  const movedRoot = f.root + '-moved'; await rename(f.root, movedRoot); await symlink(movedRoot, f.root, 'junction');
  assert.equal((await f.upload('1.1.2')).status, 503); await rm(f.root); await rename(movedRoot, f.root);
});

test('same-process and separate-instance publishers share channel leases, and transient lease conflicts leave drafts private', async t => {
  const f = await fixture(t), one = await f.upload(), two = await f.upload('1.1.1');
  const result = await Promise.all([f.publish(one.body.id), f.publish(two.body.id)]); assert.deepEqual(result.map(value => value.status).sort(), [200, 409]);
  const failed = result[0].status === 409 ? one : two;
  const db = new DatabaseSync(f.dataPath);
  try {
    db.prepare('UPDATE business_release_channels SET lease_token=?,lease_until=? WHERE lane=?').run('external-fixture-process', Date.now() + 60_000, lane);
    assert.equal((await f.publish(failed.body.id)).status, 409);
    db.prepare('UPDATE business_release_channels SET lease_token=NULL,lease_until=0 WHERE lane=?').run(lane);
    if (failed === two) assert.equal((await f.publish(two.body.id)).status, 200);
  } finally { db.close(); }
});
