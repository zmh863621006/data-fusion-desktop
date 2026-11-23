import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { listPackage, extractFile } from '@electron/asar';
import fuses from '@electron/fuses';
import fuseConstants from '@electron/fuses/dist/constants.js';
import { graphicsExpression } from './fixtures/graphics-probe.mjs';
const { FuseV1Options, getCurrentFuseWire } = fuses;
const { FuseState } = fuseConstants;

const sourceMetadata = JSON.parse(await readFile('package.json', 'utf8'));
const root = resolve(process.argv[2] ?? `release/${sourceMetadata.version}/win-unpacked`);
const executable = join(root, 'DataFusion.exe');
const archive = join(root, 'resources/app.asar');
const bundledGraphics = await readFile(join(root, 'd3dcompiler_47.dll'));
assert.deepEqual(bundledGraphics, await readFile('node_modules/electron/dist/d3dcompiler_47.dll'));
const graphicsPolicy = JSON.parse(await readFile(join(root, 'resources/graphics-runtime.json'), 'utf8'));
assert.deepEqual(graphicsPolicy, { schema: 1, library: 'd3dcompiler_47.dll', provider: 'electron-bundled',
  bundledCompiler: true, installerPreflight: true, sha256: createHash('sha256').update(bundledGraphics).digest('hex') });
