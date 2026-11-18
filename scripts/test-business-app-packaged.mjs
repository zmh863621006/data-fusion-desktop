import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Run the actual packaged renderer, preload, IPC and SQLite in an isolated profile.
// A short-lived offline QA grant is signed locally; no activation or business API is used.
const args = process.argv.slice(2);
const expectOnline = args.includes('--expect-online');
const option = name => args[args.indexOf(name) + 1];
assert(args.includes('--app') && args.includes('--signing-key'), 'Use --app <DataFusion.exe> --signing-key <local private key>');
const executable = resolve(option('--app')), project = resolve(import.meta.dirname, '..');
const privateKey = await readFile(resolve(option('--signing-key')));
const source = await readFile(join(project, 'src/main/runtime.ts'), 'utf8');
assert.deepEqual(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }),
  createPublicKey(source.match(/const PRODUCT_PUBLIC_KEY = `([\s\S]*?)`;/)[1]).export({ type: 'spki', format: 'der' }));
await mkdir(join(project, '.tmp'), { recursive: true });
const root = await mkdtemp(join(project, '.tmp/business-app-packaged-'));
const profile = join(root, 'profile'); await mkdir(profile);
const now = Date.now(), grant = {
  licenseId: 'isolated-startup-qa-' + now, activationMode: 'offline', customerName: '隔离打包验证',
  issuedAt: now, expiresAt: now + 30 * 60_000,
  allowedSystems: ['market-access', 'government-info', 'transport-practitioner', 'oversize-transport', 'online-car-permit', 'guangdong-hrss', 'shenzhen-hazardous-chemicals'],
  allowedTools: ['health-publicity'], allowExport: true, allowAutoSync: false, allowAutoUpdate: false,
};
const payload = Buffer.from(JSON.stringify(grant));
const license = JSON.stringify({ envelope: { algorithm: 'RSA-SHA256', payload: payload.toString('base64url'), signature: sign('RSA-SHA256', payload, privateKey).toString('base64url') }, activatedAt: now });
const sessionSentinel = JSON.stringify({ version: 1, values: { 'isolated-qa-only': 'unused-fixture-value' } });
await writeFile(join(profile, 'license.json'), license, { mode: 0o600 });
await writeFile(join(profile, 'sessions.secure.json'), sessionSentinel, { mode: 0o600 });
await mkdir(join(profile, 'exports')); await writeFile(join(profile, 'exports/sentinel.txt'), 'preserve exports');
const db = new DatabaseSync(join(profile, 'data-fusion.sqlite'));
db.exec("CREATE TABLE qa_startup_sentinel(value TEXT); INSERT INTO qa_startup_sentinel VALUES('preserve database');"); db.close();
const requests = [];
const backend = createServer((request, response) => {
  requests.push(request.url); response.setHeader('content-type', 'application/json');
  if (request.url === '/api/health') response.end('{"status":"ok"}');
  else { response.statusCode = 503; response.end('{"error":"isolated QA service"}'); }
});
await new Promise(done => backend.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + backend.address().port;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const originals = await Promise.all(['DataFusion.exe', 'resources/app.asar'].map(async file => [file, digest(await readFile(join(dirname(executable), file)))]));
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(work, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await work(); if (value) return value; await sleep(100); }
  throw Error('Timed out: ' + label);
}
async function run(round) {
  const portProbe = createServer(); await new Promise(done => portProbe.listen(0, '127.0.0.1', done));
  const port = portProbe.address().port; await new Promise(done => portProbe.close(done));
  const environment = { ...process.env, DATA_FUSION_ACTIVATION_URL: origin + '/api/activate',
    DATA_FUSION_LICENSE_STATUS_URL: origin + '/api/license/status', DATA_FUSION_UPDATE_URL: origin + '/api/updates/manifest',
    DATA_FUSION_ENTERPRISE_URL: origin + '/api/enterprises/resolve', DATA_FUSION_ALLOW_INSECURE_HTTP_ORIGIN: origin };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ['--user-data-dir=' + profile, '--remote-debugging-port=' + port], { env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
  const closed = new Promise(done => child.once('exit', done));
  const timer = setTimeout(() => child.kill(), 150_000); let ws;
  try {
    const page = await until(async () => {
      if (child.exitCode !== null) throw Error('Business app exited before UI became ready');
      try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(item => item.type === 'page' && /\/out\/renderer\/index.html$/.test(item.url)); }
      catch { return null; }
    }, 'actual packaged business page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((done, reject) => { ws.addEventListener('open', done, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let sequence = 0; const pending = new Map();
    ws.addEventListener('message', event => { const value = JSON.parse(event.data), entry = pending.get(value.id); if (entry) { pending.delete(value.id); value.error ? entry.reject(Error(value.error.message)) : entry.resolve(value.result); } });
    const cdp = (method, params = {}) => new Promise((done, reject) => {
      const id = ++sequence, deadline = setTimeout(() => { pending.delete(id); reject(Error('CDP command timed out: ' + method)); }, 20_000);
      pending.set(id, { resolve: value => { clearTimeout(deadline); done(value); }, reject: error => { clearTimeout(deadline); reject(error); } });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert(!result.exceptionDetails, 'Packaged business IPC evaluation failed'); return result.result.value;
    };
    await until(() => evaluate('Boolean(window.desktopApi && document.querySelector(".app-shell"))'), 'renderer and actual preload', 20_000);
    const status = await evaluate('window.desktopApi.license.status()'); assert.equal(status.state, 'active'); assert.equal(status.grant.licenseId, grant.licenseId);
    const updates = await evaluate('window.desktopApi.updates.state()'); assert.equal(updates.kind, 'business'); assert.equal(updates.installMode, 'startup'); assert.equal(updates.currentVersion, '1.1.0');
    if (expectOnline) assert.equal(updates.offline, false, 'Packaged app must have accepted the live OSS manifest');
    const systems = await evaluate('window.desktopApi.systems.list()'); assert.equal(systems.length, 7);
    assert.equal((await evaluate('window.desktopApi.matters.list("government-info")')).length, 18);
    assert.equal((await evaluate('window.desktopApi.components.list()')).length, 8);
    const dashboard = await evaluate('window.desktopApi.hrss.dashboard()');
    assert.equal(dashboard.systemId, 'guangdong-hrss'); assert.equal(dashboard.authorizedMatterCount, 18);
    assert.equal(dashboard.syncState, 'not-synced');
    if (round === 1) {
      assert.equal((await evaluate('window.desktopApi.settings.update({defaultPageSize:37})')).defaultPageSize, 37);
      await evaluate('window.desktopApi.credentials.save("oversize-transport","isolated-qa-account","isolated-qa-password")');
    }
    assert.equal((await evaluate('window.desktopApi.settings.get()')).defaultPageSize, 37);
    const credential = await evaluate('window.desktopApi.credentials.status("oversize-transport")'); assert.equal(credential.configured, true); assert.equal(credential.account, 'isolated-qa-account');
    assert.equal((await evaluate('window.desktopApi.backend.status()')).connected, true);
    await evaluate('[...document.querySelectorAll("button")].find(node=>node.textContent.trim()==="设置")?.click()');
    await until(() => evaluate('Boolean(document.querySelector(".update-settings")?.innerText.includes("基础环境 1.1.0"))'), 'business update settings', 10_000);
    const text = await evaluate('document.querySelector(".update-settings").innerText'); assert(text.includes('基础环境 1.1.0')); assert(!text.includes('手动安装正式版'));
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(join(root, 'settings-' + round + '.png'), Buffer.from(screenshot.data, 'base64'));
    await cdp('Page.close').catch(() => {}); await until(async () => child.exitCode !== null, 'graceful app shutdown', 25_000); assert.equal(await closed, 0);
    return { round, systems: systems.length, components: 8, startupMode: updates.installMode, version: updates.currentVersion, offline: updates.offline };
  } catch (error) { await writeFile(join(root, 'stderr-' + round + '.log'), stderr); throw error; }
  finally { clearTimeout(timer); ws?.close(); if (child.exitCode === null) { child.kill(); await closed; } }
}
try {
  const first = await run(1), encrypted = await readFile(join(profile, 'credentials.secure.json'), 'utf8');
  assert(!encrypted.includes('isolated-qa-password') && !encrypted.includes('isolated-qa-account'));
  const second = await run(2);
  assert.equal(await readFile(join(profile, 'credentials.secure.json'), 'utf8'), encrypted);
  assert.equal(await readFile(join(profile, 'license.json'), 'utf8'), license);
  assert.equal(await readFile(join(profile, 'sessions.secure.json'), 'utf8'), sessionSentinel);
  assert.equal(await readFile(join(profile, 'exports/sentinel.txt'), 'utf8'), 'preserve exports');
  const database = new DatabaseSync(join(profile, 'data-fusion.sqlite')); assert.equal(database.prepare('SELECT value FROM qa_startup_sentinel').get().value, 'preserve database'); database.close();
  for (const [file, hash] of originals) assert.equal(digest(await readFile(join(dirname(executable), file))), hash);
  assert(requests.every(url => url === '/api/health'), 'No authorization, query, enterprise or old installer calls are allowed in this fixture');
  const result = { passed: true, executable, root, first, second, realBusinessCode: true, encryptedCredentialsPreserved: true,
    authorizationPreserved: true, sessionFilePreserved: true, databasePreserved: true, exportsPreserved: true, immutableBasePreserved: true, realBusinessApiCalls: 0 };
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await new Promise(done => backend.close(done)); }
