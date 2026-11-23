import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { LoginTabController } from '../src/main/login-tab';
import { SessionRecoveryService } from '../src/main/session-recovery';
import { AppError } from '../src/core/errors/app-error';
import type { BusinessSystemPlugin } from '../src/core/plugins/types';
import { marketAccessPlugin } from '../src/plugins/market-access';
import { PUBLICATION_PLATFORMS } from '../src/core/publication/platforms';

// Local fixtures only: no business API, production credentials, or app user-data access.
const ids = ['government-info', 'market-access', 'transport-practitioner', 'oversize-transport', 'online-car-permit'];
const names = ['政务综合信息系统', '广东省市场准入信息系统', '广东省道路运输从业人员管理服务平台', '广东省交通运输厅大件运输许可系统', '惠州市网约车监管系统（车证）'];
const controller = new LoginTabController();
const credentials = new Map<string, { account: string; password: string }>();
const vault = new Map<string, string>();
const recovery = new SessionRecoveryService({ get: async (key) => vault.get(key) ?? null,
  set: async (key, value) => { vault.set(key, value); }, delete: async (key) => { vault.delete(key); }, flush: async () => {} });
let manualDetections = 0;
let main: BrowserWindow | undefined;
let directory = '';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const market = req.url?.includes('/market-access/');
  const accountField = req.url?.includes('/government-info/') ? 'id="txt_flag"' : market ? 'id="loginname" name="loginname"' : 'name="username"';
  // Mirror the real market page's text-type password and hidden duplicate field; fixture secrets only.
  const passwordFields = market
    ? '<input type="text" id="loginpwd" hidden><input type="text" id="loginpwd" name="loginpwd" data-live-password onfocus="this.type=\'password\'">'
    : '<input type="password" id="txt_pwd" name="password">';
  res.end(`<!doctype html><title>Source fixture</title><form><input ${accountField}>${passwordFields}<input name="captcha"><button type="button" id="complete">模拟登录</button></form><script>window.fixtureSubmissions=0;document.querySelector("form").onsubmit=e=>{e.preventDefault();window.fixtureSubmissions++;};document.querySelector("#complete").onclick=()=>{sessionStorage.setItem("fixture-session","retained");history.pushState({},"","records");document.body.innerHTML="<h1>已登录测试页</h1><input id=record-filter>";};</script>`);
});
const ssoServer = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>SSO test login</title><h1>统一认证登录</h1>');
});
async function until(check: () => Promise<unknown> | unknown, label: string, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timed out: ${label}`);
}
const dom = (expression: string) => main!.webContents.executeJavaScript(expression);
const click = (selector: string) => dom(`document.querySelector(${JSON.stringify(selector)})?.click()`);

async function run() {
  directory = await mkdtemp(join(tmpdir(), 'fusion-source-tabs-smoke-'));
  app.setPath('userData', directory);
  await app.whenReady();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const plugins = ids.map((id, index): BusinessSystemPlugin => ({
    id, name: names[index], version: '0.0.0', matters: [], auth: {} as BusinessSystemPlugin['auth'],
    initialize: async () => {}, getSessionState: async () => ({ status: 'logged-out', systemId: id }),
    loginPage: { url: `${origin}/${id}/login`, allowedOrigin: origin, partition: `smoke-${id}`,
      credentialFields: id === 'government-info' ? { account: '#txt_flag', password: '#txt_pwd' }
        : id === 'market-access' ? marketAccessPlugin.loginPage!.credentialFields : undefined },
    sessionRecovery: { snapshot: () => ({ fixture: 'unchanged-before-and-after-login' }), restore: () => {}, homeUrl: () => `${origin}/${id}/records`,
      validate: async () => {
        const page = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(`${origin}/${id}/`));
        if (!page || !await page.executeJavaScript('sessionStorage.getItem("fixture-session") === "retained"')) {
          throw new AppError('REMOTE_REQUEST_FAILED', 'fixture login not yet completed');
        }
        return { displayName: 'Fixture user' };
      },
    },
  }));
  for (const plugin of plugins) await recovery.register(plugin);
  main = new BrowserWindow({ width: 1440, height: 900, show: false,
    webPreferences: { preload: resolve('.tmp/source-tabs-preload.cjs'), sandbox: true, contextIsolation: true } });
  ipcMain.handle('smoke:invoke', async (_event, method, id, account, password) => {
    switch (method) {
      case 'license': return { state: 'active', deviceId: 'fixture', grant: { expiresAt: Date.now() + 86400000, allowedSystems: ids } };
      case 'components': return plugins.map(plugin => ({ id:plugin.id, name:plugin.name, kind:'system', version:'0.0.0', authorized:true, workspaceMode:'return-ledger', supportsCredentialConfiguration:true }));
      case 'systems': return plugins.map(plugin => ({ id: plugin.id, name: plugin.name, version: '0.0.0', workspaceMode: 'return-ledger', supportsCredentialConfiguration: true, session: { status: 'logged-out', systemId: plugin.id } }));
      case 'session': if (account === true) manualDetections++; return plugins.find((plugin) => plugin.id === id)!.getSessionState({ force: account === true });
      case 'matters': return ['水务局', '城管局', '其他'].map((name, index) => ({ id: `matter-${index}`, name: `${name}测试事项`, departmentId: `department-${index}`, departmentName: name, departmentOrder: index, executionMode: 'one-click-return', querySchema: [{ key: 'startDate', label: '开始日期', type: 'date' }], defaultFilters: { startDate: '2026-09-01' }, uniqueKey: ['id'] }));
      case 'credentials': credentials.set(id, { account, password }); return { configured: true, account };
      case 'login': controller.open(main!, plugins.find(plugin => plugin.id === id)!, credentials.get(id) ?? null); break;
      case 'activate': controller.activate(id); break;
      case 'close': controller.close(id); break;
      case 'back': return controller.back(id);
      case 'reload': controller.reload(id); return true;
    }
    return controller.state();
  });
  await main.loadFile(resolve('out/renderer/index.html'));
  await until(() => dom('document.querySelectorAll(".system-nav-toggle").length === 5'), 'workspace');
  assert.equal(await dom('document.querySelectorAll(".department-nav-title").length'), 0);
  await click('.system-nav-toggle');
  await until(() => dom('document.querySelectorAll(".department-nav-title").length === 3'), 'department menu');
  assert.equal(await dom('document.querySelectorAll(".matter-subnav button").length'), 0);
  await click('.department-nav-title');
  assert.equal(await dom('document.querySelectorAll(".matter-subnav button").length'), 1);
  await click('.department-nav-title');
  assert.equal(await dom('document.querySelectorAll(".matter-subnav button").length'), 0);
  await click('.system-nav-toggle');
  assert.equal(await dom('document.querySelectorAll(".department-nav-title").length'), 0);
  await click('.system-nav-toggle'); await click('.department-nav-title');
  await dom('document.querySelector(".return-date-fields input").focus()');
  const originalFilter = await dom('document.querySelector(".return-date-fields input").value');

  // Open all five systems; only fixture credentials are passed to two of the forms.
  for (const id of ids) await dom(`window.desktopApi.systems.login(${JSON.stringify(id)})`);
  await until(() => controller.state().tabs.every(tab => !tab.loading), 'five source tabs');
  assert.equal(controller.state().tabs.length, 5);
  assert.equal(await dom('document.querySelectorAll(".source-tab").length'), 5);
  for (const id of ['government-info', 'market-access']) {
    await dom(`window.desktopApi.credentials.save(${JSON.stringify(id)}, "fixture-account", "fixture-password")`);
    await dom(`window.desktopApi.systems.login(${JSON.stringify(id)})`);
    const contents = webContents.getAllWebContents().find(item => item.getURL() === `${origin}/${id}/login`)!;
    const selector = id === 'government-info' ? '#txt_flag' : '#loginname';
    await until(() => contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).value === "fixture-account"`), `${id} credential fill`);
    assert.equal(await contents.executeJavaScript('document.querySelector("input[type=password]").value'), 'fixture-password');
    assert.equal(await contents.executeJavaScript('document.querySelector("input[name=captcha]").value'), '');
    assert.equal(await contents.executeJavaScript('window.fixtureSubmissions'), 0);
  }
  const marketPage = webContents.getAllWebContents().find(contents => contents.getURL() === `${origin}/market-access/login`)!;
  assert.equal(await marketPage.executeJavaScript('document.querySelector("[data-live-password]").type'), 'password');
  assert.equal(await marketPage.executeJavaScript('document.querySelector("#loginpwd[hidden]").value'), '');
  // Reopening must not overwrite user edits, including a captcha already entered by the user.
  await marketPage.executeJavaScript('document.querySelector("#loginname").value="user-edited-account";document.querySelector("[data-live-password]").value="user-edited-password";document.querySelector("input[name=captcha]").value="user-captcha";');
  await dom('window.desktopApi.systems.login("market-access")');
  assert.equal(await marketPage.executeJavaScript('document.querySelector("#loginname").value'), 'user-edited-account');
  assert.equal(await marketPage.executeJavaScript('document.querySelector("[data-live-password]").value'), 'user-edited-password');
  assert.equal(await marketPage.executeJavaScript('document.querySelector("input[name=captcha]").value'), 'user-captcha');
  assert.equal(await marketPage.executeJavaScript('window.fixtureSubmissions'), 0);
  // Close/reopen with saved settings covers fill-on-load, not only fill on an existing page.
  await dom('window.desktopApi.systems.closeLogin("market-access")');
  await dom('window.desktopApi.systems.login("market-access")');
  await until(() => controller.state().tabs.every(tab => !tab.loading), 'market reopened with configured credentials');
  const reopenedMarket = webContents.getAllWebContents().find(contents => contents.getURL() === `${origin}/market-access/login`)!;
  await until(() => reopenedMarket.executeJavaScript('document.querySelector("#loginname").value==="fixture-account" && document.querySelector("[data-live-password]").value==="fixture-password"'), 'market legacy form fills after navigation');
  assert.equal(await reopenedMarket.executeJavaScript('document.querySelector("[data-live-password]").type'), 'password');
  assert.equal(await reopenedMarket.executeJavaScript('document.querySelector("input[name=captcha]").value'), '');
  assert.equal(await reopenedMarket.executeJavaScript('window.fixtureSubmissions'), 0);
  const gov = webContents.getAllWebContents().find(contents => contents.getURL() === `${origin}/government-info/login`)!;
  await gov.executeJavaScript('document.querySelector("#complete").click(); document.querySelector("#record-filter").value="保留查询条件"');
  await dom('window.desktopApi.systems.activateTab("government-info")');
  await until(() => dom('document.querySelector(".login-detection")?.textContent.includes("已识别登录")'), 'automatic login detection after failed pre-login check');
  assert.equal(manualDetections, 0, 'Automatic detection must not require clicking the manual button');
  await click('.browser-tab');
  await until(() => dom('!document.querySelector("main").hidden'), 'workspace restored');
  assert.equal(await dom('document.querySelector(".return-date-fields input").value'), originalFilter);
  assert.equal(await dom('document.querySelectorAll(".matter-subnav button").length'), 1);
  await click('.source-tab-select');
  await dom('window.desktopApi.systems.login("government-info")');
  assert.equal(gov.getURL(), `${origin}/government-info/records`);
  assert.equal(await gov.executeJavaScript('document.querySelector("#record-filter").value'), '保留查询条件');
  assert.equal(await gov.executeJavaScript('sessionStorage.getItem("fixture-session")'), 'retained');

  await dom('window.desktopApi.credentials.save("transport-practitioner","fixture-account","fixture-password");');
  await dom('window.desktopApi.systems.login("transport-practitioner")');
  const practitioner = webContents.getAllWebContents().find(contents => contents.getURL() === `${origin}/transport-practitioner/login`)!;
  await until(() => practitioner.executeJavaScript('document.querySelector("input[name=username]").value === "fixture-account"'), 'saved credential autofill');
  assert.equal(await practitioner.executeJavaScript('document.querySelector("input[name=password]").value'), 'fixture-password');
  assert.equal(await practitioner.executeJavaScript('document.querySelector("input[name=captcha]").value'), '');
  assert(!JSON.stringify(controller.state()).includes('fixture-password'));

  await dom('window.desktopApi.systems.activateTab("government-info")');
  await practitioner.executeJavaScript('document.querySelector("#complete").click()');
  // A five-second negative cache can outlive the next five-second poll by a few milliseconds.
  await until(() => recovery.canRestore('transport-practitioner'), 'background source tab detected by main process', 15_000);
  await dom('window.desktopApi.systems.activateTab("transport-practitioner")');
  await until(() => dom('document.querySelector(".login-detection")?.textContent.includes("已识别登录")'), 'background login status pushed to renderer');
  await click('.detect-login-button');
  await until(() => dom('!document.querySelector("main").hidden'), 'manual detection returns to workspace');
  assert.equal(manualDetections, 1, 'Manual detection must force a new verification');
  await dom('window.desktopApi.systems.activateTab("transport-practitioner")');

  // At the minimum supported width, native page bounds and React browser chrome must agree.
  main.setContentSize(1180, 720);
  await until(() => dom('window.innerWidth === 1180'), 'resize');
  assert.equal(await dom('document.querySelector(".sidebar").getBoundingClientRect().width'), 220);
  assert.equal(await dom('document.querySelector(".browser-remote-stage").getBoundingClientRect().top'), 104);
  assert.equal(await dom('document.querySelector(".browser-tabbar").scrollWidth <= document.querySelector(".browser-tabbar").clientWidth'), true);
  await dom('window.desktopApi.systems.closeLogin("market-access")');
  assert.equal(controller.currentSystemId(), 'transport-practitioner');
  assert.equal(controller.state().tabs.length, 4);
  await dom('window.desktopApi.systems.closeLogin("transport-practitioner")');
  assert.equal(controller.currentSystemId(), null);
  assert(!gov.isDestroyed());
  const publicationPages = [];
  for (const platform of Object.values(PUBLICATION_PLATFORMS)) {
    const page = { id: platform.id, name: platform.name,
      loginPage: { url: `${origin}/${platform.id}/login`, allowedOrigin: origin, partition: `smoke-${platform.id}` } };
    controller.open(main, page, null, { persistStorage: false });
    await until(() => controller.state().tabs.every(tab => !tab.loading), `${platform.id} loaded`);
    const contents = webContents.getAllWebContents().find(item => item.getURL() === page.loginPage.url)!;
    assert.equal(await contents.executeJavaScript('sessionStorage.getItem("fixture-session")'), null, 'Government storage must not enter a publication page');
    await contents.executeJavaScript('document.querySelector("#complete").click(); document.querySelector("#record-filter").value="保留公示页面条件"');
    await until(() => dom('Boolean(document.querySelector(".browser-toolbar .detect-login-button"))'), 'publication browser toolbar');
    assert.equal(await dom('document.querySelector(".detect-login-button").textContent'), '返回回流数据');
    assert.equal(await dom('document.querySelector(".login-detection")'), null);
    await click('.detect-login-button');
    await until(() => dom('!document.querySelector("main").hidden'), 'publication returns to workspace');
    controller.open(main, page, null, { persistStorage: false });
    assert.equal(contents.getURL(), `${origin}/${platform.id}/records`);
    assert.equal(await contents.executeJavaScript('document.querySelector("#record-filter").value'), '保留公示页面条件');
    assert(!gov.isDestroyed());
    assert.equal(await gov.executeJavaScript('document.querySelector("#record-filter").value'), '保留查询条件');
    publicationPages.push(contents);
  }
  controller.close('nanshan-publicity');
  assert(!publicationPages[1].isDestroyed());
  assert.equal(controller.currentSystemId(), 'guangdong-law-publicity');
  await new Promise<void>(resolve => ssoServer.listen(0, '127.0.0.1', resolve));
  const ssoOrigin = `http://127.0.0.1:${(ssoServer.address() as { port: number }).port}`;
  const loginUrl = ssoOrigin + '/zwrz/login';
  const portalUrl = origin + '/equipment/home';
  const transitions: boolean[] = [];
  controller.open(main, { id: 'equipment-cross-origin', name: '跨域登录测试', loginPage: {
    url: loginUrl, allowedOrigin: origin, additionalAllowedOrigins: [ssoOrigin], partition: 'smoke-cross-origin-sso',
    onLoginPageChange: visible => transitions.push(visible),
  } });
  await until(() => transitions.length === 1, 'cross-origin login entry detected');
  const ssoTab = webContents.getAllWebContents().find(contents => contents.getURL() === loginUrl)!;
  await ssoTab.executeJavaScript(`void (location.href = ${JSON.stringify(portalUrl)})`);
  await until(() => ssoTab.getURL() === portalUrl && transitions.length === 2, 'SSO redirects to allowed business portal');
  await ssoTab.executeJavaScript(`void (location.href = ${JSON.stringify(loginUrl)})`);
  await until(() => transitions.length === 3, 'cross-origin sign-out detected');
  assert.deepEqual(transitions, [true, false, true]);
  controller.close('equipment-cross-origin');
  console.log('PASS: cross-origin SSO login, business portal and sign-out use a single isolated source tab.');
  console.log('PASS: both publication views retain their login/page/form independently, reuse existing tabs, preserve business views, return without business-session detection, and close independently.');
  console.log('PASS: collapsible menus; five live tabs; page/form/session retention; saved credential fill; market legacy password masked and filled; user edits/captcha preserved; no automatic submit; automatic and background login detection; manual force detection; independent close; 1180px layout.');
}
void run().then(() => finish(0)).catch(error => { console.error(error); return finish(1); });
async function finish(code: number) {
  controller.close(); main?.destroy(); server.close(); ssoServer.close();
  // Delete only this test's unique temporary profile, never the real application profile.
  if (directory && dirname(resolve(directory)) === resolve(tmpdir()) && directory.startsWith(join(tmpdir(), 'fusion-source-tabs-smoke-'))) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  app.exit(code);
}