const archivedFile = name => extractFile(archive, join(...name.split('/')));
const files = listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
assert(files.includes('out/main/index.js') && files.includes('out/preload/index.js') && files.includes('out/renderer/index.html'));
for (const path of files) {
  assert(['out', 'node_modules', 'package.json'].includes(path.split('/')[0]), `Unexpected archive root: ${path}`);
  assert(!/(?:^|\/)(?:private|admin-server|\.tmp|local-data)(?:\/|$)|\.(?:pem|sqlite3?|secure\.json)$|(?:^|\/)\.env(?:\.|$)/i.test(path), `Private artifact in package: ${path}`);
}
for (const name of ['cheerio', 'exceljs', 'jszip']) assert(files.includes(`node_modules/${name}/package.json`), `Missing runtime dependency: ${name}`);
const metadata = JSON.parse(archivedFile('package.json').toString());
assert.equal(metadata.version, sourceMetadata.version);
for (const name of files.filter(name => name.startsWith('out/') && /\.(?:js|css|html|svg)$/.test(name))) {
  assert.deepEqual(archivedFile(name), await readFile(resolve(name)), `Stale packaged build: ${name}`);
}
const mainCode = archivedFile('out/main/index.js').toString();
const preloadCode = archivedFile('out/preload/index.js').toString();
for (const marker of ['PROVINCIAL_PERMIT_COLUMNS', '行政许可案件导入模板', 'guangdong-law', '省执法双公示']) assert(mainCode.includes(marker), `Provincial export implementation missing: ${marker}`);
for (const marker of ['NANSHAN_PERMIT_COLUMNS', 'validateNanshanPermit']) assert(mainCode.includes(marker), `Original Nanshan export implementation missing: ${marker}`);
const nanshanTemplate = JSON.parse(await readFile('src/core/double-publicity/nanshan-template.json','utf8'));
assert(mainCode.includes(nanshanTemplate.base64), 'Original two-sheet Nanshan workbook bytes are missing from the package');
for (const text of ['导出文件', 'enterpriseCandidates', '请填写当前行政许可,保存当前sheet即可.']) assert(mainCode.includes(text), `New export/reflow code missing: ${text}`);
for (const text of ['/gddj/api/approve/permission/selectRequest', 'transportCreditCode', 'oversizeApplicationEnrichment', 'sessionChanged']) assert(mainCode.includes(text), `Oversize application evidence missing: ${text}`);
for (const text of ['https://193.112.96.168', 'AutomaticUpdateController', 'Uninstall DataFusion.exe', 'DATA_FUSION_UPDATE_CONFIG', 'DataFusion.UpdateHost.exe']) assert(mainCode.includes(text), `Automatic update implementation missing: ${text}`);
for (const text of ['constructionWastePrincipal', '施工单位', '水务局为代申请人，未从成果附件唯一取得施工单位']) assert(mainCode.includes(text), `Construction-waste contractor fix missing: ${text}`);
const updateHost = await readFile(join(root,'resources/update/DataFusion.UpdateHost.exe'));
assert.deepEqual(updateHost,await readFile('resources/DataFusion.UpdateHost.exe'));
for (const text of ['parent_exited_without_commit','installer_hash_mismatch','installed_version_mismatch']) assert(updateHost.includes(Buffer.from(text, 'utf16le')), `Native update host program missing: ${text}`);
for (const text of ['powershell.exe', 'EncodedCommand', 'DataFusion.Update.Script']) {
  assert(!updateHost.includes(Buffer.from(text)) && !updateHost.includes(Buffer.from(text, 'utf16le')), `Script interpreter dependency in update host: ${text}`);
}
for (const channel of ['updates:state', 'updates:changed', 'updates:download', 'updates:install']) assert(preloadCode.includes(channel), `Update IPC missing: ${channel}`);
assert(preloadCode.includes('exports:open-folder'), 'Export folder link IPC is missing');
assert(preloadCode.includes('components:list'), 'Unified licensed component discovery IPC is missing');
assert(mainCode.includes('listComponents'), 'Fast component discovery is missing');
for (const text of ['publication:open', 'nanshan-publicity', 'guangdong-law-publicity', 'https://nsxy.szns.gov.cn/credit/#/home', 'https://xtbg.gdzwfw.gov.cn/orgDev/rz/index.html?appid=wl2bee594e73']) assert(mainCode.includes(text), `Publication login entry missing: ${text}`);
assert(preloadCode.includes('publication:open'), 'Publication login entry IPC is missing');
for (const text of ['bj_bjsj', '办结开始日期', '办结截止日期', '2022年12月1日住房和城乡建设部令第56号修正', '特发此证']) assert(mainCode.includes(text), `Government completion query or fixed drainage content missing: ${text}`);
const compactMain = mainCode.replace(/\s+/g, '');
for (const bound of ['flag:16,sqlType:93', 'flag:17,sqlType:93']) assert(compactMain.includes(bound), `Timestamp type missing from packaged completion bound: ${bound}`);
assert(mainCode.includes('EMPTY_EXPORT_RESPONSE'), 'Explicit empty-export response handling is missing');
for (const id of ['market-access', 'government-info', 'transport-practitioner', 'oversize-transport', 'online-car-permit', 'guangdong-hrss', 'shenzhen-hazardous-chemicals', 'guangdong-special-equipment', 'guangdong-food-drug', 'guangdong-population', 'shenzhen-integrated-services']) assert(mainCode.includes(id), `Missing bundled system: ${id}`);
for (const marker of ['https://szwh.yjgl.sz.gov.cn', 'selectHandleDoneApprProcessList', 'getElectronicLicenseList', 'certificationDataReportList']) assert(mainCode.includes(marker), `Missing hazardous-chemical reflow capability: ${marker}`);
for (const marker of ['HrssDashboardWindow', 'successfulSnapshots', 'installSourceCertificateTrust']) assert(mainCode.includes(marker), `Missing HRSS capability: ${marker}`);
assert(mainCode.includes('99:A4:5E:36:EF:E5:CE:EA:37:77:76:CB:D3:AE:1E:3C:67:40:3E:A3:98:26:0B:D6:73:20:B7:BD:08:13:AF:6F')
  && /unknownCertificate:\s*["']reject["']/.test(mainCode), 'HRSS approved first-use certificate policy must be bundled');
for (const marker of ['requestedStartDate', 'requestedEndDate', 'dateFilterStatus']) assert(mainCode.includes(marker), `HRSS pending date metadata missing: ${marker}`);
for (const channel of ['hrss:dashboard:get', 'hrss:dashboard:open', 'hrss:dashboard:close']) assert(preloadCode.includes(channel), `Missing HRSS IPC: ${channel}`);
const wire = await getCurrentFuseWire(executable);
for (const option of [FuseV1Options.RunAsNode, FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseV1Options.EnableNodeCliInspectArguments]) assert.equal(wire[option], FuseState.DISABLE);
for (const option of [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseV1Options.OnlyLoadAppFromAsar]) assert.equal(wire[option], FuseState.ENABLE);
assert.deepEqual(await readFile(join(root, 'resources/icons/app-icon.png')), await readFile('resources/app-icon.png'));

const profile = await mkdtemp(join(tmpdir(), 'data-fusion-release-'));
const evidence = resolve('.tmp', `release-qa-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const requests = [];
const fixture = createServer(async (request, response) => {
  const url = request.url ?? '/'; requests.push(url);
  let text = ''; for await (const part of request) text += part;
  response.setHeader('content-type', 'application/json');
  if (url === '/api/health') return response.end(JSON.stringify({ status: 'ok' }));
  if (url === '/api/activate') { response.statusCode = 400; return response.end(JSON.stringify({ error: 'Release test: no development authorization' })); }
  response.statusCode = 403; response.end(JSON.stringify({ error: 'External network blocked by release fixture' }));
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const environment = { ...process.env, ELECTRON_RENDERER_URL: fixtureOrigin + '/must-not-load-dev-page',
  DATA_FUSION_LICENSE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  DATA_FUSION_UPDATE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  DATA_FUSION_ACTIVATION_URL: fixtureOrigin + '/api/activate', DATA_FUSION_LICENSE_STATUS_URL: fixtureOrigin + '/api/license/status',
  DATA_FUSION_UPDATE_URL: fixtureOrigin + '/api/updates/manifest', DATA_FUSION_ENTERPRISE_URL: fixtureOrigin + '/api/enterprises/resolve' };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;
let child, websocket, closed, errorOutput = '', sequence = 0;
const pending = new Map();
let applicationTarget;
const start = Date.now();
async function until(action, message, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const result = await action(); if (result) return result; } catch {} await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(message);
}
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    websocket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('Packaged renderer evaluation failed');
  return result.result?.value;
}
try {
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--proxy-server=${fixtureOrigin}`, '--proxy-bypass-list=localhost;127.0.0.1'];
  child = spawn(executable, args, { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  closed = new Promise(resolve => child.once('close', code => resolve(code)));
  child.once('error', error => { errorOutput += error.name; });
  child.stderr.on('data', data => { errorOutput = (errorOutput + data.toString()).slice(-30000); });
  child.stdout.resume();
  applicationTarget = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === 'page' && target.url.startsWith('file:')), 'Packaged application did not open a local page');
  websocket = new WebSocket(applicationTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { websocket.addEventListener('open', resolve, { once: true }); websocket.addEventListener('error', reject, { once: true }); });
  websocket.addEventListener('message', event => { const data = JSON.parse(event.data); const entry = pending.get(data.id); if (!entry) return; pending.delete(data.id); data.error ? entry.reject(new Error(data.error.message)) : entry.resolve(data.result); });
  await until(() => evaluate('Boolean(window.desktopApi && document.querySelector(".activation-shell"))'), 'Activation page/preload did not load');
  const startupMs = Date.now() - start;
  assert(await evaluate('document.querySelector("h1").textContent.includes("激活数据融合助手")'));
  assert.equal(await evaluate('Boolean([...document.querySelectorAll("button")].find(b=>b.textContent.includes("本机开发授权")))'), false);
  assert.equal(await evaluate('typeof window.require'), 'undefined');
  assert.equal((await evaluate('window.desktopApi.license.status()')).state, 'missing');
  const modules = await evaluate('window.desktopApi.modules.list()'); assert.deepEqual(modules, [], 'Unlicensed components must not be exposed');
  assert.deepEqual(await evaluate('window.desktopApi.components.list()'), [], 'Unified catalog must enforce license boundaries');
  assert.equal(await evaluate('typeof window.desktopApi.exports.openFolder'), 'function');
  assert.equal(await evaluate('window.desktopApi.exports.openFolder("C:/Windows").then(()=>false,()=>true)'), true, 'Export folder IPC must reject arbitrary paths');
  assert.equal(await evaluate('window.desktopApi.publications.open("nanshan-publicity").then(()=>false,()=>true)'), true, 'Publication login entry requires government authorization');
  assert.equal(await evaluate('window.desktopApi.publications.open("https://attacker.invalid/").then(()=>false,()=>true)'), true, 'Publication IPC must reject caller-supplied URLs');
  const backend = await evaluate('window.desktopApi.backend.status()'); assert(backend.connected); assert.equal(backend.origin, fixtureOrigin);
  const mark = await evaluate('({complete:document.querySelector(".brand-mark img").complete,width:document.querySelector(".brand-mark img").naturalWidth})'); assert(mark.complete && mark.width > 0);
  assert.equal(await evaluate('window.desktopApi.license.activate("DF-DEV-LOCAL").then(()=>false,()=>true)'), true);
  const grant = Buffer.from(JSON.stringify({ licenseId: 'release-untrusted-key-fixture', activationMode: 'offline', issuedAt: Date.now(), expiresAt: Date.now() + 60000, allowedSystems: [], allowedTools: ['health-publicity'], allowExport: true }));
  const envelope = { algorithm: 'RSA-SHA256', payload: grant.toString('base64url'), signature: sign('RSA-SHA256', grant, privateKey).toString('base64url') };
  const key = 'DFL1.' + Buffer.from(JSON.stringify(envelope)).toString('base64url');
  assert.equal(await evaluate(`window.desktopApi.license.activate(${JSON.stringify(key)}).then(()=>false,()=>true)`), true, 'A shipped app must reject environment-injected signing keys');
  assert.equal((await evaluate('window.desktopApi.license.status()')).state, 'missing');
  assert.equal(await evaluate('window.desktopApi.healthTool.state().then(()=>false,()=>true)'), true);
  assert.equal(await evaluate('window.desktopApi.hrss.dashboard().then(()=>false,()=>true)'), true, 'HRSS statistics require a signed system scope');
  assert.equal(await evaluate('window.desktopApi.hrss.openDashboard().then(()=>false,()=>true)'), true, 'Unlicensed app must not create an HRSS window');
  assert.equal(await evaluate('window.desktopApi.hrss.closeDashboard().then(()=>false,()=>true)'), true, 'Main renderer must not impersonate the dedicated HRSS window');
  assert(!requests.some(url => url.includes('must-not-load-dev-page')));
  const graphics = await evaluate(graphicsExpression);
  assert.equal(graphics.canvas2d.passed, true);
  for (const context of graphics.webgl) { assert.equal(context.supported, true); assert.equal(context.shaderDrawPassed, true); }
  const graphicsHelper = join(evidence, 'D3DCompilerDiagnostic.exe');
  execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll', '/out:' + graphicsHelper, resolve('scripts/fixtures/d3dcompiler-diagnostic.cs')], { windowsHide: true });
  const compilerModules = JSON.parse(execFileSync(graphicsHelper, ['modules', executable, String(child.pid)], { windowsHide: true, encoding: 'utf8' }));
  const loadedCompilers = compilerModules.processes.flatMap(process => process.compilers);
  assert(loadedCompilers.length > 0, 'No loaded bundled compiler observed');
  assert(loadedCompilers.every(compiler => resolve(compiler.path).toLowerCase() === resolve(root, 'd3dcompiler_47.dll').toLowerCase()), 'Graphics process did not load the application-bundled compiler');
  await writeFile(join(evidence, 'graphics.json'), JSON.stringify({ graphics, compilerModules }, null, 2));
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(evidence, 'packaged-activation.png'), Buffer.from(screenshot.data, 'base64'));
  const second = spawn(executable, [`--user-data-dir=${profile}`], { windowsHide: true, env: environment, stdio: 'ignore' });
  const secondCode = await Promise.race([new Promise(resolve => second.once('close', resolve)), new Promise(resolve => setTimeout(() => { second.kill(); resolve('timeout'); }, 10000))]);
  assert.equal(secondCode, 0, 'Second launch must exit and wake the existing window');
  assert.equal(child.exitCode, null);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); assert.equal(pages.filter(target => target.type === 'page').length, 1);
  const report = { status: 'pass', version: metadata.version, startupMs, applicationFiles: files.length,
    runtimeDependencies: ['cheerio', 'exceljs', 'jszip'], privateArtifactsExcluded: true, fuseHardening: true,
    developmentPageIgnored: true, developmentLicenseRejected: true, substitutedSigningKeyRejected: true,
    bundledBusinessModules: 7, unauthorizedModulesHidden: true, bundledFilesMatchCurrentBuild: true,
    hrssLocalDashboardPresent: true, hrssAggregateIpcRestricted: true,
    hrssApprovedFirstUseCertificatePolicyBundled: true,
    exportTemplateAndReflowCodePresent: true, exportFolderIpcRestricted: true,
    constructionWasteProxyEnrichmentPresent: true,
    publicationLoginEntriesPresent: true, publicationEntryIpcRestricted: true,
    governmentCompletionDateQueryPresent: true, fixedNewDrainagePermitContentPresent: true,
    typedCompletionBoundsPresent: true, emptyExportResponseHandled: true,
    backendFixtureConnected: true, customBrandLoaded: true, singleInstance: true,
    officialBundledGraphicsVerified: true, actualLoadedCompilerFromApplication: true, graphicsPixelTestsPassed: true,
    productionServerMutations: 0, screenshot: 'packaged-activation.png', fixtureRequests: requests };
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence }, null, 2));
  await call('Browser.close').catch(() => {});
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 10000))]);
} catch (error) {
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ status: 'fail', error: error.message, stderr: errorOutput }, null, 2));
  throw error;
} finally {
  websocket?.close();
  if (child && child.exitCode === null) { child.kill(); await closed; }
  for (const entry of pending.values()) entry.reject(new Error('Release probe finished')); pending.clear();
  await new Promise(resolve => fixture.close(resolve));
  assert.equal(dirname(resolve(profile)), resolve(tmpdir()));
  assert(basename(profile).startsWith('data-fusion-release-'));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
