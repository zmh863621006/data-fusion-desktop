import { app, BrowserWindow, session, webContents } from 'electron';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import type { BusinessSystemPlugin } from '../src/core/plugins/types';
import { LoginTabController } from '../src/main/login-tab';
import { SessionRecoveryService } from '../src/main/session-recovery';
import { observeBrowserAuth } from '../src/main/browser-auth';
import { OversizeTransportClient, OVERSIZE_API_ORIGIN, OVERSIZE_PORTAL_TOKEN_KEY } from '../src/plugins/oversize-transport/client';
import { oversizeTransportPlugin } from '../src/plugins/oversize-transport';
import { queryOversizeTransport } from '../src/plugins/oversize-transport/query';

// Isolated local fixtures only. No production credentials, profile, or government APIs.
const portalToken = '11111111-1111-1111-1111-111111111111';
const freshPortalToken = '33333333-3333-3333-3333-333333333333';
const apiToken = '22222222-2222-2222-2222-222222222222';
const vault = new Map<string, string>();
const controller = new LoginTabController();
const partition = 'persist:oversize-v3-smoke';
const rows = [0, 1, 2].map((i) => ({ id: String(i + 1), reqNo: i === 2 ? 'B44010020264413001' : `B441300202610120000${i}`,
  transportName: '本地测试企业', handerTime: '2026-10-12 17:27:58', startTime: '2026-11-01 00:00:00',
  endTime: '2027-01-31 23:59:59', roadLine: '测试起点—测试终点', status: i % 2 }));
