import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createShenzhenHazardousPlugin } from '../src/plugins/shenzhen-hazardous-chemicals';
import { HAZCHEM_AUTHORITY_CODE, HAZCHEM_SYSTEM_ID } from '../src/plugins/shenzhen-hazardous-chemicals/catalog';
import { publicationPlatform, publicationPlatformsForSystem } from '../src/core/publication/platforms';

// Real renderer and plugin metadata, synthetic business data, no source requests,
// no real session, license, credentials or application database.
assert(process.env.DATA_FUSION_UI_TEST_PROFILE, 'Use the isolated UI runner');
app.setPath('userData', process.env.DATA_FUSION_UI_TEST_PROFILE!);
app.on('window-all-closed', () => {});
const output = resolve('.tmp', 'hazardous-ui-' + Date.now());
const plugin = createShenzhenHazardousPlugin();
const now = Date.now();
const invocations: { method: string; args: any[] }[] = [];
const errors: string[] = [], blocked: string[] = [];
const captures: { name: string; width: number; height: number }[] = [];
let window: BrowserWindow;
let authorized = true;
const component = { id: plugin.id, name: plugin.name, version: plugin.version, description: plugin.description,
  kind: 'system', workspaceMode: plugin.workspaceMode, supportsCredentialConfiguration: true, authorized: true };
const otherComponent = { id: 'market-access', name: '广东省市场准入系统', version: '1.0.0', kind: 'system', workspaceMode: 'standard', authorized: true };
const grant = () => ({ licenseId: 'hazardous-isolated-ui', expiresAt: now + 86400000,
  allowedSystems: authorized ? [plugin.id] : ['market-access'], allowedMatters: authorized ? { [plugin.id]: plugin.matters.map(matter => matter.id) } : {},
  allowExport: true, allowAutoUpdate: false });
const data = { xkXdrMc: '演示危化品企业', xkXdrLb: '法人及非法人组织', xkXdrShxym: '91440300123456789Q', xkFrdb: '演示法人',
  xkXkws: '行政许可决定书', xkWsh: '演示许可〔2026〕001号', xkXklb: '普通', xkXkzs: '危险化学品经营许可证', xkXkbh: '演示证号001',
  xkNr: '仅供界面回归的演示许可范围', xkJdrq: '2026-11-15', xkYxqz: '2026-11-15', xkYxqzi: '2029-11-14',
  xkZt: '1', xkXkjg: '深圳市南山区应急管理局', xkXkjgdm: HAZCHEM_AUTHORITY_CODE,
  xkLydw: '深圳市南山区应急管理局', xkLydwdm: HAZCHEM_AUTHORITY_CODE, ajmc: '演示危险化学品经营许可案件', xkZqly: '依职权', xkCljg: '予以许可' };
const row = (matterId: string) => ({ systemId: plugin.id, matterId, recordKey: 'synthetic-serial-1', data, firstSeenAt: now, updatedAt: now });
const publicMatters = () => plugin.matters.map(({ query, createDefaultContext, mergeRecord, ...matter }) => ({ ...matter, defaultFilters: createDefaultContext?.().filters }));

ipcMain.handle('ui-redesign:invoke', async (_event, method: string, ...args: any[]) => {
  invocations.push({ method, args });
  switch (method) {
    case 'license.status': case 'license.refresh': return { state: 'active', deviceId: 'synthetic-ui-device', grant: grant() };
    // Deliberately return the unauthorized component as well, so the renderer's
    // own grant filtering is exercised independently of production IPC checks.
    case 'components.list': return [component, otherComponent];
    case 'systems.list': return [component, otherComponent].map(value => ({ ...value, session: { systemId: value.id, status: 'authenticated' } }));
    case 'systems.session': return { systemId: args[0], status: 'authenticated' };
    case 'systems.tabs': case 'systems.activateTab': return { tabs: [], activeSystemId: null };
    case 'matters.list': return args[0] === plugin.id && authorized ? publicMatters() : [];
    case 'tasks.list': return [];
    case 'records.list': {
      assert.equal(args[0].systemId, plugin.id);
      const first = row(args[0].matterId);
      return { rows: [first, { ...first, recordKey: 'synthetic-incomplete', data: { ...data, xkXdrMc: '演示待补充企业', xkNr: '' } }], total: 2 };
    }
    case 'records.versions': return [];
    case 'records.export': {
      assert.equal(args[0].systemId, plugin.id); assert.equal(args[1], 'xlsx');
      assert(['nanshan', 'guangdong-law'].includes(args[2]));
      return { path: join(output, `行政许可-${args[2]}-危险化学品经营许可证核发（新领）-全部日期.xlsx`), rowCount: 2, warningCount: 1, missingRequiredCount: 1 };
    }
    case 'exports.openFolder': return true;
    case 'publications.open': {
      const platform = publicationPlatform(args[0]); assert(platform); assert.equal(platform.ownerSystemId, plugin.id);
      return { tabs: [], activeSystemId: null };
    }
    case 'updates.state': return { status: 'up-to-date', currentVersion: '1.0.24', automatic: false, installMode: 'manual' };
    case 'settings.get': return { autoCheckUpdates: false, defaultPageSize: 50 };
    case 'diagnostics.report': if (args[0] === 'error') errors.push(String(args[2])); return true;
    default: throw new Error('Unexpected isolated hazardous UI invocation: ' + method);
  }
});

