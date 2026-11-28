import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

// Uses the real compiled main/preload/React entry in disposable profiles. No
// activation server, business endpoint, real credentials or installed app is used.
const require = createRequire(import.meta.url), root = await mkdtemp(join(resolve('.tmp'), 'renderer-startup-native-'));
const source = resolve(process.env.DATA_FUSION_STARTUP_BUILD || 'out');
const runtime = process.argv.includes('--legacy') ? resolve('.tmp/win7-runtime/22.3.27/x64/electron.exe') : require('electron');
const results = [];
for (const scenario of ['missing-license', 'corrupt-license', 'delayed-catalog', 'react-failure', 'missing-js', 'missing-css']) {
  const directory = join(root, scenario), profile = join(directory, 'profile'), output = join(directory, 'out');
  await mkdir(profile, { recursive: true }); await cp(source, output, { recursive: true });
  await writeFile(join(profile, 'preserved.txt'), 'isolated-sentinel');
  if (scenario === 'corrupt-license') await writeFile(join(profile, 'license.json'), '{broken-fixture');
  if (scenario === 'delayed-catalog' || scenario === 'react-failure') {
    await writeFile(join(profile, 'license.json'), JSON.stringify({ activatedAt: Date.now(), developmentGrant: {
      licenseId: 'isolated-native-test', customerName: '隔离启动测试', expiresAt: Date.now() + 3600000,
      allowedSystems: [], allowedTools: [], allowExport: false, allowAutoUpdate: false,
    } }));
  }
  if (scenario === 'missing-js' || scenario === 'missing-css') {
    const file = join(output, 'renderer/index.html'), html = await readFile(file, 'utf8');
    const changed = scenario === 'missing-js' ? html.replace(/src="\.\/assets\/[^\"]+\.js"/, 'src="./assets/missing-fixture.js"')
      : html.replace(/href="\.\/assets\/[^\"]+\.css"/, 'href="./assets/missing-fixture.css"');
    assert.notEqual(changed, html); await writeFile(file, changed);
  }
  const entry = join(directory, 'entry.cjs');
  await writeFile(entry, `
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs');const path=require('node:path');
const profile=${JSON.stringify(profile)}, scenario=${JSON.stringify(scenario)};
app.commandLine.appendSwitch('user-data-dir',profile); app.setPath('userData',profile);
let sentReady=0,sentFailed=0,blockedNetwork=0,catalogStarted=0,catalogFinished=0,showRequests=0,finishing=false;
const originalShow=BrowserWindow.prototype.show;BrowserWindow.prototype.show=function(){showRequests++;return originalShow.call(this);};
const begin=Date.now(),originalHandle=ipcMain.handle.bind(ipcMain);
global.fetch=async()=>{blockedNetwork++;throw Error('External network disabled for isolated startup test');};
app.on('session-created',session=>session.webRequest.onBeforeRequest((details,callback)=>{
  const external=/^https?:/.test(details.url);if(external)blockedNetwork++;callback({cancel:external});
}));
ipcMain.handle=(channel,handler)=>originalHandle(channel,async(event,...args)=>{
  if(channel==='license:status'&&scenario==='react-failure')return {...await handler(event,...args),state:'invalid',message:{invalidReactChild:true}};
  if(channel==='components:list') {
    catalogStarted=Date.now();
    if(scenario==='delayed-catalog')await new Promise(resolve=>setTimeout(resolve,1800));
    const result=await handler(event,...args);catalogFinished=Date.now();
    return result;
  }
  return handler(event,...args);
});
async function finish(kind,code) {
  if(finishing)return;finishing=true;
  try {
    const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/renderer/index.html'));
    const view=window?await window.webContents.executeJavaScript('({root:document.getElementById("root").textContent,styled:document.styleSheets.length>0,workspace:!!document.querySelector(".app-shell"),activation:!!document.querySelector(".activation-shell")})').catch(()=>null):null;
    // Failed hidden renderers may have no compositor surface. Keep this startup
    // test independent of screenshots; the separate UI smoke verifies rendering.
    fs.writeFileSync(path.join(profile,'native-result.json'),JSON.stringify({scenario,kind,code,ready:sentReady,failed:sentFailed,view,visible:window?.isVisible(),showRequests,elapsedMs:Date.now()-begin,catalogStarted,catalogFinished,readyAt:kind==='ready'?Date.now():null,blockedNetwork}));
    app.exit(0);
  }catch(error){console.error(error);app.exit(2);}
}
global.__DATA_FUSION_BUSINESS_BOOTSTRAP__={schema:1,primaryInstance:true,profilePath:profile,shellVersion:'1.1.0',version:'1.1.16',root:${JSON.stringify(directory)},backend:{origin:'https://fixture-backend.invalid',revision:1},offline:true,
  check:async()=>({version:'1.1.16',offline:true}),cancelCheck:()=>{},
  ready:()=>{sentReady++;void finish('ready');},failed:code=>{sentFailed++;void finish('failed',code);}
};
setTimeout(()=>{console.error('Native startup watchdog expired');app.exit(3);},45000).unref();
require(${JSON.stringify(join(output, 'main/index.js'))});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let errors = '';
  const child = spawn(runtime, [entry, '--user-data-dir=' + profile], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', bytes => { errors = (errors + bytes.toString()).slice(-12000); });
  const timeout = setTimeout(() => child.kill(), 55000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
  finally { clearTimeout(timeout); }
  assert.equal(code, 0, errors);
  const result = JSON.parse(await readFile(join(profile, 'native-result.json'), 'utf8'));
  assert.equal(await readFile(join(profile, 'preserved.txt'), 'utf8'), 'isolated-sentinel');
  assert.equal(result.blockedNetwork, 0, 'No real upstream request is allowed');
  if (['missing-js', 'missing-css', 'react-failure'].includes(scenario)) {
    assert.equal(result.kind, 'failed'); assert.equal(result.ready, 0); assert.equal(result.failed, 1); assert.equal(result.visible, false);
    assert.equal(result.code, scenario === 'react-failure' ? 'BUSINESS_RENDERER_FAILED' : 'BUSINESS_RENDERER_TIMEOUT');
  } else {
    assert.equal(result.kind, 'ready'); assert.equal(result.ready, 1); assert.equal(result.failed, 0); assert.equal(result.showRequests, 1);
    assert.equal(result.view.styled, true);
    if (scenario === 'delayed-catalog') {
      assert.equal(result.view.workspace, true); assert(result.catalogFinished - result.catalogStarted >= 1700); assert(result.readyAt >= result.catalogFinished);
    } else assert.equal(result.view.activation, true);
    if (scenario === 'corrupt-license') {
      assert(result.view.root.includes('本地授权文件损坏'));
      assert.equal(await readFile(join(profile, 'license.json'), 'utf8'), '{broken-fixture');
      const copies = await readdir(join(profile, 'license-recovery')); assert.equal(copies.length, 1);
      assert.equal(await readFile(join(profile, 'license-recovery', copies[0]), 'utf8'), '{broken-fixture');
    }
  }
  results.push(result); console.log(JSON.stringify({ scenario, passed: true, elapsedMs: result.elapsedMs }));
}
await writeFile(join(root, 'result.json'), JSON.stringify({ passed: true, source, root, results }, null, 2));
console.log(JSON.stringify({ passed: true, root, scenarios: results.length }));
