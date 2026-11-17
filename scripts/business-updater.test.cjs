'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const updater = require('../resources/business-updater.cjs');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const target = { platform: 'win32', arch: 'x64', variant: 'standard', electronMajor: 44 };
const backend = { origin: 'https://backend.example.test', revision: 1 };
const feedBase = 'https://updates.example.test/business/v1/';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function metadata(version = '1.1.0', changes = {}) { return { schema: 1, product: 'data-fusion-desktop', version, minShellVersion: '1.0.0', target, backend, entry: 'out/main/index.js', ...changes }; }
function asarFromRawHeader(json, bytes = Buffer.alloc(0)) {
  const jsonBytes = Buffer.from(json), headerSize = 8 + Math.ceil(jsonBytes.length / 4) * 4;
  const prefix = Buffer.alloc(8), header = Buffer.alloc(headerSize); prefix.writeUInt32LE(4); prefix.writeUInt32LE(headerSize, 4);
  header.writeUInt32LE(headerSize - 4); header.writeUInt32LE(jsonBytes.length, 4); jsonBytes.copy(header, 8);
  return Buffer.concat([prefix, header, bytes]);
}
function makeAsar(version = '1.1.0', changes = {}, additional = {}) {
  const contents = new Map(Object.entries({ 'business.json': JSON.stringify(metadata(version, changes)), 'out/main/index.js': 'module.exports = "business-' + version + '";\n', 'out/renderer/index.html': '<html>business</html>', ...additional }).map(([name, value]) => [name, Buffer.from(value)]));
  const root = { files: {} }; let offset = 0;
  for (const [name, bytes] of contents) {
    const parts = name.split('/'); let directory = root.files;
    for (const part of parts.slice(0, -1)) { directory[part] ||= { files: {} }; directory = directory[part].files; }
    directory[parts.at(-1)] = { size: bytes.length, offset: String(offset) }; offset += bytes.length;
  }
  return asarFromRawHeader(JSON.stringify(root), Buffer.concat([...contents.values()]));
}
function descriptor(bytes, version = '1.1.0', changes = {}) {
  return { schema: 1, product: 'data-fusion-desktop', version, minShellVersion: '1.0.0', target, url: feedBase + version + '/business.asar', bytes: bytes.length, sha256: sha(bytes), backend, ...changes };
}
function envelope(manifest, key = keys.privateKey) {
  const bytes = Buffer.from(JSON.stringify(manifest)); return { algorithm: 'RSA-SHA256', payload: bytes.toString('base64url'), signature: crypto.sign('RSA-SHA256', bytes, key).toString('base64url') };
}
function fakeResponse(status, bytes, headers = {}) {
  return { status, headers: { get: key => headers[key] ?? null }, body: (async function* () { if (bytes !== undefined) yield Buffer.from(bytes); })() };
}
async function fixture(t, version = '1.1.0') {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'fusion-business-updater-'));
  t.after(async () => { assert.equal(path.dirname(directory), os.tmpdir()); assert(path.basename(directory).startsWith('fusion-business-updater-')); await fsp.rm(directory, { recursive: true, force: true }); });
  const bytes = makeAsar(version), manifest = descriptor(bytes, version), signed = envelope(manifest), calls = [];
  const options = { directory, feedBase, publicKey, baseVersion: '1.0.0', shellVersion: '1.0.0', target,
    fetcher: async url => { calls.push(url); return url.endsWith('/latest.json') ? fakeResponse(200, JSON.stringify(signed)) : fakeResponse(200, bytes, { 'content-length': String(bytes.length) }); } };
  const archive = path.join(directory, 'fixture.asar'); await fsp.writeFile(archive, bytes);
  return { directory, archive, bytes, manifest, signed, options, calls };
}

