import { app, BrowserWindow, ipcMain } from 'electron';
import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createGuangdongHrssPlugin } from '../src/plugins/guangdong-hrss';
import { HRSS_MATTER_DEFINITIONS } from '../src/plugins/guangdong-hrss/catalog';
import { buildHrssDashboard } from '../src/core/hrss/dashboard';
import { HrssDashboardWindow } from '../src/main/hrss-dashboard-window';
import { hrssReturnDateDetails } from '../src/core/hrss/date-filters';

// Isolated UI fixtures: no real login, credentials, source requests, license or user database.
assert(process.env.DATA_FUSION_UI_TEST_PROFILE, 'Use the isolated UI runner');
app.setPath('userData', process.env.DATA_FUSION_UI_TEST_PROFILE!);
app.on('window-all-closed', () => {});
const output = resolve('.tmp', 'hrss-ui-' + Date.now());
const assets = { preload: resolve('.tmp/ui-redesign-preload.cjs'), renderer: resolve('out/renderer/index.html') };
const dashboard = new HrssDashboardWindow(assets);
const plugin = createGuangdongHrssPlugin();
const now = Date.now(), systemId = plugin.id, invocations: { method: string; args: any[] }[] = [], errors: string[] = [];
let window: BrowserWindow;
const grant = { licenseId: 'hrss-ui-fixture', customerName: '人社界面隔离测试', expiresAt: now + 86400000,
  allowedSystems: [systemId], allowExport: true, allowAutoUpdate: false };
const data = { recordKey: 'synthetic-hash', slbh: 'UI-DEMO-001', name: '张示例', cardNumber: '440305199901011234',
  applyDate: '2026-11-01', employmentStatus: '失业', phone: '13800001234', address: '演示地址' };
const row = { systemId, matterId: 'unemployment', recordKey: 'synthetic-key', data, firstSeenAt: now, updatedAt: now };
const pendingRow = { systemId, matterId: 'job-seeking-startup-subsidy', recordKey: 'synthetic-pending-key', firstSeenAt: now, updatedAt: now,
  data: { applyBh: 'DATE-CONTROL-DEMO', unitName: '合成测试单位', applyDate: '2026-01-01', currentLink: '待审核' } };
const tasks: any[] = [{ id: 'hrss-demo-completed', type: 'data-return', name: '失业信息列表回流', systemId,
  matterId: 'unemployment', status: 'completed', progress: { current: 1, total: 1, message: '列表回流完成' },
  createdAt: now - 1000, finishedAt: now - 500, details: { startDate: '2026-11-01', endDate: '2026-11-04' } }];
const previewSubsidies = [
  ['job-seeking-startup-subsidy', 13], ['graduate-flexible-employment-subsidy', 20],
  ['difficult-flexible-employment-subsidy', 45], ['one-time-job-expansion-subsidy', 8],
  ['one-time-startup-subsidy', 28], ['startup-rent-subsidy', 32],
  ['startup-employment-subsidy', 19], ['employment-internship-subsidy', 12],
  ['greater-bay-youth-living-subsidy', 16],
] as const;
const previewStreets = ['南山街道', '粤海街道', '南头街道', '西丽街道', '桃源街道', '沙河街道', '招商街道', '蛇口街道'];
const dashboardPreviewRecords = previewSubsidies.flatMap(([matterId, count], matterIndex) => Array.from({ length: count }, (_, index) => ({
  systemId, matterId, recordKey: `preview-${matterIndex}-${index}`,
  data: { applyDate: `2026-${String(1 + (index * 7 + matterIndex * 2) % 10).padStart(2, '0')}-${String(1 + index % 25).padStart(2, '0')}`,
    applyAddress: previewStreets[(index + matterIndex) % previewStreets.length], applyChannel: index % 5 ? '网站申请' : '窗口申请',
    payStatus: index % 7 < 4 ? '支付成功' : index % 7 < 6 ? '待支付' : '', currentLink: index % 7 < 4 ? '办理成功' : '待支付' },
})));
const dashboardPreviewTasks = previewSubsidies.map(([matterId]) => ({ matterId, type: 'data-return', status: 'completed' as const, createdAt: now - 3_000, finishedAt: now - 2_000 }));
const publicMatter = () => plugin.matters.map(matter => ({ id: matter.id, name: matter.name, departmentId: matter.departmentId,
  departmentName: matter.departmentName, departmentOrder: matter.departmentOrder, matterOrder: matter.matterOrder,
  listColumns: matter.listColumns, querySchema: matter.querySchema, uniqueKey: matter.uniqueKey, dateFilter: matter.dateFilter,
  executionMode: matter.executionMode, defaultFilters: matter.createDefaultContext?.().filters, description: matter.description }));
