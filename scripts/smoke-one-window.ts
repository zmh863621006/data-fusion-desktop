import assert from 'node:assert/strict';
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { IPC_CHANNELS as IPC } from '../src/core/ipc/channels';
import { createOneWindowPlugin } from '../src/plugins/shenzhen-one-window';
import { DEFAULT_ONE_WINDOW_SCHEDULE } from '../src/core/one-window/scheduler';
import type { OneWindowBatch, OneWindowPlan } from '../src/core/one-window/types';

// Real renderer/preload with synthetic IPC data and an isolated profile. No source or OSS requests.
async function main() {
app.disableHardwareAcceleration();
const root = resolve('.tmp/one-window-ui');
await mkdir(root, { recursive: true });
const output = await mkdtemp(resolve(root, 'run-'));
app.setPath('userData', resolve(output, 'profile'));
app.on('window-all-closed', () => {});
const plugin = createOneWindowPlugin();
const plans = new Map<string, OneWindowPlan>();
const session = { systemId: plugin.id, status: 'authenticated' };
const now = Date.now();
const grant = { licenseId: 'one-window-ui-fixture', customerName: '界面测试', expiresAt: now + 86_400_000,
  allowedSystems: [plugin.id], allowedMatters: { [plugin.id]: plugin.matters.map(matter => matter.id) },
  allowExport: true, allowAutoSync: true, allowAutoUpdate: false };
const plan = (matterId: string) => plans.get(matterId) ?? { matterId, schedule: structuredClone(DEFAULT_ONE_WINDOW_SCHEDULE),
  filters: { dateType: 'all', startDate: '', endDate: '', state: '' }, nextRunAt: null, lastRunAt: null };
const row = { bsnum: 'SYNTHETIC-CASE-001', receiveNumber: '测试受理001', applicant: '界面示例企业',
  matterName: plugin.matters[0].name, creditCode: 'SYNTHETIC-CODE', legalPerson: '示例负责人', organizationName: '示例部门',
  statusLabel: '已办结', receivedAt: '2026-11-24', detailStatus: 'complete', sourceList: { BSNUM: 'SYNTHETIC-CASE-001' },
  details: { base: { status: 'complete', data: { fields: [{ key: 'company', label: '组织机构名称', value: '界面示例企业' }] } },
    form: { status: 'complete', data: { data: { EntName: '界面示例企业', XingShiCaiZhiJiGuiGe: [{ code0: '灯箱', code4: 12 }] },
      fields: [{ key: 'EntName', label: '单位名称' }, { key: 'XingShiCaiZhiJiGuiGe', label: '形式、材质及规格' }] } } } };
const taskId = '12345678-1234-1234-1234-123456789012';
let batch: OneWindowBatch | null = null;
let uploaded = false;
const calls: string[] = [];
for (const channel of Object.values(IPC)) ipcMain.handle(channel, async (_event, ...args) => {
  calls.push(channel);
  switch (channel) {
    case IPC.licenseStatus: return { state: 'active', deviceId: 'fixture-device', grant };
    case IPC.modulesList: case IPC.componentsList: return [{ ...plugin, matters: undefined, auth: undefined,
      initialize: undefined, getSessionState: undefined, sessionRecovery: undefined, loginPage: undefined, kind: 'system', authorized: true }];
    case IPC.systemsList: return [{ id: plugin.id, name: plugin.name, version: plugin.version, workspaceMode: plugin.workspaceMode, session }];
    case IPC.systemSession: return session;
    case IPC.systemTabs: case IPC.systemTabActivate: return { tabs: [], activeSystemId: null };
    case IPC.mattersList: return plugin.matters.map(({ query, mergeRecord, createDefaultContext, ...matter }) => ({ ...matter, defaultFilters: createDefaultContext?.().filters }));
    case IPC.settingsGet: return { locale: 'zh-CN', autoCheckUpdates: false, defaultPageSize: 20, taskConcurrency: 2, retainAuditDays: 180 };
    case IPC.updatesState: return { status: 'up-to-date', currentVersion: '1.1.10', automatic: true, message: '当前已是最新版本' };
    case IPC.tasksList: return [];
    case IPC.tasksPage: return { rows: [], total: 0 };
    case IPC.oneWindowState: return { plan: plan(args[0]), running: false, sessionStatus: 'authenticated',
      batches: batch && batch.matterId === args[0] ? [batch] : [], batchTotal: batch?.matterId === args[0] ? 1 : 0 };
    case IPC.oneWindowSavePlan: plans.set(args[0], { ...plan(args[0]), ...args[1] }); return plans.get(args[0]);
    case IPC.oneWindowRecords: return { rows: batch && batch.matterId === args[0] ? [{ recordKey: taskId, data: row }] : [], total: batch?.matterId === args[0] ? 1 : 0 };
    case IPC.oneWindowRun:
      batch = { taskId, matterId: args[0], createdAt: now, total: 1, partialCount: 0, fileName: '界面测试.xlsx', filePath: 'fixture-only.xlsx',
        uploadStatus: 'failed', uploadError: '界面测试推送失败', uploadedAt: null, objectKey: null };
      return { id: taskId, status: 'completed', result: { total: 1, uploadStatus: 'failed' } };
    case IPC.oneWindowRetry: assert.equal(args[0], taskId); batch!.uploadStatus = 'uploaded'; batch!.uploadError = null; uploaded = true; return batch;
    case IPC.oneWindowFolder: return;
    case IPC.backendStatus: return { origin: 'https://fixture.invalid', connected: true };
    case IPC.auditList: return [];
    case IPC.diagnosticsReport: throw new Error('Unexpected renderer error');
    default: throw new Error('Unexpected fixture IPC ' + channel);
  }
});
await app.whenReady();
const window = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: {
  preload: resolve('out/preload/index.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
} });
const errors: string[] = [];
window.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
const dom = (expression: string) => window.webContents.executeJavaScript(expression);
async function capture() {
  window.showInactive();
  await new Promise(resolve => setTimeout(resolve, 250));
  const debuggerClient = window.webContents.debugger;
  if (!debuggerClient.isAttached()) debuggerClient.attach('1.3');
  try {
    const result = await debuggerClient.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: false });
    return Buffer.from(result.data, 'base64');
  } finally { window.hide(); }
}
async function until(expression: string) {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (await dom(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('UI condition timed out: ' + expression);
}
async function click(text: string, selector = 'main button') {
  await until(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(button=>button.textContent.trim()===${JSON.stringify(text)} && !button.disabled)`);
  await dom(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(button=>button.textContent.trim()===${JSON.stringify(text)}).click()`);
}
try {
  await window.loadFile(resolve('out/renderer/index.html'));
  await click('一窗受理平台', '.system-card-title');
  await until('Boolean(document.querySelector(".one-window-page"))');
  await until('!document.querySelector(".one-window-controls .primary").disabled');
  await dom('document.querySelector(".one-window-toggles input").click()');
  await dom('(() => {const input=document.querySelectorAll(".one-window-form select")[2]; input.value="weekly";input.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await until('Boolean(document.querySelector(".one-window-weekdays"))');
  await click('保存设置');
  await until('document.querySelector(".one-window-page").textContent.includes("设置已保存")');
  assert.equal(plans.get(plugin.matters[0].id)?.schedule.mode, 'weekly');
  assert.equal(plans.get(plugin.matters[0].id)?.schedule.loginAutoRun, true);
  await writeFile(resolve(output, 'return.png'), await capture());
  await click('立即回流并推送');
  await until('document.querySelector(".one-window-page").textContent.includes("推送失败")');
  await click('重新推送');
  await until('document.querySelector(".one-window-page").textContent.includes("已推送至后台")');
  assert(uploaded);
  await click('查看数据');
  await until('document.querySelector(".one-window-data").textContent.includes("界面示例企业")');
  await click('查看详情');
  await until('document.querySelector(".one-window-detail").textContent.includes("形式、材质及规格")');
  await writeFile(resolve(output, 'details.png'), await capture());
  await click('关闭', '.one-window-detail button');
  await window.setContentSize(980, 850);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await dom('document.documentElement.scrollWidth <= window.innerWidth + 1'), true, 'Compact layout must keep table scrolling inside its panel');
  await writeFile(resolve(output, 'data-compact.png'), await capture());
  await click('一窗受理平台', '.sidebar .system-nav-toggle');
  await until('Boolean(document.querySelector(".department-nav-title"))');
  await dom('document.querySelector(".department-nav-title").click()');
  await click(plugin.matters[1].name, '.sidebar button');
  await until('Boolean(document.querySelector(".one-window-controls h2")?.textContent.includes("门楣"))');
  await until('!document.querySelector(".one-window-toggles input").checked');
  assert.equal(plans.has(plugin.matters[1].id), false);
  await click('设置', '.sidebar button');
  await until('Boolean(document.querySelector(".update-settings"))');
  assert.equal(await dom('document.querySelector("main").textContent.includes("定时回流")'), false);
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ passed: true, output, calls: calls.length,
    systemSettingsOnly: true, independentMatterPlans: true, detailDrawer: true, uploadRetry: true }, null, 2));
  console.log(JSON.stringify({ passed: true, output }));
  app.exit(0);
} catch (error) {
  await writeFile(resolve(output, 'failure.txt'), String(error));
  await writeFile(resolve(output, 'failure.html'), await dom('document.documentElement.outerHTML'));
  await capture().then(bytes => writeFile(resolve(output, 'failure.png'), bytes)).catch(() => {});
  console.error(error);
  console.log(JSON.stringify({ output, errors }));
  app.exit(1);
}
}
void main().catch(error => { console.error(error); app.exit(1); });
