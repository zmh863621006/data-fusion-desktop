import { app, session, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { HrssSessionBootstrap, type HrssSessionKind } from '../src/main/hrss-session-bootstrap';
import { prepareHrssBrowserSession } from '../src/main/hrss-browser-session';
import { observeBrowserAuthMany } from '../src/main/browser-auth';
import { HRSS_HOME_URL, HRSS_ORIGIN, HRSS_PARTITION } from '../src/plugins/guangdong-hrss/catalog';

assert(process.env.DATA_FUSION_UI_TEST_PROFILE, 'Use an isolated profile');
app.setPath('userData', process.env.DATA_FUSION_UI_TEST_PROFILE!);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP hrss.gdgov.cn 127.0.0.1');
app.on('window-all-closed', () => {});
void app.whenReady().then(async () => {
  await prepareHrssBrowserSession();
  const browser = session.fromPartition(HRSS_PARTITION);
  const ready = new Set<HrssSessionKind>();
  let externalRequests = 0, logoutRequests = 0;
  const cert = readFileSync(join(process.env.DATA_FUSION_UI_TEST_PROFILE!, 'fixture-cert.pem'));
  const key = readFileSync(join(process.env.DATA_FUSION_UI_TEST_PROFILE!, 'fixture-key.pem'));
  const pin = new X509Certificate(cert).fingerprint256;
  browser.setCertificateVerifyProc((request, callback) => callback(request.hostname === 'hrss.gdgov.cn'
    && new X509Certificate(request.certificate.data).fingerprint256 === pin ? 0 : -2));
  observeBrowserAuthMany(HRSS_PARTITION, [
    { urlPattern: HRSS_ORIGIN + '/employment/main/rest/*', header: 'access-token', accept: value => { assert.equal(value, 'synthetic-access-token'); ready.add('access'); }, clear: () => ready.delete('access') },
    { urlPattern: HRSS_ORIGIN + '/WGBT/*', header: 'cookie', accept: value => { assert(value.includes('WGBT_SESSION=synthetic')); ready.add('wgbt'); }, clear: () => ready.delete('wgbt') },
  ]);
  const paths: string[] = [];
  const server = createServer({ cert, key }, (request, response) => {
    const path = new URL(request.url!, HRSS_ORIGIN).pathname; paths.push(path);
    if (request.headers.host !== 'hrss.gdgov.cn') externalRequests++;
    if (path === '/logout-beacon') logoutRequests++;
    if (path.startsWith('/employment/main/rest/') || path === '/WGBT/session-check') {
      if (path.startsWith('/employment/')) assert.equal(request.headers['access-token'], 'synthetic-access-token');
      response.setHeader('Content-Type', 'application/json'); response.end('{"success":true}'); return;
    }
    const portal = `<div id="app">系统列表 退出</div><script>
      document.querySelector('#app').__vue__={$store:{state:{homeStore:{systemMenuList:[
        {navigationType:'1',prefix:'/employment/main/',url:'index.html'},
        {navigationType:'1',prefix:'/WGBT/',url:'index.html'}
      ],allMenuList:[{children:[{id:'training-query',name:'查询进度（创业培训补贴）',prefix:'/ZXZJ/',url:'jycyzjgl/web/cypxbt/cxjd/cxjd.do'}]}]}}}};
      window.indexTool={getSsoTokenStr:()=> 'synthetic-sso=fixture',openTabMenu:menu=>{
        const frame=document.createElement('iframe');frame.src=menu.prefix+menu.url+'?_modulePartId_='+menu.id+'&synthetic-sso=fixture';document.body.appendChild(frame);
      }};
    </script>`;
    const source = `<div>本地合成子系统</div><script>
      window.addEventListener('beforeunload',()=>navigator.sendBeacon('/logout-beacon','synthetic'));
      window.addEventListener('unload',()=>navigator.sendBeacon('/logout-beacon','synthetic'));
      ${path.startsWith('/employment/') ? "fetch('/employment/main/rest/bootstrap',{headers:{'Access-Token':'synthetic-access-token'}})" :
        path.startsWith('/WGBT/') ? "document.cookie='WGBT_SESSION=synthetic; Path=/WGBT/; Secure';fetch('/WGBT/session-check')" :
        "document.cookie='hz_zxzj=synthetic; Path=/ZXZJ/; Secure'"}
    </script>`;
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(path.startsWith('/portal/') ? portal : source);
  });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(443, '127.0.0.1', resolve); });
  const visible = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await visible.loadURL('data:text/html,<title>Visible source preserved</title>');
  const before = visible.webContents.getURL();
  const bootstrap = new HrssSessionBootstrap({ hasCredential: kind => ready.has(kind), acceptCookie: (kind, cookie) => {
    assert(cookie.includes('synthetic')); ready.add(kind);
  } });
  bootstrap.onNavigate(HRSS_HOME_URL);
  const end = Date.now() + 25_000;
  while (Date.now() < end && (ready.size !== 3 || BrowserWindow.getAllWindows().length !== 1)) await new Promise(resolve => setTimeout(resolve, 100));
  if (ready.size !== 3) console.log(JSON.stringify({ initialized: [...ready], paths }));
  assert.equal(ready.size, 3, 'All source session types must initialize through the actual browser');
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'All hidden pages must be released');
  assert.equal(visible.webContents.getURL(), before, 'Visible page must remain untouched');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(logoutRequests, 0, 'Destroying initialization pages must not trigger the source logout handlers');
  assert.equal(externalRequests, 0);
  assert(paths.includes('/employment/main/index.html') && paths.includes('/WGBT/index.html') && paths.includes('/ZXZJ/jycyzjgl/web/cypxbt/cxjd/cxjd.do'));
  bootstrap.cancel(); visible.destroy();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  console.log(JSON.stringify({ passed: true, electron: process.versions.electron, initializedKinds: 3,
    visiblePagePreserved: true, hiddenPagesReleased: true, logoutRequests, externalRequests, syntheticOnly: true }));
  app.exit(0);
}).catch(error => { console.error(error.name + ': ' + error.message); app.exit(1); });
