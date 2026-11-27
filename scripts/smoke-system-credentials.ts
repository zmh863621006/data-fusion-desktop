import { app, BrowserWindow, ipcMain, webContents, nativeImage } from 'electron';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { LoginTabController, type SourcePage } from '../src/main/login-tab';
import { SecureCredentialStore } from '../src/main/credential-store';
import { createHousingRentalPlugin } from '../src/plugins/shenzhen-housing-rental';
import { createOneWindowPlugin } from '../src/plugins/shenzhen-one-window';
import { createShenzhenIntegratedPlugin } from '../src/plugins/shenzhen-integrated-services';
import { catalogOnlySystems, createCatalogOnlySystem } from '../src/plugins/catalog-only-systems';

assert(process.env.DATA_FUSION_UI_TEST_PROFILE, 'Use the isolated runner');
app.setPath('userData', process.env.DATA_FUSION_UI_TEST_PROFILE!);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const controller = new LoginTabController();
const plugins = [createHousingRentalPlugin(), createOneWindowPlugin(), createShenzhenIntegratedPlugin(), ...catalogOnlySystems.map(createCatalogOnlySystem)];
// Production runtime assigns the automation workspace when registering housing.
plugins[0].workspaceMode = 'automation';
const fields = [
  '<input name="username" autocomplete="username"><input name="password" type="password">',
  '<input id="uname" name="uname"><input id="password" type="password"><input id="capassword" type="password">',
  '<input id="pinCode" type="password"><button id="next-step" type="button" onclick="document.querySelector(\'#account-stage\').style.display=\'block\'">模拟完成密钥验证</button><div id="account-stage" style="display:none"><input id="username" name="casUn"><input id="passwordVal" type="text"><input id="casPd" type="hidden"></div>',
  '<input id="username"><input id="password" type="password">',
];
let externalRequests = 0;
const server = createServer((request, response) => {
  const path = new URL(request.url!, 'http://fixture').pathname;
  const index = plugins.findIndex(plugin => new URL(plugin.loginPage!.url).pathname === path);
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>合成登录页</title><form>${fields[index < 0 ? 0 : index]}<input name="captcha" id="authcode"><button>登录</button></form><script>
    window.fixtureSubmissions=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.fixtureSubmissions++};
    // Simulate expiry of the first short-lived observer before the human PIN step finishes.
    ${index === 2 ? "const savedSetTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>savedSetTimeout(fn,ms===30000?10:ms,...args);" : ''}
  </script>`);
});
const until = async (check: () => Promise<unknown>, message: string, timeout = 12_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error(message);
};
void app.whenReady().then(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const storePath = join(process.env.DATA_FUSION_UI_TEST_PROFILE!, 'credentials.secure.json');
  const store = new SecureCredentialStore(storePath);
  const sourcePages: SourcePage[] = plugins.map(plugin => ({ id: plugin.id, name: plugin.name, loginPage: {
    url: origin + new URL(plugin.loginPage!.url).pathname, partition: 'credentials-fixture-' + plugin.id,
    allowedOrigin: origin, credentialPaths: plugin.loginPage!.credentialPaths, credentialFields: plugin.loginPage!.credentialFields,
  } }));
  const main = new BrowserWindow({ width: 1440, height: 960, show: false, webPreferences: {
    preload: resolve('.tmp/credentials-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  main.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/.test(details.url)) { externalRequests++; callback({ cancel: true }); } else callback({});
  });
  ipcMain.handle('credentials-smoke', async (_event, method, ...args) => {
    const id = String(args[0] ?? '');
    const plugin = plugins.find(plugin => plugin.id === id);
    if (method === 'license.status') return { state: 'active', deviceId: 'synthetic-device', grant: { licenseId: 'synthetic-license', expiresAt: Date.now() + 86400000, allowedSystems: plugins.map(plugin => plugin.id), allowedTools: [] } };
    if (method === 'settings.get') return { defaultPageSize: 20 };
    if (method === 'components.list') return plugins.map(plugin => ({ id: plugin.id, name: plugin.name, kind: 'system', version: plugin.version, authorized: true, workspaceMode: plugin.workspaceMode, supportsCredentialConfiguration: plugin.supportsCredentialConfiguration }));
    if (method === 'systems.list') return plugins.map(plugin => ({ id: plugin.id, name: plugin.name, version: plugin.version, workspaceMode: plugin.workspaceMode, supportsCredentialConfiguration: plugin.supportsCredentialConfiguration, session: { systemId: plugin.id, status: 'logged-out' } }));
    if (method === 'systems.session') return { systemId: id, status: 'logged-out' };
    if (method === 'matters.list') return plugin!.matters.map(({ query, mergeRecord, createDefaultContext, ...matter }) => ({ ...matter, defaultFilters: createDefaultContext?.().filters }));
    if (method === 'tasks.list') return [];
    if (method === 'tasks.page' || method === 'records.list' || method === 'oneWindow.records') return { rows: [], total: 0 };
    if (method === 'housing.state') return { jobs: [], total: 0 };
    if (method === 'oneWindow.state') return { deliveryMode: 'workbook', running: false, batches: [], batchTotal: 0, sessionStatus: 'logged-out', plan: { matterId: id, schedule: { mode: 'manual' }, filters: { dateType: 'all', startDate: '', endDate: '', state: '' }, lastRunAt: null, nextRunAt: null } };
    if (method === 'credentials.status') { const value = await store.get(id); return { configured: !!value, account: value?.account ?? '' }; }
    if (method === 'credentials.save') { await store.set(id, { account: args[1], password: args[2] }); return { configured: true, account: args[1] }; }
    if (method === 'systems.login') controller.open(main, sourcePages.find(page => page.id === id)!, await store.get(id));
    if (method === 'systems.activateTab') controller.activate(args[0] as string | null);
    if (method === 'systems.closeLogin') controller.close(id);
    return controller.state();
  });
  await main.loadFile(resolve('out/renderer/index.html'));
  main.showInactive();
  const evaluate = (script: string) => main.webContents.executeJavaScript(script);
  await until(() => evaluate('document.querySelectorAll(".system-nav-toggle").length === 4'), 'System catalog must render');
  const results: string[] = [];
  const evidence = resolve('.tmp/system-credentials-native-' + process.versions.electron);
  await mkdir(evidence, { recursive: true });
  let screenshotAvailable = false;
  for (const [index, plugin] of plugins.entries()) {
    await evaluate(`Array.from(document.querySelectorAll('.system-nav-toggle')).find(button=>button.getAttribute('aria-label')===${JSON.stringify(plugin.name)}).click()`);
    await until(() => evaluate(`document.querySelector('.topbar h1')?.textContent === ${JSON.stringify(plugin.name)}`), 'System workspace must open');
    await evaluate(`Array.from(document.querySelectorAll('.session-box button')).find(button=>button.textContent==='账号配置').click()`);
    await until(() => evaluate('!!document.querySelector(".credential-form input:not(:disabled)")'), 'Configuration status must finish loading');
    if (index === 0) {
      const layout = await evaluate(`(() => { const panel=document.querySelector('.system-credential-card'), form=panel.querySelector('form');return {panel:panel.getBoundingClientRect().width,form:form.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth}; })()`);
      assert(layout.panel > 400 && layout.form > 400 && !layout.overflow);
      try {
        main.webContents.debugger.attach('1.3');
        await new Promise(resolve => setTimeout(resolve, 300));
        const screenshot = await main.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const bytes = Buffer.from(screenshot.data, 'base64');
        const pixels = nativeImage.createFromBuffer(bytes).toBitmap();
        let colored = 0;
        for (let i = 0; i < pixels.length; i += 4) if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 230) colored++;
        if (colored > 5000) { await writeFile(join(evidence, 'configuration.png'), bytes); screenshotAvailable = true; }
      } catch { /* Remote/locked Windows sessions can lack a Viz capture surface. Layout checks remain explicit. */ }
    }
    await evaluate(`(() => { const inputs=document.querySelectorAll('.credential-form input');for(const [i,value]of ['synthetic-account-${index}','synthetic-password-${index}'].entries()){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inputs[i],value);inputs[i].dispatchEvent(new Event('input',{bubbles:true}));} })()`);
    await until(() => evaluate('!document.querySelector(".credential-form button").disabled'), 'Save button must become available');
    await evaluate('document.querySelector(".credential-form").requestSubmit()');
    const target = sourcePages[index].loginPage!.url;
    await until(() => Promise.resolve(controller.state().activeSystemId === plugin.id), 'Saving must open the original source tab');
    let page = webContents.getAllWebContents().find(contents => contents.getURL() === target)!;
    await until(async () => { page = webContents.getAllWebContents().find(contents => contents.getURL() === target)!; return !!page && !page.isLoadingMainFrame(); }, 'Source login must load');
    if (index === 2) {
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await page.executeJavaScript('document.querySelector("#pinCode").value'), '');
      await page.executeJavaScript('document.querySelector("#pinCode").value="synthetic-pin";document.querySelector("#next-step").click()');
    }
    const accountSelector = index === 1 ? '#uname' : index === 2 || index === 3 ? '#username' : 'input[name=username]';
    const passwordSelector = index === 2 ? '#passwordVal' : index === 0 ? 'input[name=password]' : '#password';
    await until(() => page.executeJavaScript(`document.querySelector(${JSON.stringify(accountSelector)})?.value === 'synthetic-account-${index}'`), 'Saved credentials must fill the matching source form');
    assert.equal(await page.executeJavaScript(`document.querySelector(${JSON.stringify(passwordSelector)}).value`), `synthetic-password-${index}`);
    assert.equal(await page.executeJavaScript(`document.querySelector(${JSON.stringify(passwordSelector)}).type`), 'password');
    assert.equal(await page.executeJavaScript('document.querySelector("#authcode").value'), '');
    assert.equal(await page.executeJavaScript('window.fixtureSubmissions'), 0);
    if (index === 1) assert.equal(await page.executeJavaScript('document.querySelector("#capassword").value'), '');
    if (index === 2) {
      assert.equal(await page.executeJavaScript('document.querySelector("#pinCode").value'), 'synthetic-pin');
      assert.equal(await page.executeJavaScript('document.querySelector("#casPd").value'), '');
    }
    controller.activate(null);
    results.push(plugin.id);
  }
  for (const [index, plugin] of plugins.entries()) assert.deepEqual(await new SecureCredentialStore(storePath).get(plugin.id), { account: `synthetic-account-${index}`, password: `synthetic-password-${index}` });
  assert(!(await readFile(storePath, 'utf8')).includes('synthetic-password'));
  assert(!JSON.stringify(controller.state()).includes('synthetic-password'));
  assert.equal(externalRequests, 0);
  controller.close(); main.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
  console.log(JSON.stringify({ passed: true, electron: process.versions.electron, systems: results, encryptedConfiguration: true, pinAndCaptchaPreserved: true, automaticSubmissions: 0, externalRequests, screenshotAvailable, evidence }));
  app.exit(0);
}).catch(error => { console.error(error.name + ': ' + error.message); controller.close(); server.close(); app.exit(1); });