const component = { id: systemId, name: plugin.name, version: plugin.version, description: plugin.description,
  workspaceMode: plugin.workspaceMode, kind: 'system', authorized: true };

ipcMain.handle('ui-redesign:invoke', async (_event, method: string, ...args: any[]) => {
  invocations.push({ method, args });
  switch (method) {
    case 'license.status': return { state: 'active', grant, deviceId: 'ui-fixture' };
    case 'components.list': return [component];
    case 'systems.list': return [{ ...component, session: { systemId, status: 'authenticated' } }];
    case 'systems.tabs': case 'systems.activateTab': return { tabs: [], activeSystemId: null };
    case 'systems.session': return { systemId, status: 'authenticated' };
    case 'matters.list': return publicMatter();
    case 'records.list': assert.equal(args[0].systemId, systemId); return { rows: args[0].matterId === 'unemployment' ? [row] : args[0].matterId === pendingRow.matterId ? [pendingRow] : [], total: ['unemployment', pendingRow.matterId].includes(args[0].matterId) ? 1 : 0 };
    case 'tasks.list': return tasks;
    case 'tasks.page': {
      const scope = args[0];
      const archived = Array.from({ length: 55 }, (_, index) => ({ ...tasks[0], id: 'hrss-archived-' + (index + 1), createdAt: now - (index + 1) * 86400000 }));
      const rows = [...tasks, ...archived].filter(task => task.systemId === scope.systemId && task.matterId === scope.matterId &&
        (!scope.completedBatches || task.status === 'completed') && (!scope.taskId || task.id === scope.taskId));
      const offset = ((scope.page ?? 1) - 1) * (scope.pageSize ?? 20);
      return { rows: rows.slice(offset, offset + (scope.pageSize ?? 20)), total: rows.length };
    }
    case 'tasks.output': return { rows: [{ ...(args[0] === 'hrss-demo-pending' ? pendingRow : row), rowNo: 1 }], total: 1 };
    case 'tasks.exportOutput': case 'records.export': return { path: join(output, '业务台账-失业信息-2026-11-01至2026-11-04.xlsx'), rowCount: 1, warningCount: 0 };
    case 'exports.openFolder': return true;
    case 'updates.state': return { status: 'up-to-date', currentVersion: '1.0.18', automatic: false, installMode: 'manual' };
    case 'matters.run': {
      assert.equal(args[0], systemId);
      if (args[1] === pendingRow.matterId) {
        const details = hrssReturnDateDetails(args[1], args[2].filters);
        tasks.push({ ...tasks[0], id: 'hrss-demo-pending', matterId: pendingRow.matterId, details, name: '日期条件预留测试' });
        return { taskId: 'hrss-demo-pending', total: 1 };
      }
      assert.equal(args[1], 'unemployment'); return { taskId: tasks[0].id, total: 1 };
    }
    case 'hrss.dashboard': return buildHrssDashboard({ allowedMatterIds: HRSS_MATTER_DEFINITIONS.map(matter => matter.id), records: [row, ...dashboardPreviewRecords], tasks: [...tasks, ...dashboardPreviewTasks], now });
    case 'hrss.openDashboard': dashboard.open(); return;
    case 'hrss.closeDashboard': dashboard.close(); return;
    case 'diagnostics.report': errors.push(String(args[2])); return true;
    default: throw new Error('Unexpected UI invocation: ' + method);
  }
});

