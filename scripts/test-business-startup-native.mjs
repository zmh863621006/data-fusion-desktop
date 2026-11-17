import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPackage } from '@electron/asar';
import fuses from '@electron/fuses';
import { build, Platform, Arch } from 'electron-builder';
const { getCurrentFuseWire, FuseV1Options } = fuses;
const FuseState = { ENABLE: 49 };

const legacy = process.argv.includes('--legacy');
const project = resolve('.'), root = await mkdtemp(join(project, '.tmp/business-startup-native-'));
const version = '1.1.0', electronVersion = legacy ? '22.3.27' : JSON.parse(await readFile('node_modules/electron/package.json', 'utf8')).version;
const target = { platform: 'win32', arch: 'x64', variant: 'standard', electronMajor: Number(electronVersion.split('.')[0]) };
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const backend = { origin: 'https://fixture-backend.example.test', revision: 1 };
const feedPath = '/business/v1/win32/x64/standard/electron-' + target.electronMajor + '/latest.json';
let mode = 'new', downloads = 0, app;
const payloads = new Map();
const server = createServer((request, response) => {
  if (mode === 'offline') { response.writeHead(503); response.end(); return; }
  if (request.url === feedPath) {
    const entry = payloads.get(mode === 'pending' ? '1.1.2' : '1.1.1');
    const payload = Buffer.from(JSON.stringify(entry.manifest));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ algorithm: 'RSA-SHA256', payload: payload.toString('base64url'), signature: sign('RSA-SHA256', payload, keys.privateKey).toString('base64url') })); return;
  }
  const entry = [...payloads.values()].find(item => new URL(item.manifest.url).pathname === request.url);
  if (!entry) { response.writeHead(404); response.end(); return; }
  downloads++;
  const bytes = mode === 'pending' ? Buffer.alloc(entry.bytes.length) : entry.bytes;
  response.writeHead(200, { 'content-length': bytes.length }); response.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

async function makePayload(nextVersion) {
  const stage = join(root, 'business-' + nextVersion); await mkdir(join(stage, 'out/main'), { recursive: true });
  const metadata = { schema: 1, product: 'data-fusion-desktop', version: nextVersion, minShellVersion: version, target, backend, entry: 'out/main/index.js' };
  await writeFile(join(stage, 'business.json'), JSON.stringify(metadata));
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'data-fusion-desktop', version: nextVersion, main: 'out/main/index.js' }));
  await writeFile(join(stage, 'out/main/index.js'), `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
const context=globalThis.__DATA_FUSION_BUSINESS_BOOTSTRAP__;
if(!app.isPackaged||context.version!==${JSON.stringify(nextVersion)})throw Error('WRONG_BUSINESS_VERSION');
const profile=app.getPath('userData');
for(const name of ['license.json','credentials.secure.json','sessions.secure.json','data-fusion.sqlite'])if(fs.readFileSync(path.join(profile,name),'utf8')!=='isolated-preservation-'+name)throw Error('PROFILE_CHANGED');
const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><title>业务更新验证</title><h1>业务版本 ${nextVersion}</h1>'));
window.webContents.once('did-finish-load',()=>{context.ready();fs.writeFileSync(path.join(profile,'native-result.json'),JSON.stringify({version:context.version,shellVersion:context.shellVersion,packaged:app.isPackaged,offline:context.offline,profilePreserved:true,root:context.root}));setTimeout(()=>app.exit(0),100);});
`);
  const file = join(root, 'business-' + nextVersion + '.asar'); await createPackage(stage, file);
  const bytes = await readFile(file);
  const manifest = { schema: 1, product: metadata.product, version: nextVersion, minShellVersion: version, target,
    url: origin + '/business/v1/win32/x64/standard/electron-' + target.electronMajor + '/' + nextVersion + '/business-' + nextVersion + '.asar', bytes: bytes.length, sha256: digest(bytes), backend };
  const entry = { file, bytes, manifest }; payloads.set(nextVersion, entry); return entry;
}
async function profile(name) {
  const directory = join(root, name); await mkdir(directory);
  for (const file of ['license.json', 'credentials.secure.json', 'sessions.secure.json', 'data-fusion.sqlite']) await writeFile(join(directory, file), 'isolated-preservation-' + file);
  return directory;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(work, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = await work(); if (result) return result; await sleep(100); }
  throw Error('Native startup condition timed out');
}
async function start(profileDirectory, blocked = false) {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  let stderr = '';
  const environment = { ...process.env, DATA_FUSION_STARTUP_TEST: '1' }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(join(app, 'DataFusion.exe'), ['--user-data-dir=' + profileDirectory, '--remote-debugging-port=' + port], { env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8000); });
  const deadline = setTimeout(() => child.kill(), 45000);
  try {
    if (!blocked) {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(code, 0, stderr); return JSON.parse(await readFile(join(profileDirectory, 'native-result.json'), 'utf8'));
    }
    const page = await until(async () => {
      try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(item => item.type === 'page' && item.url.endsWith('business-startup.html')); }
      catch { return null; }
    });
    const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let sequence = 0; const pending = new Map();
    ws.addEventListener('message', event => { const value = JSON.parse(event.data), entry = pending.get(value.id); if (entry) { pending.delete(value.id); value.error ? entry.reject(Error(value.error.message)) : entry.resolve(value.result); } });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    await until(async () => (await cdp('Runtime.evaluate', { expression: "document.getElementById('message').textContent", returnByValue: true })).result.value === '暂时无法进入应用');
    assert.equal((await cdp('Runtime.evaluate', { expression: "document.getElementById('retry').hidden", returnByValue: true })).result.value, false);
    const capture = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(join(profileDirectory, 'blocked.png'), Buffer.from(capture.data, 'base64'));
    const result = await readFile(join(profileDirectory, 'native-result.json')).then(() => true, () => false); assert.equal(result, false);
    ws.close(); child.kill(); await new Promise(resolve => child.once('exit', resolve)); return { blocked: true };
  } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill(); }
}

