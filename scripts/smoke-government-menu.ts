import { app, BrowserWindow } from 'electron';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { registerIpcHandlers } from '../src/main/ipc';
import { appRuntime } from '../src/main/runtime';
import { governmentInfoPlugin } from '../src/plugins/government-info';

// Real production IPC + preload + renderer + matter definitions, with an isolated profile.
// No actual license, credentials, business database or remote business API is accessed.
let main: BrowserWindow | undefined;
let directory = '';
const dom = (script: string) => main!.webContents.executeJavaScript(script);
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

async function run() {
  directory = await mkdtemp(join(tmpdir(), 'fusion-government-menu-smoke-'));
  app.setPath('userData', directory);
  await app.whenReady();
  const session = { status: 'logged-out' as const, systemId: 'government-info' };
  appRuntime.plugins.register({ ...governmentInfoPlugin, getSessionState: async () => session,
    auth: { ...governmentInfoPlugin.auth, getState: async () => session } });
  const grant = { allowedSystems: ['government-info'], expiresAt: Date.now() + 86_400_000 };
  Object.assign(appRuntime, {
    license: { getStatus: async () => ({ state: 'active', deviceId: 'fixture', grant }) },
    requireLicense: async () => grant, currentGrant: async () => grant,
    getSettings: async () => ({ autoCheckUpdates: false }),
    listLocalRecords: async () => ({ rows: [], total: 0 }),
  });
  main = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { preload: resolve('out/preload/index.js'), contextIsolation: true, sandbox: true } });
  registerIpcHandlers(() => main?.webContents.id);
  await main.loadFile(resolve('out/renderer/index.html'));
  await until(() => dom('document.querySelectorAll(".system-nav-toggle").length === 1'), 'system menu');
  const menu = await dom('window.desktopApi.matters.list("government-info")');
  assert.equal(menu.length, 18);
  assert.equal(menu.some((matter: Record<string, unknown>) => 'mergeRecord' in matter), false);
  await dom('document.querySelector(".system-nav-toggle").click()');
  await until(() => dom('document.querySelectorAll(".department-nav-title").length === 3'), 'three departments');
  for (const [index, expected] of [8, 2, 8].entries()) {
    await dom(`document.querySelectorAll('.department-nav-title')[${index}].click()`);
    await until(() => dom(`document.querySelectorAll('.department-nav-group')[${index}].querySelectorAll('.matter-subnav button').length === ${expected}`), `department ${index} expanded`);
    await dom(`document.querySelectorAll('.department-nav-title')[${index}].click()`);
    await until(() => dom(`document.querySelectorAll('.department-nav-group')[${index}].querySelectorAll('.matter-subnav button').length === 0`), `department ${index} collapsed`);
  }
  await dom('document.querySelectorAll(".department-nav-title")[2].click()');
  await until(() => dom('document.querySelectorAll(".matter-subnav button").length === 8'), 'other matters');
  await dom('document.querySelectorAll(".matter-subnav button")[7].click()');
  await until(() => dom('document.querySelector(".one-click-copy")?.textContent.includes("不表示完整双公示")'), 'partial certificate matter selected');
  assert.equal(await dom('document.querySelector(".one-click-copy h2").textContent'), '注销第三类非药品类易制毒化学品经营备案');
  assert.equal(await dom('document.body.innerText.includes("An object could not be cloned")'), false);
  const dateLabels = await dom('[...document.querySelectorAll(".return-date-fields label")].map(item => item.textContent.trim())');
  assert(dateLabels.some((label: string) => label.includes('办结开始日期')));
  assert(dateLabels.some((label: string) => label.includes('办结截止日期')));
  assert(!dateLabels.some((label: string) => label.includes('回流开始日期') || label.includes('许可决定截止日期')));
  console.log('PASS: production IPC returns 18 government matters; departments 8/2/8 expand/collapse; partial certificate matter opens.');
}

async function finish(code: number) {
  main?.destroy();
  if (directory && dirname(resolve(directory)) === resolve(tmpdir())
    && directory.startsWith(join(tmpdir(), 'fusion-government-menu-smoke-'))) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  app.exit(code);
}
void run().then(() => finish(0)).catch((error) => { console.error(error); return finish(1); });