const evaluate = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
async function until(code: string) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await evaluate<boolean>(code)) return; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error('UI condition timed out: ' + code);
}
async function clickText(text: string) {
  assert(await evaluate<boolean>(`(()=>{const button=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(text)}&&node.getBoundingClientRect().width>0);if(!button||button.disabled)return false;button.click();return true;})()`), 'Missing button: ' + text);
}
async function capture(name: string, width: number, height: number) {
  window.setContentSize(width, height); window.showInactive();
  await new Promise(resolve => setTimeout(resolve, 250));
  const metrics = await evaluate<{ width: number; scroll: number; outside: string[] }>(`(()=>{const width=document.documentElement.clientWidth;return {width,scroll:document.documentElement.scrollWidth,outside:[...document.querySelectorAll('.publication-actions button,.return-date-fields input,.return-matter-field select')].filter(node=>{const r=node.getBoundingClientRect();return r.width&&(r.left<0||r.right>width+1)}).map(node=>node.textContent||node.tagName)};})()`);
  assert(metrics.scroll <= metrics.width + 1, `Viewport overflow: ${JSON.stringify(metrics)}`);
  assert.deepEqual(metrics.outside, [], 'Main controls must stay within the viewport');
  const client = window.webContents.debugger; if (!client.isAttached()) client.attach('1.3');
  const result = await client.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: false, captureBeyondViewport: false });
  await writeFile(join(output, name + '.png'), Buffer.from(result.data, 'base64')); window.hide(); captures.push({ name, width, height });
}

void app.whenReady().then(async () => {
  await mkdir(output, { recursive: true });
  window = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { preload: resolve('.tmp/ui-redesign-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { blocked.push(details.url); callback({ cancel: true }); });
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await window.loadFile(resolve('out/renderer/index.html'));
  await until(`document.querySelectorAll('.system-nav-toggle').length===1`);
  assert.equal(await evaluate(`document.querySelector('.system-nav-toggle').innerText.includes('危化品管理')`), true);
  assert.equal(await evaluate(`document.querySelector('.sidebar').innerText.includes('市场准入')`), false);
  await evaluate(`document.querySelector('.system-nav-toggle').click()`);
  await until(`Boolean(document.querySelector('.one-click-panel'))`);
  assert.equal(await evaluate(`document.querySelector('.return-matter-field select').options.length`), 5);
  assert.equal(await evaluate(`document.querySelectorAll('.return-date-fields input[type=date]').length`), 2);
  for (const matter of plugin.matters) {
    await evaluate(`(()=>{const select=document.querySelector('.return-matter-field select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(matter.id)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(`document.querySelector('.one-click-copy h2')?.textContent===${JSON.stringify(matter.name)}`);
  }
  const first = plugin.matters[0];
  await evaluate(`(()=>{const select=document.querySelector('.return-matter-field select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(first.id)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(`document.querySelector('.one-click-copy h2')?.textContent===${JSON.stringify(first.name)}`);
  for (const [width, height] of [[1440, 900], [1180, 780]]) await capture(`return-${width}`, width, height);
  await clickText('回流数据'); await until(`document.querySelectorAll('.record-table-panel tbody tr').length===2`);
  assert.equal(await evaluate(`document.querySelectorAll('.record-row-warning').length`), 1);
  for (const [width, height] of [[1440, 900], [1180, 780]]) await capture(`exports-${width}`, width, height);
  for (const label of ['导出省执法双公示', '导出南山双公示']) { await clickText(label); await until(`Boolean(document.querySelector('.export-notice-path'))`); }
  const exports = invocations.filter(call => call.method === 'records.export');
  assert.deepEqual(exports.map(call => call.args[2]), ['guangdong-law', 'nanshan']);
  for (const platform of publicationPlatformsForSystem(HAZCHEM_SYSTEM_ID)) { await clickText(platform.buttonLabel); await until(`!document.querySelector('.publication-actions button[aria-busy=true]')`); }
  assert.deepEqual(invocations.filter(call => call.method === 'publications.open').map(call => call.args[0]), ['hazchem-nanshan-publicity', 'hazchem-guangdong-law-publicity']);
  await clickText('查看修改'); await until(`Boolean(document.querySelector('.record-drawer'))`);
  assert.equal(await evaluate(`document.querySelector('.record-drawer').innerText.includes(${JSON.stringify(HAZCHEM_AUTHORITY_CODE)})`), true);
  await clickText('关闭');
  authorized = false; await window.reload();
  await until(`document.querySelectorAll('.system-nav-toggle').length===1`);
  assert.equal(await evaluate(`document.querySelector('.system-nav-toggle').innerText.includes('市场准入')`), true);
  assert.equal(await evaluate(`document.body.innerText.includes('危化品管理')`), false);
  await capture('unlicensed-hidden-1180', 1180, 780);
  assert.deepEqual(blocked, [], 'Renderer must not make any source or backend network request');
  assert.deepEqual(errors, [], 'No renderer errors');
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed: true, systemId: plugin.id, matterCount: 5, captures,
    checks: ['grant-filtered-navigation', 'five-matters', 'date-controls', 'two-publication-exports', 'missing-row-warning', 'fixed-authority-code', 'source-bound-publication-tabs', 'unlicensed-hidden'], invocationCount: invocations.length }, null, 2));
  console.log('PASS: hazardous chemicals isolated UI; evidence: ' + output); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