try {
  const builtin = await makePayload(version); await makePayload('1.1.1'); await makePayload('1.1.2');
  const stage = join(root, 'base'); await mkdir(stage); await mkdir(join(root, 'builtin'));
  for (const name of ['business-bootstrap.cjs', 'business-preload.cjs', 'business-startup.html', 'business-updater.cjs']) await copyFile(join(project, 'resources', name), join(stage, name));
  await copyFile(builtin.file, join(root, 'builtin/builtin.asar'));
  await writeFile(join(stage, 'shell.json'), JSON.stringify({ schema: 1, testing: true, product: 'data-fusion-desktop', shellVersion: version,
    baseBusinessVersion: version, target, feedBase: origin + '/business/v1/', publicKey,
    builtin: { bytes: builtin.bytes.length, sha256: digest(builtin.bytes), version, minShellVersion: version, backend } }));
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'data-fusion-desktop', productName: '数据融合启动更新验证', version, main: 'business-bootstrap.cjs', author: 'DataFusion QA', description: 'Isolated startup validation', dependencies: {} }));
  const output = join(root, 'packaged');
  await build({ targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64), projectDir: stage, config: {
    appId: 'cn.zzkj.datafusion.desktop', productName: '数据融合启动更新验证', electronVersion,
    electronDist: legacy ? join(project, '.tmp/win7-runtime/22.3.27/x64') : join(project, 'node_modules/electron/dist'),
    directories: { app: stage, output }, files: ['*.cjs', '*.html', '*.json', '!node_modules/**/*'], extraResources: [{ from: join(root, 'builtin'), to: 'business' }],
    asar: true, npmRebuild: false, electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true, ...(!legacy ? { enableEmbeddedAsarIntegrityValidation: true } : {}) },
    win: { executableName: 'DataFusion', signAndEditExecutable: true },
  } });
  app = join(output, 'win-unpacked');
  const originalAsar = digest(await readFile(join(app, 'resources/app.asar'))), originalExe = digest(await readFile(join(app, 'DataFusion.exe')));
  const wire = await getCurrentFuseWire(join(app, 'DataFusion.exe'));
  assert.equal(wire[FuseV1Options.OnlyLoadAppFromAsar], FuseState.ENABLE);
  if (!legacy) assert.equal(wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], FuseState.ENABLE);
  const regular = await profile('regular-profile'); const updated = await start(regular);
  assert.equal(updated.version, '1.1.1'); assert.equal(updated.offline, false); assert.equal(downloads, 1);
  mode = 'offline'; const cached = await start(regular); assert.equal(cached.version, '1.1.1'); assert.equal(cached.offline, true); assert.equal(downloads, 1);
  const fresh = await profile('fresh-offline-profile'); const initial = await start(fresh); assert.equal(initial.version, version); assert.equal(initial.offline, true);
  const mandatory = await profile('mandatory-profile'); mode = 'pending'; await start(mandatory, true);
  mode = 'offline'; await start(mandatory, true);
  assert.equal(digest(await readFile(join(app, 'resources/app.asar'))), originalAsar); assert.equal(digest(await readFile(join(app, 'DataFusion.exe'))), originalExe);
  const result = { passed: true, electronVersion, target, root, updated, cached, freshOffline: initial, mandatoryUpdateCannotBeBypassedOffline: true,
    baseAsarUnchanged: true, nativeExecutableUnchanged: true, embeddedAsarIntegrityRetained: !legacy, onlyLoadAppFromAsarRetained: true, realBusinessApiCalls: 0 };
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await new Promise(resolve => server.close(resolve)); }