const evaluate = <T>(code: string, target = window) => target.webContents.executeJavaScript(code) as Promise<T>;
async function waitFor(code: string, target = window) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { if (await evaluate<boolean>(code, target)) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error('UI condition timed out: ' + code);
}
async function clickText(text: string, target = window) {
  assert(await evaluate<boolean>(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`, target), 'Button missing: ' + text);
}
async function capture(name: string, target = window) {
  const wasVisible = target.isVisible();
  if (!wasVisible) target.showInactive();
  await new Promise(resolve => setTimeout(resolve, 250));
  const client = target.webContents.debugger;
  if (!client.isAttached()) client.attach('1.3');
  const result = await client.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: false, captureBeyondViewport: false });
  await writeFile(join(output, name + '.png'), Buffer.from(result.data, 'base64'));
  if (!wasVisible) target.hide();
}
async function selectMatter(id: string) {
  await evaluate(`(()=>{const s=document.querySelector('.return-matter-field select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(id)});s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('.return-matter-field select')?.value === ${JSON.stringify(id)}`);
}

void app.whenReady().then(async () => {
  await mkdir(output, { recursive: true });
  window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { preload: assets.preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  await window.loadFile(assets.renderer);
  await waitFor("Boolean(document.querySelector('.system-nav-toggle'))");
  await evaluate(`document.querySelector('.system-nav-toggle').click()`);
  await waitFor("Boolean(document.querySelector('.one-click-panel'))");
  assert.equal(await evaluate("document.querySelectorAll('.return-date-fields input').length"), 2);
  assert.equal(await evaluate("document.querySelector('.return-matter-field select').options.length"), 18);
  for (const matter of plugin.matters) {
    await selectMatter(matter.id);
    assert.equal(await evaluate("document.querySelectorAll('.return-date-fields input[type=date]').length"), 2);
    const expected = matter.id === 'unemployment' ? '日期筛选已生效' : '日期筛选待接入';
    assert.equal(await evaluate("document.querySelector('.hrss-date-condition strong').textContent"), expected);
  }
  await selectMatter(pendingRow.matterId);
  await evaluate(`(()=>{const inputs=document.querySelectorAll('.return-date-fields input');for(const [i,value] of ['2026-10-01','2026-10-31'].entries()){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inputs[i],value);inputs[i].dispatchEvent(new Event('input',{bubbles:true}));inputs[i].dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await capture('00-pending-date-controls');
  await clickText('开始数据回流'); await waitFor("Boolean(document.querySelector('.task-table-panel'))");
  await waitFor("document.querySelector('.task-table-panel').innerText.includes('日期筛选待接入')");
  const pendingDetails = tasks.find(task => task.id === 'hrss-demo-pending').details;
  assert.equal(pendingDetails.requestedStartDate, '2026-10-01'); assert.equal(pendingDetails.requestedEndDate, '2026-10-31');
  assert(!('startDate' in pendingDetails) && !('endDate' in pendingDetails));
  await clickText('在回流数据中查看'); await waitFor("Boolean(document.querySelector('.hrss-ledger > .hrss-date-condition.pending'))");
  await capture('00-pending-date-batch');
  await clickText('数据回流'); await selectMatter('unemployment');
  assert(!await evaluate("document.querySelector('.content').innerText.includes('双公示')"));
  await capture('01-list-return');
  await clickText('回流数据'); await waitFor("Boolean(document.querySelector('.hrss-list-table tbody tr')) && !document.querySelector('.hrss-list-table').getAttribute('aria-busy').includes('true')");
  assert(!await evaluate("document.querySelector('.hrss-ledger').innerText.includes('张示例')"), 'Name must be masked');
  assert(!await evaluate("document.querySelector('.hrss-ledger').innerText.includes('440305199901011234')"), 'ID must be masked');
  assert(!await evaluate("document.querySelector('.hrss-ledger').innerText.includes('13800001234')"), 'Phone must be masked');
  await capture('02-local-ledger');
  await clickText('导出台账'); await waitFor("Boolean(document.querySelector('.export-notice-path'))");
  await evaluate("document.querySelector('.export-notice-path').click()");
  await waitFor("!document.querySelector('.export-notice-path').disabled");
  assert(invocations.some(call => call.method === 'exports.openFolder'));
  await clickText('全屏数据看板');
  let fullWindow: BrowserWindow | undefined;
  for (let index = 0; index < 100 && !fullWindow; index++) { fullWindow = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.id === dashboard.contentsId()); if (!fullWindow) await new Promise(resolve => setTimeout(resolve, 80)); }
  assert(fullWindow); await waitFor("Boolean(document.querySelector('.hrss-dashboard'))", fullWindow);
  assert(fullWindow.isFullScreen());
  await capture('03-fullscreen-dashboard', fullWindow);
  await clickText('就业服务与台账', fullWindow);
  await waitFor("document.querySelector('.hrss-header h1')?.textContent === '公共就业服务'", fullWindow);
  await capture('03b-service-dashboard', fullWindow);
  await clickText('补贴总览', fullWindow);
  await waitFor("document.querySelector('.hrss-header h1')?.textContent === '就业创业补贴'", fullWindow);
  fullWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  for (let i = 0; i < 100 && dashboard.contentsId(); i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(dashboard.contentsId(), undefined, 'Escape must close the separate fullscreen window');
  assert(!window.isDestroyed(), 'The workbench must remain open');
  await clickText('数据回流'); await clickText('开始数据回流');
  await waitFor("Boolean(document.querySelector('.task-table-panel'))");
  assert(invocations.some(call => call.method === 'matters.run'));
  assert(!invocations.some(call => /detail|enterprise|matters.query/.test(call.method)));
  await clickText('在回流数据中查看'); await waitFor("Boolean(document.querySelector('.hrss-ledger'))");
  await waitFor("Boolean(document.querySelector('.hrss-ledger-filters select option[value=\"hrss-demo-completed\"]'))");
  await capture('04-batch-snapshot');
  const batchSelect = 'document.querySelector(".hrss-ledger-filters select")';
  const selectBatch = async (id: string) => evaluate(`(()=>{const s=${batchSelect};s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await selectBatch('@older');
  await waitFor(`Boolean(${batchSelect}.querySelector('option[value="hrss-archived-55"]'))`);
  assert.equal(await evaluate(batchSelect + '.value'), 'hrss-demo-completed', 'Paging batch choices preserves the selected batch');
  await selectBatch('hrss-archived-55');
  await waitFor(`${batchSelect}.value === "hrss-archived-55" && !document.querySelector('.hrss-list-table').getAttribute('aria-busy').includes('true')`);
  assert(invocations.some(call => call.method === 'tasks.output' && call.args[0] === 'hrss-archived-55'));
  await selectBatch('@newer');
  await waitFor(`Boolean(${batchSelect}.querySelector('option[value="@older"]'))`);
  assert.equal(await evaluate(batchSelect + '.value'), 'hrss-archived-55', 'An older selected batch remains pinned when reading a newer page');
  window.setContentSize(1180, 780); await capture('05-small-workbench');
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed: true, matterCount: 18, dateControls: 18, pendingDateFilters: 17, checks: ['list-only-metadata', 'date-schema', 'pending-date-status', 'pending-batch-not-effective-range', 'masked-ledger', 'managed-export-folder', 'native-fullscreen', 'escape-preserves-workbench', 'return-task', 'batch-snapshot'], invocationCount: invocations.length }, null, 2));
  console.log('PASS: HRSS local UI integration; evidence: ' + output);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