let portalOrigin = '', apiOrigin = '';
let window: BrowserWindow | undefined;
let ssoCalls = 0, listCalls = 0, applicationCalls = 0;
const originalFetch = globalThis.fetch;
const api = createServer((req, res) => {
  const url = new URL(req.url!, apiOrigin);
  if (url.pathname === '/GDDJ/') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<h1>大件运输3.0本地测试子系统</h1><form><input id="username"><input type="password"></form>'); return;
  }
  res.setHeader('content-type', 'application/json');
  if (url.pathname.endsWith('/sso/login')) {
    ssoCalls++; assert.equal(url.searchParams.get('token'), ssoCalls === 1 ? portalToken : freshPortalToken);
    res.end(JSON.stringify({ code: 0, isSuccess: true, data: { token: apiToken } })); return;
  }
  if (url.pathname.endsWith('/selectRequest')) {
    applicationCalls++;
    assert.equal(req.method, 'POST'); assert.equal(req.headers.token, apiToken); assert.equal(req.headers.applicationid, '3');
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      const query = JSON.parse(body), certificate = rows.find(row => row.reqNo === query.reqNo);
      assert(certificate); assert.equal(query.pageNo, 1); assert.equal(query.pageSize, 10); assert.equal(query.status, '');
      res.end(JSON.stringify({ code: 0, isSuccess: true, data: { records: [{ id: `app-${certificate.id}`, reqNo: certificate.reqNo,
        transportName: certificate.transportName, transportCreditCode: '91440300123456789Q', agentName: '不可作为法人' }], total: '1', current: '1' } }));
    }); return;
  }
  listCalls++;
  assert.equal(req.headers.token, apiToken); assert.equal(req.headers.applicationid, '3');
  const size = Number(url.searchParams.get('pageSize')), page = Number(url.searchParams.get('pageNo'));
  res.end(JSON.stringify({ code: 0, isSuccess: true, data: { records: rows.slice((page - 1) * size, page * size), total: '3', current: String(page) } }));
});
const portal = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url?.startsWith('/appLzxt/login')) {
    const token = req.url.includes('logout') ? freshPortalToken : portalToken;
    res.end(`<form><input id="username" placeholder="用户名"><input type="password"><input id="captcha" placeholder="验证码"><button type="button" id="login">模拟用户完成登录</button></form><script>
      document.querySelector('#login').onclick=()=>{localStorage.setItem('${OVERSIZE_PORTAL_TOKEN_KEY}',JSON.stringify({value:'${token}'}));location.href='/appLzxt/manage/home'};
      </script>`); return;
  }
  res.end(`<h1>已登录的路政平台测试首页</h1><button id="subsystem" onclick="window.open('${apiOrigin}/GDDJ/')">大件运输3.0升级版</button>
    <a id="logout" href="/appLzxt/login?logout">退出登录</a>`);
});
async function until(check: () => Promise<unknown> | unknown, label: string) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(`Timeout: ${label}`);
}
async function run() {
  const directory = process.env.DATA_FUSION_UI_TEST_PROFILE;
  assert(directory, 'Run with the isolated-profile parent runner');
  app.setPath('userData', directory); await app.whenReady();
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => portal.listen(0, '127.0.0.1', resolve));
  apiOrigin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  portalOrigin = `http://127.0.0.1:${(portal.address() as { port: number }).port}`;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url));
    assert.equal(target.origin, OVERSIZE_API_ORIGIN);
    return originalFetch(new URL(target.pathname + target.search, apiOrigin), init);
  }) as typeof fetch;
  const client = new OversizeTransportClient();
  const plugin: BusinessSystemPlugin = { ...oversizeTransportPlugin,
    loginPage: { ...oversizeTransportPlugin.loginPage!, url: portalOrigin + '/appLzxt/login', allowedOrigin: portalOrigin,
      additionalAllowedOrigins: [apiOrigin], partition,
      onLoginPageChange: visible => client.setPortalLoginVisible(visible),
      browserAuth: { localStorageKeys: [OVERSIZE_PORTAL_TOKEN_KEY], accept: values => client.acceptPortalStorage(values) } },
    sessionRecovery: { snapshot: () => client.exportSession(), restore: value => client.restoreSession(value),
      validate: signal => client.validateSession(signal), homeUrl: () => portalOrigin + '/appLzxt/manage/home' },
    getSessionState: async () => ({ status: 'logged-out', systemId: 'oversize-transport' }),
  };
  const recovery = new SessionRecoveryService({ get: async key => vault.get(key) ?? null, set: async (key, value) => { vault.set(key, value); },
    delete: async key => { vault.delete(key); }, flush: async () => {} });
  await recovery.register(plugin);
  controller.configurePersistence({ load: id => recovery.storage(id), save: (id, values) => recovery.saveStorage(id, values),
    forget: id => recovery.forget(id, { awaitApiLogin: true }) });
  observeBrowserAuth({ partition, urlPattern: apiOrigin + '/gddj/api/*', header: 'token',
    credentialGeneration: () => client.browserAuthGeneration(), accept: value => client.acceptBrowserToken(value), clear: () => client.clearSession() });
  window = new BrowserWindow({ show: false, width: 1440, height: 900 }); await window.loadURL('data:text/html,<h1>本地隔离测试</h1>');
  controller.open(window, plugin, { account: 'fixture-account', password: 'fixture-password' });
  await until(() => webContents.getAllWebContents().find(page => page.getURL() === plugin.loginPage!.url), 'login tab');
  const source = webContents.getAllWebContents().find(page => page.getURL() === plugin.loginPage!.url)!;
  await until(() => source.executeJavaScript('document.querySelector("#username")?.value === "fixture-account"'), 'configured account');
  assert.equal(await source.executeJavaScript('document.querySelector("input[type=password]").value'), 'fixture-password');
  assert.equal(await source.executeJavaScript('document.querySelector("#captcha").value'), '');
  await source.executeJavaScript('document.querySelector("#login").click()');
  await until(() => client.isAuthenticated(), 'portal SSO and one-row verification');
  assert.equal((await plugin.getSessionState()).status, 'authenticated');
  assert.equal(ssoCalls, 1);
  const result = await queryOversizeTransport(client, { page: 1, pageSize: 10, filters: { startDate: '2026-10-01', endDate: '2026-10-18' } });
  assert.equal(result.total, 2); assert.equal(result.rows[0].xkJdrq, '2026-10-12'); assert.equal(result.rows[0].bz, '');
  assert.equal(applicationCalls, 2); assert.equal(result.rows[0].xkXdrShxym, '91440300123456789Q'); assert.equal(result.rows[0].xkFrdb, '');
  assert.equal(JSON.stringify(result).includes('不可作为法人'), false);
  controller.activate(null); assert.equal(source.isDestroyed(), false); controller.activate(plugin.id);
  await source.executeJavaScript('document.querySelector("#subsystem").click()');
  await until(() => source.getURL() === apiOrigin + '/GDDJ/' && !source.isLoading(), 'allowed subsystem popup');
  assert.equal(await source.executeJavaScript('document.querySelector("#username").value'), '');
  assert.equal(await source.executeJavaScript('document.querySelector("input[type=password]").value'), '');
  await recovery.capture(plugin.id); const saved = JSON.parse(vault.get('browser-session.v1.oversize-transport')!);
  const reopened = new OversizeTransportClient(); reopened.restoreSession(saved.api);
  assert.equal(reopened.isAuthenticated(), false); await reopened.validateSession(AbortSignal.timeout(5000));
  assert.equal(reopened.isAuthenticated(), true);
  assert.equal(controller.back(plugin.id), true);
  await until(() => source.getURL() === portalOrigin + '/appLzxt/manage/home' && !source.isLoading(), 'return to portal');
  // The backend still accepts the old fixture tokens and the login page retains localStorage.
  await source.executeJavaScript('document.querySelector("#logout").click()');
  await until(() => source.getURL().endsWith('/appLzxt/login?logout') && !source.isLoading()
    && !client.isAuthenticated() && !vault.size, 'portal logout and snapshot deletion');
  assert.equal((await plugin.getSessionState({ force: true })).status, 'logged-out');
  assert.equal(ssoCalls, 1);
  await until(() => source.executeJavaScript('document.querySelector("#username")?.value === "fixture-account"'), 'saved account after portal logout');
  await source.executeJavaScript('document.querySelector("#login").click()');
  await until(() => client.isAuthenticated() && recovery.canRestore(plugin.id), 'fresh login after portal logout');
  assert.equal((await plugin.getSessionState()).status, 'authenticated');
  assert.equal(ssoCalls, 2);
  await recovery.flush(); controller.close(); window.destroy();
  console.log(JSON.stringify({ ok: true, credentialAutofill: true, captchaUntouched: true, ssoCalls, listCalls, applicationCalls, sourceCreditCode: true,
    returnedRows: result.total, originalTabRetained: true, crossOriginCredentialsIsolated: true, sessionRecovered: true,
    portalLogoutRecognized: true, loginRestoredAfterLogout: true }));
}
run().then(() => { globalThis.fetch = originalFetch; api.close(); portal.close(); app.quit(); }).catch(error => {
  console.error(error); controller.close(); window?.destroy(); api.close(); portal.close(); app.exit(1);
});
