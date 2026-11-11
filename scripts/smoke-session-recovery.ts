import { app, BrowserWindow, session, safeStorage, webContents } from 'electron';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { SessionRecoveryService } from '../src/main/session-recovery';
import { SecureSessionStore } from '../src/main/session-store';
import { LoginTabController } from '../src/main/login-tab';
import { AppError } from '../src/core/errors/app-error';
import type { BusinessSystemPlugin } from '../src/core/plugins/types';

const option = (key: string) => process.argv.find((value) => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? '';
const profile = option('profile'); const origin = option('origin'); const phase = option('phase');
assert(profile && new URL(origin).hostname === '127.0.0.1');
app.setPath('userData', profile);
let window: BrowserWindow | undefined;
const controller = new LoginTabController();
async function until(check: () => Promise<unknown> | unknown, label: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error(`Timed out: ${label}`);
}
async function run() {
  await app.whenReady();
  assert(safeStorage.isEncryptionAvailable(), 'OS encryption is required; plaintext fallback is forbidden');
  const browser = session.fromPartition('persist:recovery-fixture');
  let token: string | null = phase === 'save' ? 'fixture-api-secret' : null;
  const plugin: BusinessSystemPlugin = {
    id: 'recovery-fixture', name: 'Recovery fixture', version: '1.0.0', matters: [], auth: {} as BusinessSystemPlugin['auth'],
    initialize: async () => {}, getSessionState: async () => ({ status: 'logged-out', systemId: 'recovery-fixture' }),
    loginPage: { url: `${origin}/login`, allowedOrigin: origin, partition: 'persist:recovery-fixture' },
    sessionRecovery: {
      snapshot: () => token ? { token } : null, restore: (value) => { token = String(value.token); }, homeUrl: () => `${origin}/home`,
      validate: async (signal) => {
        const response = await browser.fetch(`${origin}/check`, { signal, headers: { authorization: token ?? '' } });
        if (response.status === 401) throw new AppError('SESSION_EXPIRED', 'fixture expired');
        if (!response.ok) throw new Error('fixture offline');
        const body = await response.json() as { valid: boolean };
        assert(body.valid); return { displayName: 'Fixture user' };
      },
    },
  };
  const vault = new SecureSessionStore(resolve(profile, 'sessions.secure.json'));
  const key = 'browser-session.v1.recovery-fixture';
  const service = new SessionRecoveryService(vault);
  await service.register(plugin);
  controller.configurePersistence({ load: (id) => service.storage(id), save: (id, value) => service.saveStorage(id, value) });
  window = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true } });
  if (phase === 'save') {
    controller.open(window, plugin);
    await until(() => controller.state().tabs.every((tab) => !tab.loading), 'fixture login page');
    await until(async () => {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL() === `${origin}/home`);
      return page && await page.executeJavaScript('sessionStorage.getItem("page-token") === "fixture-page-secret"');
    }, 'fixture login storage');
    assert.equal((await plugin.getSessionState()).status, 'authenticated');
    await controller.flushSessionStorage();
    assert.equal(service.storage(plugin.id)['page-token'], 'fixture-page-secret');
  } else if (phase === 'restore') {
    assert.equal(token, 'fixture-api-secret');
    assert.deepEqual(await service.recoverableSystems([plugin.id]), [plugin.id]);
    controller.open(window, plugin, null, { url: plugin.sessionRecovery!.homeUrl(), background: true });
    await until(async () => {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL() === `${origin}/home`);
      return page && await page.executeJavaScript('document.body.dataset.ready === "true"');
    }, 'restored source homepage and sessionStorage');
    const page = webContents.getAllWebContents().find((contents) => contents.getURL() === `${origin}/home`)!;
    assert.equal(await page.executeJavaScript('localStorage.getItem("local-token")'), 'fixture-local-secret');
    assert((await browser.cookies.get({})).some((cookie) => cookie.name === 'fixtureSid' && cookie.httpOnly && cookie.session));
  } else if (phase === 'offline') {
    const before = await vault.get(key);
    assert.deepEqual(await service.recoverableSystems([plugin.id]), []);
    assert.equal((await plugin.getSessionState()).status, 'unverified');
    await service.capture(plugin.id);
    assert.equal(await vault.get(key), before);
  } else if (phase === 'expired') {
    assert.deepEqual(await service.recoverableSystems([plugin.id]), []);
    assert.equal((await plugin.getSessionState()).status, 'expired');
    assert.equal(await vault.get(key), null);
  } else if (phase === 'logout') {
    token = null; await browser.clearStorageData(); await service.forget(plugin.id);
    assert.equal(await vault.get(key), null);
  } else if (phase === 'after-logout') {
    assert.equal(token, null); assert.deepEqual(await service.recoverableSystems([plugin.id]), []);
    assert.equal((await browser.cookies.get({})).length, 0);
  } else throw new Error('Unknown fixture phase');
  await controller.flushSessionStorage();
  await service.flush();
  controller.close(); window.destroy();
  console.log(`PASS recovery ${phase}`);
  app.exit(0);
}
void run().catch((error) => { console.error(error); controller.close(); window?.destroy(); app.exit(1); });