test('version comparison and runtime lanes are explicit and reject incompatible targets', () => {
  assert.equal(updater.compareVersions('1.10.0', '1.2.9'), 1);
  assert.equal(updater.manifestUrl({ feedBase, target }), feedBase + 'win32/x64/standard/electron-44/latest.json');
  assert.equal(updater.manifestUrl({ feedBase, target: { ...target, platform: 'linux', arch: 'arm64', variant: 'kirin990' } }), feedBase + 'linux/arm64/kirin990/electron-44/latest.json');
  for (const value of [{ ...target, variant: 'kirin990' }, { ...target, platform: 'linux', electronMajor: 22 }, { ...target, arch: 'ia32' }]) assert.throws(() => updater.validateTarget(value));
  assert.throws(() => updater.compareVersions('01.0.0', '1.0.0'));
});
test('manifests authenticate raw payload bytes, target, HTTPS origin and metadata before download', () => {
  const bytes = makeAsar(), manifest = descriptor(bytes), options = { feedBase, target, publicKey };
  assert.deepEqual(updater.validateManifest(envelope(manifest), options), manifest);
  const wrong = envelope(manifest); wrong.payload = Buffer.from(JSON.stringify({ ...manifest, version: '9.0.0' })).toString('base64url');
  assert.throws(() => updater.validateManifest(wrong, options), /INVALID_SIGNATURE/);
  for (const value of [{ ...manifest, url: 'https://attacker.invalid/business.asar' }, { ...manifest, url: 'http://updates.example.test/business/v1/a.asar' }, { ...manifest, target: { ...target, electronMajor: 22 } }, { ...manifest, url: feedBase + 'a.asar#fragment' }, { ...manifest, backend: { origin: 'https://backend.example.test/path', revision: 2 } }]) assert.throws(() => updater.validateManifest(envelope(value), options));
});
test('strict JSON rejects duplicate keys and malformed UTF-8, including prototype-shaped input', () => {
  assert.throws(() => updater.strictJson(Buffer.from('{"files":{},"files":{}}')), /DUPLICATE_JSON_KEY/);
  assert.throws(() => updater.strictJson(Buffer.from([0xff])), /INVALID_JSON/);
  assert.throws(() => updater.strictJson(Buffer.from('\u00a0{}')), /INVALID_JSON/);
  const value = updater.strictJson(Buffer.from('{"__proto__":{"test":true}}'));
  assert.equal(Object.getPrototypeOf(value), Object.prototype); assert.equal(value.test, undefined);
});
test('raw ASAR inspection and trusted builtin extraction do not execute business code', async t => {
  const f = await fixture(t), inspected = await updater.inspectAsar(f.archive);
  assert.equal(inspected.sha256, f.manifest.sha256); assert.equal(inspected.metadata.version, '1.1.0');
  assert.equal(inspected.files.find(entry => entry.path === 'out/main/index.js').sha256, sha(Buffer.from('module.exports = "business-1.1.0";\n')));
  const extracted = await updater.ensureBuiltinPayload({ ...f.options, asarFile: f.archive, manifest: f.manifest });
  assert.equal(await fsp.readFile(path.join(extracted.root, 'out/main/index.js'), 'utf8'), 'module.exports = "business-1.1.0";\n');
  assert(!extracted.root.includes('.asar')); assert.equal(extracted.version, '1.1.0');
  assert.equal((await updater.ensureBuiltinPayload({ ...f.options, asarFile: f.archive, manifest: f.manifest })).root, extracted.root);
});
test('ASAR rejects traversal, Windows aliases, symlinks, unpacked files and overlapping payload ranges', async t => {
  const f = await fixture(t);
  const malformed = [
    asarFromRawHeader('{"files":{"..":{"files":{}}}}'),
    asarFromRawHeader('{"files":{"file.":{"size":0,"offset":"0"}}}'),
    asarFromRawHeader('{"files":{"CON.txt":{"size":0,"offset":"0"}}}'),
    asarFromRawHeader('{"files":{"FILE":{"size":0,"offset":"0"},"file":{"size":0,"offset":"0"}}}'),
    asarFromRawHeader('{"files":{"alias":{"link":"out/main/index.js"}}}'),
    asarFromRawHeader('{"files":{"file":{"size":0,"offset":"0","unpacked":true}}}'),
    asarFromRawHeader('{"files":{"a":{"size":1,"offset":"0"},"b":{"size":1,"offset":"0"}}}', Buffer.from('a')),
    asarFromRawHeader('{"files":{"a":{"size":1,"offset":"1"}}}', Buffer.from('aa')),
    asarFromRawHeader('{"files":{},"files":{}}'),
  ];
  for (let i = 0; i < malformed.length; i++) { const archive = path.join(f.directory, 'bad-' + i + '.asar'); await fsp.writeFile(archive, malformed[i]); await assert.rejects(updater.inspectAsar(archive)); }
});
test('ASAR metadata and actual archive bytes must match the pinned builtin descriptor', async t => {
  const f = await fixture(t);
  await assert.rejects(updater.extractVerifiedPayload({ ...f.options, asarFile: f.archive, manifest: { ...f.manifest, sha256: '0'.repeat(64) } }), /CHECKSUM/);
  const wrong = makeAsar('1.1.0', { backend: { ...backend, revision: 99 } }), archive = path.join(f.directory, 'wrong.asar'); await fsp.writeFile(archive, wrong);
  await assert.rejects(updater.extractVerifiedPayload({ ...f.options, asarFile: archive, manifest: { ...f.manifest, bytes: wrong.length, sha256: sha(wrong) } }), /METADATA/);
});
test('the extracted cache is validated byte-for-byte and extra module files are refused', async t => {
  const f = await fixture(t), result = await updater.extractVerifiedPayload({ ...f.options, asarFile: f.archive, manifest: f.manifest });
  const extra = path.join(result.root, 'out/main/unrequested.js'); await fsp.writeFile(extra, 'module.exports="untrusted"');
  await assert.rejects(updater.extractVerifiedPayload({ ...f.options, asarFile: f.archive, manifest: f.manifest }), /CACHE_CHANGED/);
  await fsp.unlink(extra); await fsp.writeFile(path.join(result.root, 'out/main/index.js'), 'tampered');
  await assert.rejects(updater.extractVerifiedPayload({ ...f.options, asarFile: f.archive, manifest: f.manifest }), /CACHE_CHANGED/);
});
test('first startup may use the verified builtin offline when the stable lane is absent or unavailable', async t => {
  const f = await fixture(t);
  for (const status of [401, 403, 404, 429, 503]) {
    const result = await updater.runStartupUpdate({ ...f.options, fetcher: async () => fakeResponse(status) });
    assert.equal(result.status, 'offline'); assert.equal(result.version, '1.0.0'); assert.equal(result.root, undefined);
  }
  const result = await updater.runStartupUpdate({ ...f.options, fetcher: async () => { throw Error('offline'); } }); assert.equal(result.status, 'offline');
});
test('same version enters the app without downloading the business ASAR', async t => {
  const f = await fixture(t, '1.0.0'), result = await updater.runStartupUpdate(f.options);
  assert.equal(result.status, 'current'); assert.equal(f.calls.length, 1); assert.equal(await fsp.stat(path.join(f.directory, 'pending.json')).catch(() => null), null);
});
test('a new signed business version is downloaded, extracted and atomically selected', async t => {
  const f = await fixture(t), events = [], result = await updater.runStartupUpdate({ ...f.options, onProgress: event => events.push(event) });
  assert.equal(result.status, 'updated'); assert.equal(result.version, '1.1.0'); assert.equal(f.calls.length, 2);
  assert.equal(await fsp.readFile(path.join(result.root, 'out/main/index.js'), 'utf8'), 'module.exports = "business-1.1.0";\n');
  const state = JSON.parse(await fsp.readFile(path.join(f.directory, 'state.json'))); assert.deepEqual(state.current, f.signed); assert.equal(state.previous, null);
  assert.equal(await fsp.stat(path.join(f.directory, 'pending.json')).catch(() => null), null);
  assert(events.some(event => event.phase === 'DOWNLOADING' && event.received === f.bytes.length)); assert.equal(events.at(-1).phase, 'READY');
});
test('offline startup loads only the previously authenticated, intact installed business version', async t => {
  const f = await fixture(t), installed = await updater.runStartupUpdate(f.options);
  const offline = await updater.runStartupUpdate({ ...f.options, fetcher: async () => { throw Error('offline'); } });
  assert.equal(offline.status, 'offline'); assert.equal(offline.version, '1.1.0'); assert.equal(offline.root, installed.root);
  await fsp.writeFile(path.join(installed.root, 'out/main/index.js'), 'tampered');
  assert.equal((await updater.runStartupUpdate({ ...f.options, fetcher: async () => { throw Error('offline'); } })).status, 'blocked');
});
test('confirmed pending updates survive download failure, offline restart and an older published manifest', async t => {
  const f = await fixture(t), initial = await updater.runStartupUpdate({ ...f.options, fetcher: async url => url.endsWith('/latest.json') ? fakeResponse(200, JSON.stringify(f.signed)) : Promise.reject(Error('disconnected')) });
  assert.equal(initial.status, 'blocked'); assert.deepEqual(JSON.parse(await fsp.readFile(path.join(f.directory, 'pending.json'))), f.signed);
  const retry = await updater.runStartupUpdate({ ...f.options, fetcher: async () => fakeResponse(404) }); assert.equal(retry.status, 'blocked');
  const olderBytes = makeAsar('1.0.0'), older = envelope(descriptor(olderBytes, '1.0.0'));
  const resumed = await updater.runStartupUpdate({ ...f.options, fetcher: async url => url.endsWith('/latest.json') ? fakeResponse(200, JSON.stringify(older)) : fakeResponse(200, f.bytes) });
  assert.equal(resumed.status, 'updated'); assert.equal(resumed.version, '1.1.0');
});
test('bad signatures, redirected manifests and malformed responses never become offline success', async t => {
  const f = await fixture(t), other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  for (const response of [fakeResponse(200, JSON.stringify(envelope(f.manifest, other.privateKey))), fakeResponse(302), fakeResponse(200, '<html>proxy error</html>'), fakeResponse(400)]) {
    assert.equal((await updater.runStartupUpdate({ ...f.options, fetcher: async () => response })).status, 'blocked');
  }
});
test('partial or changed payload bytes leave pending but no usable half-installed cache', async t => {
  const f = await fixture(t), result = await updater.runStartupUpdate({ ...f.options, fetcher: async url => url.endsWith('/latest.json') ? fakeResponse(200, JSON.stringify(f.signed)) : fakeResponse(200, f.bytes.subarray(0, -1), { 'content-length': String(f.bytes.length) }) });
  assert.equal(result.status, 'blocked'); assert.equal(result.code, 'PARTIAL_DOWNLOAD');
  assert.equal((await fsp.readdir(path.join(f.directory, 'payloads'))).length, 0);
  assert((await fsp.readdir(f.directory)).every(name => !name.startsWith('.download-') && name !== '.update.lock'));
});
test('active updater locks are retained, and known-dead process locks can be recovered', async t => {
  const f = await fixture(t), lock = path.join(f.directory, '.update.lock'), live = JSON.stringify({ pid: process.pid, nonce: 'active' });
  await fsp.writeFile(lock, live); assert.equal((await updater.runStartupUpdate(f.options)).code, 'UPDATE_BUSY'); assert.equal(await fsp.readFile(lock, 'utf8'), live);
  const deadPid = 2147483000; try { process.kill(deadPid, 0); return; } catch (error) { if (error.code !== 'ESRCH') return; }
  await fsp.writeFile(lock, JSON.stringify({ pid: deadPid, nonce: 'dead' })); assert.equal((await updater.runStartupUpdate(f.options)).status, 'updated');
});
test('a newer base shell never selects an older cached business payload', async t => {
  const f = await fixture(t), installed = await updater.runStartupUpdate(f.options);
  await fsp.writeFile(path.join(installed.root, 'out/main/index.js'), 'old unused cache');
  const result = await updater.runStartupUpdate({ ...f.options, baseVersion: '1.2.0', shellVersion: '1.2.0', fetcher: async () => fakeResponse(404) });
  assert.equal(result.status, 'offline'); assert.equal(result.version, '1.2.0'); assert.equal(result.root, undefined);
});
test('shell-incompatible and immutable-version-conflicting updates fail closed', async t => {
  const f = await fixture(t), incompatible = envelope({ ...f.manifest, minShellVersion: '9.0.0' });
  assert.equal((await updater.runStartupUpdate({ ...f.options, fetcher: async () => fakeResponse(200, JSON.stringify(incompatible)) })).code, 'SHELL_UPDATE_REQUIRED');
  const other = await fixture(t), installed = await updater.runStartupUpdate(other.options); assert.equal(installed.status, 'updated');
  const conflict = envelope({ ...other.manifest, sha256: '0'.repeat(64) });
  assert.equal((await updater.runStartupUpdate({ ...other.options, fetcher: async () => fakeResponse(200, JSON.stringify(conflict)) })).code, 'MANIFEST_CONFLICT');
});
test('builtin extraction rejects linked update roots without touching the linked directory', async t => {
  const f = await fixture(t), external = path.join(f.directory, 'outside'), link = path.join(f.directory, 'linked'); await fsp.mkdir(external);
  try { await fsp.symlink(external, link, 'junction'); } catch (error) { t.skip('Symlink permission unavailable'); return; }
  await assert.rejects(updater.ensureBuiltinPayload({ ...f.options, directory: link, asarFile: f.archive, manifest: f.manifest }), /DIRECTORY/);
  assert.deepEqual(await fsp.readdir(external), []);
});
test('real HTTP reads work only in explicit loopback tests and preserve partial-download failures', async t => {
  const f = await fixture(t), server = http.createServer((request, response) => { response.writeHead(404); response.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const local = 'http://127.0.0.1:' + server.address().port + '/business/v1/';
  assert.equal((await updater.runStartupUpdate({ ...f.options, fetcher: undefined, feedBase: local, allowLoopbackHttp: true })).status, 'offline');
  assert.equal((await updater.runStartupUpdate({ ...f.options, fetcher: undefined, feedBase: local })).status, 'blocked');
});
test('signed backend revisions survive a newer base and prevent later business packages from reverting the endpoint', async t => {
  const f = await fixture(t), migratedBackend = { origin: 'https://new-backend.example.test', revision: 2 };
  const bytes = makeAsar('1.1.0', { backend: migratedBackend }), signed = envelope(descriptor(bytes, '1.1.0', { backend: migratedBackend }));
  const result = await updater.runStartupUpdate({ ...f.options, baseBackend: backend,
    fetcher: async url => url.endsWith('/latest.json') ? fakeResponse(200, JSON.stringify(signed)) : fakeResponse(200, bytes) });
  assert.equal(result.status, 'updated'); assert.deepEqual(result.backend, migratedBackend);
  const readOnly = await updater.inspectInstalled({ ...f.options, baseVersion: '1.2.0', shellVersion: '1.2.0', baseBackend: backend });
  assert.equal(readOnly.ignoredByBase, true); assert.equal(readOnly.root, undefined); assert.deepEqual(readOnly.backend, migratedBackend);
  const offline = await updater.runStartupUpdate({ ...f.options, baseVersion: '1.2.0', shellVersion: '1.2.0', baseBackend: backend, fetcher: async () => fakeResponse(404) });
  assert.deepEqual(offline.backend, migratedBackend); assert.equal(offline.version, '1.2.0');
  const regressing = envelope(descriptor(makeAsar('1.3.0'), '1.3.0'));
  assert.equal((await updater.runStartupUpdate({ ...f.options, baseBackend: backend, fetcher: async () => fakeResponse(200, JSON.stringify(regressing)) })).code, 'BACKEND_REVISION_REGRESSION');
  const conflicting = envelope(descriptor(makeAsar('1.3.0'), '1.3.0', { backend: { origin: 'https://different.example.test', revision: 2 } }));
  assert.equal((await updater.runStartupUpdate({ ...f.options, baseBackend: backend, fetcher: async () => fakeResponse(200, JSON.stringify(conflicting)) })).code, 'BACKEND_REVISION_CONFLICT');
});
test('cancellation is bounded even if an injected manifest fetch ignores abort, with no stale lock', async t => {
  const f = await fixture(t), abort = new AbortController();
  const run = updater.runStartupUpdate({ ...f.options, signal: abort.signal, fetcher: () => new Promise(() => {}) });
  setTimeout(() => abort.abort(), 20);
  const result = await Promise.race([run, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('cancellation stalled')), 1000); timer.unref(); })]);
  assert.equal(result.code, 'UPDATE_CANCELLED'); assert.equal(await fsp.stat(path.join(f.directory, '.update.lock')).catch(() => null), null);
  assert.equal(await fsp.stat(path.join(f.directory, 'pending.json')).catch(() => null), null);
});
test('cancellation after confirming a new version removes temporary bytes and retains the mandatory pending envelope', async t => {
  const f = await fixture(t), abort = new AbortController();
  const result = await updater.runStartupUpdate({ ...f.options, signal: abort.signal,
    fetcher: async url => url.endsWith('/latest.json') ? fakeResponse(200, JSON.stringify(f.signed))
      : { status: 200, headers: {}, body: (async function* () { yield f.bytes.subarray(0, 100); await new Promise(() => {}); })() },
    onProgress: event => { if (event.phase === 'DOWNLOADING' && event.received > 0) abort.abort(); } });
  assert.equal(result.code, 'UPDATE_CANCELLED'); assert.deepEqual(JSON.parse(await fsp.readFile(path.join(f.directory, 'pending.json'))), f.signed);
  assert.deepEqual(await fsp.readdir(path.join(f.directory, 'payloads')), []);
  assert((await fsp.readdir(f.directory)).every(name => !name.startsWith('.download-') && name !== '.update.lock'));
});
test('manifest timeouts are offline only while no new version has been confirmed', async t => {
  const f = await fixture(t), result = await updater.runStartupUpdate({ ...f.options, timeoutMs: 20, fetcher: () => new Promise(() => {}) });
  assert.equal(result.status, 'offline'); assert.equal(result.code, 'NETWORK_TIMEOUT');
});
test('the built-in HTTP client performs a complete signed update without relying on global fetch', async t => {
  const f = await fixture(t); let local, signed;
  const server = http.createServer((request, response) => {
    const bytes = request.url.endsWith('/latest.json') ? Buffer.from(JSON.stringify(signed)) : f.bytes;
    response.writeHead(200, { 'content-length': bytes.length }); response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  local = 'http://127.0.0.1:' + server.address().port + '/business/v1/'; signed = envelope({ ...f.manifest, url: local + '1.1.0/business.asar' });
  const result = await updater.runStartupUpdate({ ...f.options, fetcher: undefined, feedBase: local, allowLoopbackHttp: true });
  assert.equal(result.status, 'updated'); assert.equal(result.version, '1.1.0');
});
test('official @electron/asar output is inspected and extracted as original bytes', async t => {
  const f = await fixture(t), stage = path.join(f.directory, 'official-stage'), output = path.join(f.directory, 'official.asar');
  await fsp.mkdir(path.join(stage, 'out/main'), { recursive: true });
  await fsp.writeFile(path.join(stage, 'business.json'), JSON.stringify(metadata()));
  await fsp.writeFile(path.join(stage, 'out/main/index.js'), 'module.exports="official ASAR";\n');
  await fsp.mkdir(path.join(stage, '模板')); await fsp.writeFile(path.join(stage, '模板/行政许可模板.txt'), '企业名称：测试企业\n');
  await require('@electron/asar').createPackage(stage, output);
  const inspection = await updater.inspectAsar(output), pinned = { ...f.manifest, bytes: inspection.bytes, sha256: inspection.sha256 };
  const result = await updater.ensureBuiltinPayload({ ...f.options, asarFile: output, manifest: pinned });
  assert.equal(await fsp.readFile(path.join(result.root, '模板/行政许可模板.txt'), 'utf8'), '企业名称：测试企业\n');
  assert.equal(inspection.files.length, 3);
});
test('the actual official Electron22 Node16 runtime can inspect, extract and select an offline payload', async t => {
  const executable = path.resolve('.tmp/win7-runtime/22.3.27/x64/electron.exe');
  try { await fsp.access(executable); } catch { t.skip('Official Electron22 runtime is not cached on this host'); return; }
  const f = await fixture(t), script = path.join(f.directory, 'node16-probe.cjs'), configuration = path.join(f.directory, 'probe.json');
  await fsp.writeFile(configuration, JSON.stringify({ options: { ...f.options, fetcher: undefined }, asarFile: f.archive, manifest: f.manifest }));
  await fsp.writeFile(script, "const fs=require('node:fs');const updater=require(process.argv[2]);const input=JSON.parse(fs.readFileSync(process.argv[3]));(async()=>{const prepared=await updater.ensureBuiltinPayload({...input.options,asarFile:input.asarFile,manifest:input.manifest});const result=await updater.runStartupUpdate({...input.options,fetcher:async()=>{throw Error('offline')}});console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,root:!!prepared.root,status:result.status}));})().catch(error=>{console.error(error.code||error.message);process.exit(1)});");
  const result = await promisify(execFile)(executable, [script, path.resolve('resources/business-updater.cjs'), configuration], {
    windowsHide: true, timeout: 30000, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const proof = JSON.parse(result.stdout.trim()); assert.equal(proof.electron, '22.3.27'); assert(proof.node.startsWith('16.')); assert.equal(proof.root, true); assert.equal(proof.status, 'offline');
});
test('a confirmed update cannot be bypassed by a private OSS 403 response on restart', async t => {
  const f = await fixture(t);
  assert.equal((await updater.runStartupUpdate({ ...f.options, fetcher: async url => url.endsWith('/latest.json') ? fakeResponse(200, JSON.stringify(f.signed)) : fakeResponse(403) })).status, 'blocked');
  const result = await updater.runStartupUpdate({ ...f.options, fetcher: async () => fakeResponse(403) });
  assert.equal(result.status, 'blocked'); assert.deepEqual(JSON.parse(await fsp.readFile(path.join(f.directory, 'pending.json'))), f.signed);
});
test('cold startup repairs a corrupted extracted cache only after a complete signed network payload is verified', async t => {
  const f = await fixture(t), old = await updater.runStartupUpdate(f.options);
  await fsp.writeFile(path.join(old.root, 'out/main/index.js'), 'broken extracted code');
  const manual = await updater.runStartupUpdate(f.options); assert.equal(manual.status, 'blocked');
  const result = await updater.runStartupUpdate({ ...f.options, repairCache: true });
  assert.equal(result.status, 'updated'); assert.equal(result.repaired, true); assert.equal(result.version, '1.1.0');
  assert.equal(await fsp.readFile(path.join(result.root, 'out/main/index.js'), 'utf8'), 'module.exports = "business-1.1.0";\n');
  assert.equal(await fsp.readFile(path.join(result.quarantined, 'app/out/main/index.js'), 'utf8'), 'broken extracted code');
  assert.equal((await updater.inspectInstalled(f.options)).version, '1.1.0');
});
test('cold startup discovers a higher repair version while preserving the known version floor and quarantining the broken old payload', async t => {
  const f = await fixture(t), old = await updater.runStartupUpdate(f.options);
  const changed = Buffer.from(f.bytes); changed[0] = 0; await fsp.writeFile(old.asarFile, changed);
  const nextBytes = makeAsar('1.2.0'), next = envelope(descriptor(nextBytes, '1.2.0'));
  const result = await updater.runStartupUpdate({ ...f.options, repairCache: true,
    fetcher: async url => url.endsWith('/latest.json') ? fakeResponse(200, JSON.stringify(next)) : fakeResponse(200, nextBytes) });
  assert.equal(result.status, 'updated'); assert.equal(result.version, '1.2.0'); assert.equal(result.repaired, true);
  assert.equal((await fsp.readFile(path.join(result.quarantined, 'business.asar')))[0], 0);
  const state = JSON.parse(await fsp.readFile(path.join(f.directory, 'state.json'))); assert.deepEqual(state.previous, f.signed);
  assert.equal((await updater.inspectInstalled(f.options)).version, '1.2.0');
});
test('a broken cache remains blocked offline, and failed repair bytes never replace or quarantine it', async t => {
  const f = await fixture(t), old = await updater.runStartupUpdate(f.options), main = path.join(old.root, 'out/main/index.js');
  await fsp.writeFile(main, 'broken');
  const offline = await updater.runStartupUpdate({ ...f.options, repairCache: true, fetcher: async () => { throw Error('offline'); } });
  assert.equal(offline.status, 'blocked'); assert.equal(await fsp.readFile(main, 'utf8'), 'broken');
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(f.directory, 'pending.json'))), f.signed);
  const bad = await updater.runStartupUpdate({ ...f.options, repairCache: true,
    fetcher: async url => url.endsWith('/latest.json') ? fakeResponse(200, JSON.stringify(f.signed)) : fakeResponse(200, Buffer.from('invalid archive')) });
  assert.equal(bad.status, 'blocked'); assert.equal(await fsp.readFile(main, 'utf8'), 'broken');
  assert((await fsp.readdir(path.join(f.directory, 'payloads'))).every(name => !name.startsWith('.quarantine-')));
});
test('builtin cache repair owns its own lock and preserves quarantined bytes', async t => {
  const f = await fixture(t), old = await updater.ensureBuiltinPayload({ ...f.options, asarFile: f.archive, manifest: f.manifest });
  await fsp.writeFile(path.join(old.root, 'unexpected.txt'), 'extra cached bytes');
  const result = await updater.ensureBuiltinPayload({ ...f.options, asarFile: f.archive, manifest: f.manifest, repairCache: true });
  assert.equal(result.repaired, true); assert.equal(await fsp.readFile(path.join(result.quarantined, 'app/unexpected.txt'), 'utf8'), 'extra cached bytes');
  assert.equal(await fsp.stat(path.join(f.directory, '.update.lock')).catch(() => null), null);
});
test('a refreshed signed download URL and JSON key order do not conflict with the same pending payload identity', async t => {
  const f = await fixture(t);
  assert.equal((await updater.runStartupUpdate({ ...f.options, fetcher: async url => url.endsWith('/latest.json') ? fakeResponse(200, JSON.stringify(f.signed)) : fakeResponse(403) })).status, 'blocked');
  const refreshed = envelope(Object.fromEntries(Object.entries({ ...f.manifest, url: f.manifest.url + '?download=fresh' }).reverse())), calls = [];
  const result = await updater.runStartupUpdate({ ...f.options, fetcher: async url => { calls.push(url); return url.endsWith('/latest.json') ? fakeResponse(200, JSON.stringify(refreshed)) : fakeResponse(200, f.bytes); } });
  assert.equal(result.status, 'updated'); assert(calls.some(url => url.endsWith('?download=fresh')));
});
test('backend revision zero is rejected consistently for manifests, fixed builtins and endpoint selection', async t => {
  const f = await fixture(t), invalid = { ...f.manifest, backend: { ...backend, revision: 0 } };
  assert.throws(() => updater.validateManifest(envelope(invalid), f.options), /INVALID_BACKEND/);
  assert.throws(() => updater.selectBackend([invalid.backend], f.options), /INVALID_BACKEND/);
  await assert.rejects(updater.ensureBuiltinPayload({ ...f.options, asarFile: f.archive, manifest: invalid }), /INVALID_BACKEND/);
  assert.equal(await fsp.stat(path.join(f.directory, '.update.lock')).catch(() => null), null);
});
test('direct extraction and builtin preparation enforce a provided minimum shell version before activating any payload', async t => {
  const f = await fixture(t), input = { ...f.options, shellVersion: '0.9.0', asarFile: f.archive, manifest: f.manifest };
  await assert.rejects(updater.extractVerifiedPayload(input), /SHELL_UPDATE_REQUIRED/);
  await assert.rejects(updater.ensureBuiltinPayload(input), /SHELL_UPDATE_REQUIRED/);
  assert.deepEqual(await fsp.readdir(path.join(f.directory, 'payloads')), []);
  assert.equal(await fsp.stat(path.join(f.directory, '.update.lock')).catch(() => null), null);
  await assert.rejects(updater.extractVerifiedPayload({ ...input, shellVersion: 'invalid' }), /INVALID_VERSION/);
});
test('a signed newer version requiring a newer shell stays mandatory across offline restart without downloading incompatible code', async t => {
  const f = await fixture(t), bytes = makeAsar('1.1.0', { minShellVersion: '2.0.0' });
  const signed = envelope(descriptor(bytes, '1.1.0', { minShellVersion: '2.0.0' })), requested = [];
  const first = await updater.runStartupUpdate({ ...f.options, fetcher: async url => {
    requested.push(url); assert(url.endsWith('/latest.json'), 'The incompatible payload must not be downloaded');
    return fakeResponse(200, JSON.stringify(signed));
  } });
  assert.equal(first.status, 'blocked'); assert.equal(first.code, 'SHELL_UPDATE_REQUIRED'); assert.equal(requested.length, 1);
  const pending = path.join(f.directory, 'pending.json'); assert.deepEqual(JSON.parse(await fsp.readFile(pending)), signed);
  const offline = await updater.runStartupUpdate({ ...f.options, fetcher: async () => fakeResponse(503) });
  assert.equal(offline.status, 'blocked'); assert.equal(offline.code, 'SHELL_UPDATE_REQUIRED');
  assert.deepEqual(JSON.parse(await fsp.readFile(pending)), signed); assert.deepEqual(await fsp.readdir(path.join(f.directory, 'payloads')), []);
  const upgradedShell = await updater.runStartupUpdate({ ...f.options, shellVersion: '2.0.0', fetcher: async url => url.endsWith('/latest.json') ? fakeResponse(404) : fakeResponse(200, bytes) });
  assert.equal(upgradedShell.status, 'updated'); assert.equal(upgradedShell.version, '1.1.0'); assert.equal(await fsp.stat(pending).catch(() => null), null);
});
