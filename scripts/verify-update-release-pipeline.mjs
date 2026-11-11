// Local, disposable, zero-production-mutation upload -> publish -> signed manifest -> download probe.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createAdminServer } from '../admin-server/app.mjs';
import { installerVersion } from '../admin-server/update-filenames.mjs';

const installerPath = resolve(process.argv[2] ?? ''), fileName = basename(installerPath);
const version = installerVersion(fileName);
assert(version, 'Pass the actual versioned installer path');
const target = fileName.endsWith('.deb') ? { platform: 'linux', arch: /-(x64|arm64)\.deb$/.exec(fileName)[1], installer: 'deb' }
  : { platform: 'win32', arch: 'x64', installer: 'nsis' };
const bytes = (await stat(installerPath)).size, hash = createHash('sha256');
for await (const chunk of createReadStream(installerPath)) hash.update(chunk);
const sha256 = hash.digest('hex');
const directory = await mkdtemp(join(tmpdir(), 'fusion-update-pipeline-'));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const password = 'Disposable-Release-Only!2026';
const server = createAdminServer({ dataPath: join(directory, 'admin.sqlite'), releaseDirectory: join(directory, 'releases'),
  privateKey, initialPassword: password, updatePublicOrigin: 'https://updates.example.invalid',
  captchaFactory: () => ({ answer: 'ABCDE', image: 'data:image/png;base64,iVBORw0KGgo=' }) });
let base, token = '';
async function api(path, body) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: token }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert(response.ok, `Unexpected HTTP ${response.status} from ${path}`); return response.json();
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  const challenge = await fetch(base + '/api/admin/captcha'), captcha = await challenge.json();
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', cookie: challenge.headers.get('set-cookie').split(';')[0] },
    body: JSON.stringify({ username: 'admin', password, captchaId: captcha.id, captcha: 'ABCDE' }) });
  assert.equal(login.status, 200); await login.json(); token = login.headers.get('set-cookie').split(';')[0];
  const upload = await fetch(base + '/api/admin/updates/upload?' + new URLSearchParams({ version, filename: fileName, platform: target.platform, arch: target.arch }), {
    method: 'POST', headers: { cookie: token, 'content-type': 'application/octet-stream', 'content-length': String(bytes), 'x-content-sha256': sha256 },
    body: createReadStream(installerPath), duplex: 'half', signal: AbortSignal.timeout(120_000),
  });
  assert.equal(upload.status, 201); const result = await upload.json();
  assert.equal(result.bytes, bytes); assert.equal(result.sha256, sha256); assert.equal(result.status, 'draft');
  assert.equal((await fetch(base + new URL(result.url).pathname)).status, 404);
  const publish = await fetch(base + `/api/admin/updates/${result.id}`, { method: 'PATCH', headers: { cookie: token, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, confirmPassword: password }) });
  assert.equal(publish.status, 200); await publish.json();
  const customer = await api('/api/admin/customers', { name: 'Disposable release check' });
  const license = await api('/api/admin/licenses', { customerId: customer.id, mode: 'online', allowedSystems: [], allowedTools: ['health-publicity'], maxDevices: 1,
    allowAutoUpdate: true, expiresAt: Date.now() + 3600_000 });
  const deviceId = 'd'.repeat(64), proof = await api('/api/activate', { key: license.activationCode, deviceId });
  const envelope = await api('/api/updates/manifest', { licenseId: license.id, deviceId, proof, platform: target.platform, arch: target.arch });
  assert.equal(verify('RSA-SHA256', Buffer.from(envelope.payload, 'base64url'), publicKey, Buffer.from(envelope.signature, 'base64url')), true);
  const manifest = JSON.parse(Buffer.from(envelope.payload, 'base64url'));
  assert.equal(manifest.app.version, version); assert.equal(manifest.app.sha256, sha256); assert.equal(manifest.app.bytes, bytes);
  assert.equal(manifest.app.installer, target.installer); assert.equal(manifest.app.arch, target.arch); assert.equal(manifest.app.platform, target.platform);
  const other = await api('/api/updates/manifest', { licenseId: license.id, deviceId, proof, platform: target.platform === 'linux' ? 'win32' : 'linux', arch: 'x64' });
  assert.equal(JSON.parse(Buffer.from(other.payload, 'base64url')).app, undefined);
  assert.equal(new URL(manifest.app.url).origin, 'https://updates.example.invalid');
  const response = await fetch(base + new URL(manifest.app.url).pathname), downloaded = createHash('sha256'); let received = 0;
  assert.equal(response.status, 200);
  for await (const chunk of response.body) { downloaded.update(chunk); received += chunk.length; }
  assert.equal(received, bytes); assert.equal(downloaded.digest('hex'), sha256);
  const range = await fetch(base + new URL(manifest.app.url).pathname, { headers: { range: 'bytes=0-1023' } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 1024);
  console.log(JSON.stringify({ status: 'pass', version, ...target, bytes, sha256, actualPackageStructure: true, streamingUploadAndDownload: true,
    privateDraft: true, explicitPasswordPublication: true, signedManifest: true, rangeDownload: true,
    productionMutations: 0, paidProviderCalls: 0, disposableProfile: true }, null, 2));
} finally {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert(basename(directory).startsWith('fusion-update-pipeline-'));
  await rm(directory, { recursive: true, force: true });
}
