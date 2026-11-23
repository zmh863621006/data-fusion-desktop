import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { DOUBLE_PUBLICITY_TEMPLATE } from '../src/core/double-publicity/template';
import { parseSettingsPatch } from '../src/core/ipc/validation';
import type { UpdatePresentationState } from '../src/renderer/src/UpdateStatus';
import { PUBLICATION_PLATFORMS, publicationPlatform } from '../src/core/publication/platforms';
import { createSpecialEquipmentPlugin } from '../src/plugins/guangdong-special-equipment';
import { PERSONNEL_ASSESSMENT, USE_REGISTRATION } from '../src/plugins/guangdong-special-equipment/catalog';
import { createFoodDrugPlugin } from '../src/plugins/guangdong-food-drug';
import { FOOD_PRODUCTION, MEDICAL_DEVICE_OPERATION } from '../src/plugins/guangdong-food-drug/catalog';

// UI-only regression: a fresh profile, an in-memory fixture, no app runtime or
// SQLite imports, no real credentials, and all network traffic blocked.
const ids = ['government-info', 'market-access', 'transport-practitioner', 'oversize-transport', 'online-car-permit'];
const names = ['政务综合信息平台', '广东省市场准入系统', '广东省道路运输从业人员管理服务平台', '广东省交通运输厅大件运输许可系统', '惠州市网约车监管系统（车证）'];
const now = Date.UTC(2026, 9, 18, 4);
let window: BrowserWindow | undefined;
let profile = '';
let outputDirectory = '';
let failureReason = '';
type Scenario = 'inactive' | 'active' | 'no-tool' | 'tools-only' | 'single-system' | 'active-empty' | 'equipment-only' | 'food-drug-only';
let scenario: Scenario = 'inactive';
let scopeAfterManualRefresh: Scenario | undefined;
let scenarioEpoch = 0;
let sourceTabs: { tabs: Array<{ systemId: string; systemName: string; displayUrl: string; loading: boolean }>; activeSystemId: string | null } = { tabs: [], activeSystemId: null };
const errors: string[] = [];
const blockedRequests: string[] = [];
const coverage: Array<{ label: string; viewport: string }> = [];
const visualMetrics: Array<Record<string, unknown>> = [];
const actualFontSamples: Array<Record<string, unknown>> = [];
const localRecordQueries: Array<Record<string, unknown>> = [];
const queryContexts: Array<{ systemId: string; matterId: string; context: any }> = [];
const calls = new Map<string, number>();
const invocations: Array<{ method: string; args: any[]; scenario: Scenario; epoch: number; allowedSystems: string[]; allowedTools: string[] }> = [];
// Keep the explicit finish() exit code authoritative while the test window and
// temporary profile are torn down (including assertion-failure exits).
app.on('window-all-closed', () => {});
let settings = { locale: 'zh-CN' as const, retainAuditDays: 180, autoCheckUpdates: false, defaultPageSize: 20, taskConcurrency: 2 };
let allowExport = true;
let numberScope: string[] | undefined;
let recordData: Record<string, unknown> = { xzxkmc: '演示许可事项', xkXdrMc: '演示医疗服务有限公司', xkXdrLb: '法人及非法人组织', xkXdrShxym: 'DEMO-CODE-NOT-REAL', xkFrdb: '演示法人', xkWsh: '演示许可〔2026〕001号', xkNr: '仅供界面回归测试的示例许可内容。', xkJdrq: '2026-10-16', xkXkjg: '演示机关' };
let authorityCode = '';
let oversizeEvidenceStatus: 'matched' | 'conflict' = 'matched';
let healthData = Object.fromEntries(DOUBLE_PUBLICITY_TEMPLATE.map(([key]) => [key, String(recordData[key] ?? '')]));
const initialUpdate = (): UpdatePresentationState => ({ status: 'up-to-date', currentVersion: '1.0.3', message: '当前已是最新版本', automatic: true, installMode: 'installed' });
let updateState = initialUpdate(), updateCheckMode: 'latest' | 'download' = 'latest';
let finishUpdateCheck: ((value: unknown) => void) | undefined;
let delaySnapshotOnce = false;
let failPublicationOnce = false;
let marketQuery: ((context: { page: number; pageSize: number }) => Promise<{ rows: Record<string, unknown>[]; page: number; pageSize: number; total: number }>) | undefined;
let marketPreviewGate: Promise<void> | undefined;
let delayedBatch: { started: () => void; wait: Promise<void> } | undefined;
let componentGate: Promise<void> | undefined, sessionGate: Promise<void> | undefined;
const updateArtifact = { version: '1.0.4', notes: '本条仅为隔离界面测试，非真实发布。\n改善更新下载状态，并保留原有授权、会话和业务记录。', installer: 'nsis', platform: 'win32', arch: 'x64' };
function publishUpdate(state: UpdatePresentationState) {
  updateState = structuredClone(state);
  if (window && !window.isDestroyed()) window.webContents.send('ui-redesign:updates-changed', updateState);
}

const equipment = createSpecialEquipmentPlugin({ now: () => now });
const foodDrug = createFoodDrugPlugin({ now: () => now });
const licenseSystems = [equipment, foodDrug];
const licenseComponents = licenseSystems.map(({ id, name, version, description, workspaceMode }) =>
  ({ id, name, version, description, workspaceMode, kind: 'system', authorized: true }));
function allowedSystems() {
  if (scenario === 'equipment-only') return [equipment.id];
  if (scenario === 'food-drug-only') return [foodDrug.id];
  return scenario === 'tools-only' || scenario === 'active-empty' || scenario === 'inactive' ? [] : scenario === 'single-system' ? [ids[1]] : ids;
}
function allowedTools() { return scenario === 'active' || scenario === 'tools-only' ? ['health-publicity'] : []; }
function grant() {
  return { licenseId: 'ui-only-fixture', customerName: '界面测试客户（示例）', expiresAt: now + 365 * 86400000,
    allowedSystems: allowedSystems(), allowedTools: allowedTools(),
    ...(numberScope && { allowedMatters: { 'transport-practitioner': numberScope } }),
    allowExport, allowAutoSync: true, allowAutoUpdate: false, activationMode: 'online' };
}
function license() { return { state: scenario === 'inactive' ? 'inactive' : 'active', deviceId: 'ui-fixture-device-000000000000', grant: scenario === 'inactive' ? undefined : grant() }; }
function matters(systemId: string) {
  const plugin = licenseSystems.find(system => system.id === systemId);
  if (plugin) return plugin.matters.map(({ query, createDefaultContext, ...matter }) => ({
    ...matter, defaultFilters: createDefaultContext?.().filters,
  }));
  return (systemId === ids[0] ? ['水务局', '城管局', '其他'] : ['业务事项']).map((departmentName, index) => ({
    id: `${systemId}-matter-${index}`, name: `${departmentName}演示许可事项`, description: '仅供界面交互回归验证。',
    departmentId: `department-${index}`, departmentName, departmentOrder: index, uniqueKey: ['xkWsh'],
    executionMode: systemId === ids[1] ? 'query' : 'one-click-return',
    querySchema: systemId === ids[1] ? [
      { key: 'subjectName', label: '企业名称', type: 'text' }, { key: 'uniscid', label: '统一社会信用代码', type: 'text' },
      { key: 'approveDate', label: '许可日期', type: 'date-range' }, { key: 'applyno', label: '申请编号', type: 'text' },
      { key: 'province', label: '所属地区', type: 'select', options: [{ value: '', label: '全部' }, { value: 'gd', label: '广东省（示例）' }] },
      { key: 'matterType', label: '事项类型', type: 'multi-select', options: [{ value: 'registration', label: '登记（示例）' }, { value: 'change', label: '变更（示例）' }] },
      { key: 'recordNo', label: '许可文书号', type: 'text', placeholder: '界面测试高级文书号' },
      { key: 'applicantType', label: '主体类别', type: 'select', options: [{ value: '', label: '全部' }, { value: 'enterprise', label: '企业（示例）' }] },
    ] : [{ key: 'startDate', label: '开始日期', type: 'date', required: true }, { key: 'endDate', label: '结束日期', type: 'date', required: true }],
    defaultFilters: systemId === ids[1] ? { approveDate: ['2026-10-01', '2026-10-17'], province: 'gd', matterType: [] } : { startDate: '2026-10-01', endDate: '2026-10-17' },
  }));
}
function tasks() {
  return ids.flatMap(systemId => ['completed', 'running', 'failed'].map((status, index) => ({ id: `${systemId}-batch-${index}`, type: 'data-return', name: '演示回流任务',
    systemId, matterId: `${systemId}-matter-0`, status, createdAt: now - index * 60000, finishedAt: status === 'running' ? undefined : now,
    error: status === 'failed' ? '演示错误：测试状态展示' : undefined, details: { startDate: '2026-10-01', endDate: '2026-10-17' }, progress: { current: 8, total: 10, message: status === 'running' ? '正在处理 8/10' : undefined } })));
}
function record(systemId = ids[0], matterId = `${ids[0]}-matter-0`) { return { systemId, matterId, recordKey: 'fixture-record-1',
  data: systemId === 'oversize-transport' ? { ...recordData, oversizeApplicationEnrichment: { status: oversizeEvidenceStatus,
    reason: oversizeEvidenceStatus === 'matched' ? '申请编号完全匹配，信用代码取自原系统办件；法人由企业库补充' : '办件信用代码冲突，已暂停自动企业补全，请人工核对',
    reqNo: 'B4413002026101260031', path: '/gddj/api/approve/permission/selectRequest', checkedAt: now,
    applicationId: 'fixture-application', transportName: '演示运输企业', creditCode: '91440300123456789Q', field: 'transportCreditCode' } } : recordData,
  updatedAt: now, createdAt: now, rowNo: 1 }; }
function healthState() { return { authorityCode, documents: [{ id: 'health-fixture-1', fileName: '示例医疗机构登记批复.docx', kind: '执业登记', originalName: '演示医疗服务有限公司', sourceText: '演示机关关于演示医疗服务有限公司执业登记的批复\n本内容为界面测试样例，不是实际业务文书。\n经核对，同意登记。统一社会信用代码：DEMO-CODE-NOT-REAL。\n以下字段保留原文依据，缺失项需人工核实，不得猜填。', sourceData: Object.fromEntries(DOUBLE_PUBLICITY_TEMPLATE.map(([key]) => [key, String(recordData[key] ?? '')])), data: healthData, evidence: { xkXdrMc: '示例原文第一段明确提到机构名称。' }, warnings: ['示例数据，部分必填项需核实后补填。'], createdAt: now }] }; }

async function invoke(method: string, ...args: any[]) {
  calls.set(method, (calls.get(method) ?? 0) + 1);
  invocations.push({ method, args, scenario, epoch: scenarioEpoch, allowedSystems: [...allowedSystems()], allowedTools: [...allowedTools()] });
  switch (method) {
    case 'license.status': return license();
    case 'license.refresh':
      if (scopeAfterManualRefresh) { scenario = scopeAfterManualRefresh; scenarioEpoch++; scopeAfterManualRefresh = undefined; }
      return license();
    case 'license.copyIdentifier': return undefined;
    case 'license.activate': case 'license.importFile': scenario = 'active'; return license();
    case 'license.deactivate': scenario = 'inactive'; return license();
    case 'practitionerNumbers.get':
      return ['road-practitioner-return', 'taxi-driver-return'].map(matterId => ({
        matterId, year: args[0], version: 0, latestNumber: matterId === 'taxi-driver-return'
          ? `${args[0]}006755` : `惠交从（许可）字（${args[0]}）00010962号`,
      }));
    // Deliberately include unauthorized entries so the renderer's defensive
    // filtering is exercised, independent from production IPC enforcement.
    case 'components.list':
      if (componentGate) await componentGate;
      return [...ids.map((id,index)=>({id,kind:'system',name:names[index],version:'0.1.0',description:'独立业务组件，测试示例。',authorized:true,workspaceMode:id===ids[1]?'standard':'return-ledger',supportsCredentialConfiguration:true})),
        ...licenseComponents,
        {id:'health-publicity',kind:'tool',name:'卫健局双公示工具',version:'1.2.3',description:'读取医疗机构登记批复 Word 文档，核对字段并生成行政许可双公示表格',authorized:true}];
    case 'systems.list':
      if (sessionGate) await sessionGate;
      return [...ids.map(id => ({ id, name: names[ids.indexOf(id)], version: '0.1.0', workspaceMode: id === ids[1] ? 'query' : 'return-ledger', supportsCredentialConfiguration: true, session: { systemId: id, status: 'authenticated', displayName: '演示用户' } })),
        ...licenseComponents.map(component => ({ ...component, session: { systemId: component.id, status: 'authenticated' } }))];
    case 'systems.session': return { systemId: args[0], status: 'authenticated', displayName: '演示用户' };
    case 'systems.tabs': return sourceTabs;
    case 'publications.open': {
      const platform = publicationPlatform(args[0]);
      assert(platform && allowedSystems().includes(platform.ownerSystemId));
      if (failPublicationOnce) { failPublicationOnce = false; throw new Error('演示：公示平台入口暂不可用'); }
      if (!sourceTabs.tabs.some(tab => tab.systemId === platform.id)) sourceTabs.tabs.push({
        systemId: platform.id, systemName: platform.name, displayUrl: platform.allowedOrigin + new URL(platform.url).pathname, loading: false,
      });
      sourceTabs.activeSystemId = platform.id;
      return sourceTabs;
    }
    case 'systems.login': if (!sourceTabs.tabs.some(tab => tab.systemId === args[0])) sourceTabs.tabs.push({ systemId: args[0], systemName: names[ids.indexOf(args[0])], displayUrl: `https://source-fixture.invalid/${args[0]}`, loading: false }); sourceTabs.activeSystemId = args[0]; return sourceTabs;
    case 'systems.activateTab': sourceTabs.activeSystemId = args[0]; return sourceTabs;
    case 'systems.closeLogin': sourceTabs.tabs = sourceTabs.tabs.filter(tab => tab.systemId !== args[0]); if (sourceTabs.activeSystemId === args[0]) sourceTabs.activeSystemId = null; return sourceTabs;
    case 'systems.reloadLogin': case 'systems.backLogin': case 'systems.logout': return true;
    case 'matters.list': return matters(args[0]);
    case 'matters.query': {
      const context = args[2];
      queryContexts.push({ systemId: args[0], matterId: args[1], context });
      return marketQuery ? marketQuery(context) : { rows: [recordData], total: 1, page: context.page, pageSize: context.pageSize };
    }
    case 'matters.run': return { taskId: `${args[0]}-batch-0` };
    case 'tasks.list': return tasks();
    case 'tasks.page': {
      const scope = args[0];
      const rows = tasks().filter(task => task.systemId === scope.systemId && task.matterId === scope.matterId &&
        (!scope.completedBatches || task.status === 'completed') && (!scope.taskId || task.id === scope.taskId));
      return { rows, total: rows.length };
    }
    case 'tasks.cancel': return true;
    case 'tasks.output': {
      const system = args[0].split('-batch-')[0];
      const row = record(system, `${system}-matter-0`);
      if (delayedBatch) {
        const gate = delayedBatch;
        delayedBatch = undefined;
        gate.started();
        await gate.wait;
        return { rows: [{ ...row, data: { ...row.data, xkXdrMc: '延迟返回的批次样例' } }], total: 1 };
      }
      return { rows: [row], total: 1 };
    }
    case 'tasks.exportOutput': case 'records.export': case 'healthTool.export': return { path: 'fixture-only.xlsx', rowCount: 1, warningCount: 1 };
    case 'exports.openFolder': return true;
    case 'records.list': {
      const query = args[0] ?? {}; localRecordQueries.push({ ...query });
      if (query.pageSize === 10) return { rows: Array.from({ length: 10 }, (_, index) => ({ ...record(query.systemId, query.matterId), recordKey: `fixture-local-preview-${index + 1}`, data: { ...recordData, xkXdrMc: `本地示例机构 ${index + 1}` } })), total: 10 };
      return { rows: [record(query.systemId, query.matterId)], total: 1 };
    }
    case 'records.versions': return [{ version: 1, capturedAt: now - 60000, data: { ...recordData, xkNr: '演示历史版本内容' } }, { version: 2, capturedAt: now, data: recordData }];
    case 'records.update': recordData = args[3]; return record(args[0], args[1]);
    case 'settings.get': return settings;
    case 'settings.update': settings = { ...settings, ...parseSettingsPatch(args[0]) }; return settings;
    case 'credentials.status': return { configured: true, account: 'fixture-account' };
    case 'credentials.save': return { configured: true, account: args[1] };
    case 'modules.list': return ids.map((id, index) => ({ id, name: names[index], version: '0.1.0', description: '独立业务组件，测试示例。', authorized: allowedSystems().includes(id) }));
    case 'backend.status': return { origin: 'https://backend-fixture.invalid', connected: true, insecure: false };
    case 'audit.list': return [{ id: 'audit-fixture', type: 'fixture.ui-test', systemId: ids[0], createdAt: now }];
    case 'updates.state': {
      const snapshot = structuredClone(updateState);
      if (delaySnapshotOnce) { delaySnapshotOnce = false; await new Promise(resolve => setTimeout(resolve, 1200)); }
      return snapshot;
    }
    case 'updates.check': {
      if (updateCheckMode === 'latest') { publishUpdate(initialUpdate()); return { configured: true, checkedAt: now, message: '当前已是最新版本' }; }
      publishUpdate({ ...initialUpdate(), status: 'checking', message: '正在检查新版本' });
      return new Promise(resolve => { finishUpdateCheck = resolve; });
    }
    case 'updates.download': {
      publishUpdate({ ...initialUpdate(), status: 'downloading', version: updateArtifact.version, notes: updateArtifact.notes,
        progress: { downloaded: 48 * 1024 * 1024, total: 120 * 1024 * 1024, percent: 40 }, message: '正在后台下载更新，不影响当前业务' });
      return structuredClone(updateState);
    }
    case 'updates.install': {
      assert.equal(updateState.status, 'ready'); assert.equal(updateState.installMode, 'installed');
      publishUpdate({ ...updateState, status: 'installing', message: '正在保存会话，退出后自动安装并重新打开' });
      return { launched: true, fixtureOnly: true };
    }
    case 'diagnostics.list': return [{ timestamp: new Date(now).toISOString(), level: 'info', source: 'fixture.ui', message: '本条为本地界面测试日志，不含真实凭据。' }];
    case 'diagnostics.report': if (args[0] === 'error') errors.push(`${args[1]}: ${args[2]}`); return true;
    case 'diagnostics.openFolder': return true;
    case 'diagnostics.export': return { path: 'fixture-only.log', count: 1 };
    case 'sync.preview': {
      await marketPreviewGate;
      return { previewId: `fixture-preview-${args[2][0].applyno ?? 'single'}`, total: args[2].length, inserted: args[2].length, updated: 0, unchanged: 0 };
    }
    case 'sync.commit': return true;
    case 'healthTool.state': return healthState();
    case 'healthTool.importFiles': return { state: healthState(), added: 1, duplicates: 0, errors: [] };
    case 'healthTool.settings': authorityCode = args[0]; return healthState();
    case 'healthTool.update': healthData = args[1]; return healthState();
    case 'healthTool.remove': return { authorityCode, documents: [] };
    default: throw new Error(`Unimplemented isolated fixture: ${method}`);
  }
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const dom = (script: string): Promise<any> => bounded(window!.webContents.executeJavaScript(script), `DOM ${script.slice(0, 90)}`);
async function until(script: string, label = script, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await dom(script)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`UI timed out: ${label}`);
}
async function click(selector: string) {
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, `find ${selector}`);
  assert(await dom(`(() => { const target = document.querySelector(${JSON.stringify(selector)}); if (!target || target.disabled) return false; target.focus(); target.click(); return true; })()`), `click enabled ${selector}`);
}
async function button(label: string, parent = 'main', exact = true) {
  const expression = `(() => { const items = [...document.querySelectorAll(${JSON.stringify(`${parent} button`)})]; return items.find(item => ${exact ? `item.textContent.trim() === ${JSON.stringify(label)}` : `item.textContent.includes(${JSON.stringify(label)})`}); })()`;
  await until(`Boolean(${expression}) && !(${expression}).disabled`, `enabled button ${label}`);
  await dom(`(() => { const target = ${expression}; target.focus(); target.click(); })()`);
}
async function type(selector: string, value: string) {
  await dom(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
}
// Hidden offscreen windows do not guarantee requestAnimationFrame delivery on
// every Windows renderer configuration; never wait on an unbounded rAF here.
async function settled() { await new Promise(resolve => setTimeout(resolve, 120)); }
async function sampleFonts(label: string) {
  const candidate = await dom(`(() => {
    const selectors = ['.health-editor h2', '.record-drawer h2', '.system-card-title', 'main:not([hidden]) h1', '.activation-card h1', '.activation-card h2', '.activation-card strong', '.detect-login-button', '.browser-tab.active'];
    const selector = selectors.find(value => {const node = document.querySelector(value); return node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';});
    if (!selector) return null;
    const node = document.querySelector(selector), style = getComputedStyle(node);
    return {selector, text:node.textContent?.trim().slice(0, 50), computed:{fontFamily:style.fontFamily,fontSize:style.fontSize,fontWeight:style.fontWeight,lineHeight:style.lineHeight}};
  })()`);
  assert(candidate, `${label}: a visible text node must exist for actual-font verification`);
  const client = window!.webContents.debugger;
  await client.sendCommand('DOM.enable'); await client.sendCommand('CSS.enable');
  const document = await client.sendCommand('DOM.getDocument', { depth: 1 });
  const node = await client.sendCommand('DOM.querySelector', { nodeId: document.root.nodeId, selector: candidate.selector });
  assert(node.nodeId, `${label}: text node must be addressable through Chromium DOM`);
  const result = await client.sendCommand('CSS.getPlatformFontsForNode', { nodeId: node.nodeId });
  const fonts = result.fonts.filter((font: { glyphCount: number }) => font.glyphCount > 0);
  const { width, height } = window!.getContentBounds();
  const sample = { label, viewport: `${width}x${height}`, ...candidate, actualFonts: fonts };
  actualFontSamples.push(sample);
  assert(fonts.length, `${label}: Chromium must report rendered platform fonts`);
  assert(fonts.every((font: { familyName: string }) => !/SimSun|宋体|Times|Georgia|MingLiU|Batang|^serif$/i.test(font.familyName)), `${label}: serif fallback is not accepted: ${JSON.stringify(sample)}`);
  assert(fonts.some((font: { familyName: string }) => /YaHei|微软雅黑|PingFang|苹方|Noto Sans|Source Han Sans|思源黑体|Microsoft JhengHei|SF Pro|Segoe UI/i.test(font.familyName)), `${label}: actual sans-serif platform font is required: ${JSON.stringify(sample)}`);
}
async function capture(label?: string): Promise<Buffer> {
  // Electron's native capturePage rejects UnknownVizError for hidden Windows
  // windows on this host. Capture the test window through Chromium's view
  // instead; this never inspects another app or the user's desktop.
  const wasVisible = window!.isVisible();
  if (!wasVisible) { window!.showInactive(); await new Promise(resolve => setTimeout(resolve, 300)); }
  try {
    const debuggerClient = window!.webContents.debugger;
    if (!debuggerClient.isAttached()) debuggerClient.attach('1.3');
    if (label) await sampleFonts(label);
    const result = await bounded(debuggerClient.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: false, captureBeyondViewport: false }), 'Chromium screenshot');
    return Buffer.from(result.data, 'base64');
  } finally { if (!wasVisible) window!.hide(); }
}
async function checkVisualContract(label: string) {
  const metrics = await dom(`(() => {
    const rect = node => { if (!node) return null; const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const visible = selector => {const node=document.querySelector(selector);return node&&node.getClientRects().length?node:null;};
    const labels=[...document.querySelectorAll('.system-nav-toggle')].map(button=>{const node=button.querySelector('.nav-label');if(!node)return {missing:true};const range=document.createRange();range.selectNodeContents(node);const tops=[...range.getClientRects()].map(r=>Math.round(r.top));return {text:node.textContent,title:button.title,...rect(node),lines:new Set(tops).size,whiteSpace:getComputedStyle(node).whiteSpace};});
    const home=visible('.home-page'),oneClick=visible('.one-click-copy'),query=visible('.query-panel'),settings=visible('.settings-grid');
    return {width:innerWidth,height:innerHeight,labels,heroCount:document.querySelectorAll('.hero-card').length,
      activation:visible('.activation-card')?{onlineInput:!!document.querySelector('.activation-field input'),offlineTextarea:!!document.querySelector('.activation-field textarea')}:null,
      home:home?{cards:[...document.querySelectorAll('.system-card')].map(rect),recentHeader:rect(document.querySelector('.home-recent thead'))}:null,
      oneClick:oneClick?{dates:rect(document.querySelector('.return-date-fields')),flow:rect(document.querySelector('.one-click-flow')),button:rect(document.querySelector('.run-return-button')),panel:rect(document.querySelector('.one-click-panel')),preview:rect(document.querySelector('.return-preview')),previewText:document.querySelector('.return-preview')?.textContent,previewRows:document.querySelectorAll('.return-preview tbody tr').length,previewEditors:document.querySelectorAll('.return-preview input,.return-preview textarea,.return-preview select,.return-preview [contenteditable=true]').length,system:document.querySelector('.system-nav-toggle.active')?.getAttribute('title'),heading:document.querySelector('.topbar h1')?.textContent}:null,
      query:query?{panel:rect(query),header:rect(document.querySelector('.topbar')),matterCards:document.querySelectorAll('.matter-list,.matter-card').length}:null,
      components:visible('.plugin-card')?[...document.querySelectorAll('.plugin-card')].map(node=>({tag:node.tagName,display:getComputedStyle(node).display,inTable:!!node.closest('table'),...rect(node)})):null,
      settings:settings?{container:rect(settings),cards:[...settings.querySelectorAll(':scope > .settings-card')].map(rect)}:null};
  })()`);
  visualMetrics.push({ label, ...metrics });
  if (metrics.activation && label === '01-activation-online') assert(metrics.activation.onlineInput && !metrics.activation.offlineTextarea, `${label}: online activation must use a compact single-line input`);
  if (metrics.activation && label === '02-activation-offline') assert(!metrics.activation.onlineInput && metrics.activation.offlineTextarea, `${label}: offline authorization must retain its multiline key editor`);
  for (const [index, item] of metrics.labels.entries()) {
    assert(!item.missing, `${label}: system menu must provide its compact label`);
    assert.equal(item.lines, 1, `${label}: menu label must stay on a single line: ${JSON.stringify(item)}`);
    assert(item.height <= 25, `${label}: compact menu label exceeds a single text line`);
    assert.equal(item.title, names[ids.indexOf(allowedSystems()[index])], `${label}: menu tooltip must preserve the authorized system's complete name`);
  }
  if (metrics.home && metrics.width === 1440) {
    assert.equal(metrics.home.cards.length, allowedSystems().length, `${label}: only authorized system cards`);
    assert(metrics.home.cards.every((card: { height: number }) => card.height <= 112), `${label}: compact home cards must be <=112 px: ${JSON.stringify(metrics.home)}`);
    if (metrics.home.cards.length > 1) assert(Math.abs(metrics.home.cards[0].top - metrics.home.cards[1].top) <= 1 && metrics.home.cards[1].left > metrics.home.cards[0].right, `${label}: home uses two-column card layout`);
    assert(metrics.home.recentHeader && metrics.home.recentHeader.bottom <= metrics.height && metrics.home.recentHeader.top >= 0, `${label}: recent-task table header must be visible in first 1440x900 viewport: ${JSON.stringify(metrics.home)}`);
  }
  if (metrics.oneClick || metrics.query) assert.equal(metrics.heroCount, 0, `${label}: redundant hero card must be removed`);
  if (metrics.oneClick) {
    const view = metrics.oneClick;
    assert(view.dates && view.flow && view.button && view.preview, `${label}: date/flow/action/local preview regions are required`);
    assert(view.dates.top < view.flow.top, `${label}: return dates must precede the compact workflow`);
    assert(view.button.height <= 44, `${label}: return CTA must be <=44px: ${view.button.height}`);
    assert(view.button.left <= view.panel.left + 40, `${label}: return CTA must be on the left, not a large right-hand tile`);
    assert(view.previewText.includes('本地'), `${label}: preview must identify its local-only data source`);
    assert.equal(view.previewRows, 5, `${label}: preview must cap ten fixture records to five visible rows`);
    assert.equal(view.previewEditors, 0, `${label}: local preview must be read-only`);
    const systemId = ids[names.indexOf(view.system)];
    assert(localRecordQueries.some(query => query.systemId === systemId && query.matterId === `${systemId}-matter-0` && query.page === 1 && query.pageSize === 10), `${label}: preview must read scoped first-page local records, not a remote query`);
  }
  if (metrics.query) {
    assert.equal(metrics.query.matterCards, 0, `${label}: market query must not retain the separate left matter-card column`);
    assert(Math.abs(metrics.query.panel.left - metrics.query.header.left) <= 1 && Math.abs(metrics.query.panel.right - metrics.query.header.right) <= 1, `${label}: query panel must span the full content width`);
  }
  if (metrics.components) {
    assert.equal(metrics.components.length, allowedSystems().length + allowedTools().length, `${label}: component table must contain exactly the authorized systems and tools`);
    assert(metrics.components.every((row: { tag: string; display: string; inTable: boolean }) => row.tag === 'TR' && row.display === 'table-row' && row.inTable), `${label}: component layout must be a table, not a card grid`);
  }
  if (metrics.settings) {
    assert(metrics.settings.cards.length >= 2, `${label}: runtime and update settings must remain present`);
    assert(metrics.settings.cards.every((card: { width: number }) => Math.abs(card.width - metrics.settings.container.width) <= 2), `${label}: settings groups must occupy full content width`);
    assert.equal(await dom('Boolean(document.querySelector(".license-card,.connection-settings,.license-scope,.license-deactivate"))'), false, `${label}: ordinary settings must not expose authorization or backend connection controls`);
    assert.equal(await dom('document.querySelector(".page-header h1")?.textContent.trim()'), '设置', `${label}: the settings page must use its user-facing name`);
  }
}
async function screenshot(label: string) {
  console.log(`UI CHECK ${label}`);
  await settled();
  const { width, height } = window!.getContentBounds();
  const layout = await dom(`(() => {
    const sidebar = document.querySelector('.sidebar'); const main = document.querySelector('main');
    const dialog = [...document.querySelectorAll('[role="dialog"],.record-drawer,.health-editor')].find(item => item.getBoundingClientRect().width > 0);
    const bounds = item => {const r = item.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,sidebar:sidebar&&bounds(sidebar),main:main&&!main.hidden?{...bounds(main),scrollWidth:main.scrollWidth,clientWidth:main.clientWidth}:null,dialog:dialog&&bounds(dialog)};
  })()`);
  assert.equal(layout.documentWidth <= layout.width + 2, true, `${label}: document horizontal overflow ${JSON.stringify(layout)}`);
  if (layout.sidebar) assert.equal(Math.round(layout.sidebar.width), width <= 1250 ? 220 : 260, `${label}: responsive sidebar`);
  if (layout.main) { assert(layout.main.right <= layout.width + 2, `${label}: main exceeds viewport`); assert(layout.main.scrollWidth <= layout.main.clientWidth + 2, `${label}: main horizontal overflow ${JSON.stringify(layout)}`); }
  if (layout.dialog) { assert(layout.dialog.left >= -1 && layout.dialog.right <= layout.width + 1, `${label}: dialog horizontal bounds`); assert(layout.dialog.top >= -1 && layout.dialog.bottom <= layout.height + 1, `${label}: dialog vertical bounds`); }
  await checkVisualContract(label);
  await writeFile(join(outputDirectory, `${width}x${height}-${label}.png`), await capture(label));
  coverage.push({ label, viewport: `${width}x${height}` });
  console.log(`UI PASS ${width}x${height} ${label}`);
}
async function reload(nextScenario: Scenario) { console.log(`UI LOAD ${nextScenario}`); scenario = nextScenario; scenarioEpoch++; sourceTabs = { tabs: [], activeSystemId: null }; await bounded(window!.loadFile(resolve('out/renderer/index.html')), `load ${nextScenario}`); await settled(); }

async function assertEntitledChrome(label: string) {
  const chrome = await dom(`(() => ({
    systemIds:[...document.querySelectorAll('.system-nav-toggle')].map(node=>node.getAttribute('title')),
    navTitles:[...document.querySelectorAll('.sidebar .nav-title')].map(node=>node.textContent.trim()),
    workbenchButtons:[...document.querySelectorAll('.sidebar button')].filter(node=>node.textContent.trim()==='工作台').length,
    toolButtons:[...document.querySelectorAll('.sidebar button')].filter(node=>node.textContent.trim()==='卫健局双公示工具').length,
    appTab:document.querySelector('.browser-tab')?.textContent.trim(),
    locked:!!document.querySelector('.health-locked'),
    unauthorizedCopy:document.querySelector('main')?.textContent.includes('未授权'),
    homeToolCards:document.querySelectorAll('.home-tool-card').length
  }))()`);
  assert.deepEqual(chrome.systemIds, allowedSystems().map(id => names[ids.indexOf(id)]), `${label}: sidebar must contain exactly the authorized systems`);
  assert.equal(chrome.workbenchButtons, allowedSystems().length ? 1 : 0, `${label}: workbench navigation must follow business authorization`);
  assert.equal(chrome.navTitles.includes('业务系统'), Boolean(allowedSystems().length), `${label}: empty business group must be absent`);
  assert.equal(chrome.navTitles.includes('工具'), Boolean(allowedTools().length), `${label}: empty tool group must be absent`);
  assert.equal(chrome.toolButtons, allowedTools().length ? 1 : 0, `${label}: unauthorized tool navigation must be absent, not locked`);
  assert.equal(chrome.locked, false, `${label}: a locked-tool page must never be displayed`);
  assert.equal(chrome.unauthorizedCopy, false, `${label}: unavailable modules must not appear in the main page`);
  if (!allowedSystems().length) assert(!chrome.appTab?.includes('工作台'), `${label}: the app tab must not advertise a business workbench`);
  if (!allowedTools().length) assert.equal(chrome.homeToolCards, 0, `${label}: unauthorized tool cards must not be mounted`);
}

function assertAuthorizedReads(start: number, label: string) {
  const violations = invocations.slice(start).filter(call => {
    if (call.method.startsWith('healthTool.')) return !call.allowedTools.includes('health-publicity');
    if (call.method.startsWith('practitionerNumbers.')) return !call.allowedSystems.includes('transport-practitioner');
    if (call.method === 'publications.open') return !call.allowedSystems.includes('government-info');
    if (/^(matters\.|credentials\.|systems\.(session|login|reloadLogin|backLogin|logout)$|records\.(versions|update)$|sync\.preview$)/.test(call.method)) return !call.allowedSystems.includes(call.args[0]);
    if (call.method === 'records.list' || call.method === 'records.export') return !call.allowedSystems.includes(call.args[0]?.systemId);
    if (/^tasks\./.test(call.method)) {
      if (!call.allowedSystems.length) return true;
      if (call.method === 'tasks.page') return !call.allowedSystems.includes(call.args[0]?.systemId);
      if (call.method !== 'tasks.list') return !call.allowedSystems.some(id => String(call.args[0]).startsWith(`${id}-batch-`));
    }
    return false;
  });
  assert.deepEqual(violations, [], `${label}: no reads/actions may target an unauthorized system or tool`);
}

async function changeAuthorization(nextScenario: Scenario) {
  console.log(`UI REFRESH LICENSE ${scenario} -> ${nextScenario}`);
  const previousStatusCalls = calls.get('license.status') ?? 0;
  scenario = nextScenario; scenarioEpoch++;
  // Exercise the same local license status refresh used when a user returns
  // to the app, without a test-only production endpoint or a full remount.
  await dom('window.dispatchEvent(new Event("focus"))');
  await until(`${JSON.stringify(allowedSystems().map(id => names[ids.indexOf(id)]))}.join('|') === [...document.querySelectorAll('.system-nav-toggle')].map(node=>node.getAttribute('title')).join('|')`, `refreshed ${nextScenario} navigation`);
  assert((calls.get('license.status') ?? 0) > previousStatusCalls, 'Returning to the app must re-read the local license status');
  await settled();
}
async function escapeDialog(selector: string) {
  await settled();
  // The harness never takes OS focus. Dispatch a cancelable keyboard event in
  // its own document to exercise the shared modal handler deterministically.
  await dom('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true, cancelable:true}))');
  await until(`!document.querySelector(${JSON.stringify(selector)})`, `Escape closes ${selector}`);
}
async function checkDialogFocus(selector: string) {
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`); await settled();
  assert.equal(await dom(`document.querySelector(${JSON.stringify(selector)}).getAttribute('role')`), 'dialog', `${selector}: accessible dialog role`);
  assert.equal(await dom(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-modal')`), 'true', `${selector}: accessible modal state`);
  assert(await dom(`document.querySelector(${JSON.stringify(selector)}).contains(document.activeElement)`), `${selector}: focus should move inside dialog`);
  await dom(`(() => { const dialog = document.querySelector(${JSON.stringify(selector)}); const controls = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]')].filter(item=>item.getClientRects().length); controls.at(-1)?.focus(); })()`);
  await dom('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Tab", bubbles:true, cancelable:true}))'); await settled();
  assert(await dom(`document.querySelector(${JSON.stringify(selector)}).contains(document.activeElement)`), `${selector}: Tab should stay in modal`);
  assert(await dom(`(() => { const controls = [...document.querySelector(${JSON.stringify(selector)}).querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]')].filter(item=>item.getClientRects().length); return document.activeElement === controls[0]; })()`), `${selector}: Tab from last control should wrap to first`);
}

async function verifyLedgerPreferences() {
  const original = settings;
  await reload('active');
  await button('设置', '.sidebar');
  await until('Boolean(document.querySelector(".settings-form input[type=number]"))');
  await type('.settings-form input[type=number]', '37');
  await button('保存设置', '.runtime-settings');
  await until('document.querySelector(".page-message")?.textContent.includes("设置已保存")');
  assert.equal(settings.defaultPageSize, 37);
  await button('工作台', '.sidebar');
  await click('.home-recent .link-button');
  await until('Boolean(document.querySelector(".record-table-panel tbody .link-button"))');
  assert.equal(await dom('document.querySelector(".pagination select").value'), '37');
  assert.equal(invocations.filter(call => call.method === 'tasks.output').at(-1)?.args[2], 37);
  await type('.batch-filter-bar input', '实际查询的企业');
  await button('查询', '.batch-filter-bar');
  await until('Boolean(document.querySelector(".record-table-panel tbody .link-button"))');
  await type('.batch-filter-bar input', '尚未提交的搜索词');
  await button('导出省执法双公示');
  await until('Boolean(document.querySelector(".export-notice-path"))');
  assert.equal(invocations.filter(call => call.method === 'tasks.exportOutput').at(-1)?.args[1], '实际查询的企业');
  allowExport = false;
  await dom('window.dispatchEvent(new Event("focus"))');
  await until('![...document.querySelectorAll(".publication-actions button")].some(item=>item.textContent.includes("导出"))');
  assert.equal(await dom('document.querySelectorAll(".publication-actions button").length'), 2);
  assert.equal(await dom('Boolean(document.querySelector(".export-notice-path"))'), false);
  allowExport = true;
  settings = original;
}

async function verifyMarketQueryPages() {
  const total = 73;
  let failQuery = false;
  let queryGate: Promise<void> | undefined;
  marketQuery = async ({ page, pageSize }) => {
    await queryGate;
    if (failQuery) throw new Error('模拟市场查询失败');
    const offset = (page - 1) * pageSize;
    const rows = Array.from({ length: Math.max(0, Math.min(pageSize, total - offset)) }, (_, i) => ({ applyno: `M-${offset + i + 1}` }));
    return { page, pageSize, rows, total };
  };
  try {
    await button('执行查询', '.query-panel');
    await until('Boolean(document.querySelector(".result-panel .pagination"))');
    const size = queryContexts.at(-1)!.context.pageSize;
    assert.equal(size, Math.min(settings.defaultPageSize, 200));
    let releasePreview!: () => void;
    marketPreviewGate = new Promise<void>(resolve => { releasePreview = resolve; });
    await button('预览本页同步变化', '.result-panel');
    await until('document.querySelector(".query-panel .message")?.textContent.includes("计算本页")');
    await button('下一页', '.result-panel');
    await until(`document.querySelector(".result-panel tbody td")?.textContent === "M-${size + 1}"`);
    releasePreview(); marketPreviewGate = undefined;
    await settled();
    assert.equal(await dom('Boolean(document.querySelector(".sync-preview"))'), false, 'Previous page preview must never enable confirmation on the next page');
    for (let page = 3; page <= Math.ceil(total / size); page++) {
      await button('下一页', '.result-panel');
      await until(`document.querySelector(".result-panel tbody td")?.textContent === "M-${(page - 1) * size + 1}"`);
    }
    const lastStart = Math.floor((total - 1) / size) * size + 1;
    await button('预览本页同步变化', '.result-panel');
    await until('Boolean(document.querySelector(".sync-preview button:not(:disabled)"))');
    const preview = invocations.filter(call => call.method === 'sync.preview').at(-1)!;
    assert.deepEqual(preview.args[2].map((row: {applyno: string}) => row.applyno),
      Array.from({ length: total - lastStart + 1 }, (_, i) => `M-${lastStart + i}`));
    await button('确认写入本页', '.sync-preview');
    await until('document.querySelector(".query-panel .message")?.textContent.includes("已写入")');
    assert.equal(invocations.filter(call => call.method === 'sync.commit').at(-1)?.args[0], `fixture-preview-M-${lastStart}`);

    await button('预览本页同步变化', '.result-panel');
    await until('Boolean(document.querySelector(".sync-preview button:not(:disabled)"))');
    failQuery = true;
    await button('执行查询', '.query-panel');
    await until('document.querySelector(".query-panel .message")?.textContent.includes("模拟市场查询失败")');
    assert.equal(await dom('document.querySelectorAll(".sync-preview, .result-panel tbody tr, .result-panel button").length'), 0);

    failQuery = false;
    let releaseQuery!: () => void;
    queryGate = new Promise<void>(resolve => { releaseQuery = resolve; });
    await button('执行查询', '.query-panel');
    await until('document.querySelector(".query-panel .message")?.textContent.includes("正在查询")');
    await dom('document.querySelectorAll(".system-nav-toggle")[0].click()');
    await until('Boolean(document.querySelector(".return-preview"))');
    await dom('document.querySelectorAll(".system-nav-toggle")[1].click()');
    await until('Boolean(document.querySelector(".query-panel"))');
    releaseQuery(); await settled();
    assert.equal(await dom('document.querySelectorAll(".result-panel tbody tr, .sync-preview").length'), 0);
  } finally { marketQuery = undefined; marketPreviewGate = undefined; }
}

async function runViewport(width: number, height: number) {
  oversizeEvidenceStatus = 'matched';
  updateState = initialUpdate(); updateCheckMode = 'latest';
  window!.setContentSize(width, height); await reload('inactive'); await until(`innerWidth === ${width} && innerHeight === ${height}`);
  await until('Boolean(document.querySelector(".activation-card"))'); await screenshot('01-activation-online');
  await click('.activation-tabs button:nth-child(2)'); await screenshot('02-activation-offline');
  await button('导入离线授权文件', '.activation-shell'); await until('document.querySelectorAll(".system-nav-toggle").length === 5');
  await screenshot('03-home');
  assert(await dom('Boolean(document.querySelector(".home-page,.home-dashboard,.home-systems,.home-system-grid,.workspace-home"))'), 'Home dashboard should be the default licensed page');
  assert(await dom('Boolean(getComputedStyle(document.documentElement).getPropertyValue("--app-bg").trim()) && Boolean(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())'), 'Shared light-theme design tokens must be loaded');
  // Open the tool directly from the home entry, then return through the sidebar.
  assert.equal(await dom('document.querySelectorAll(".system-card-grid > .system-card").length'), 5);
  await click('.system-card-title'); await until('Boolean(document.querySelector(".one-click-copy"))');
  await button('工作台', '.sidebar');
  await button('打开工具', '.home-tool-card'); await until('Boolean(document.querySelector(".health-documents"))'); await screenshot('04-health-tool-home-entry');
  await button('工作台', '.sidebar');
  await click('.home-recent .link-button'); await until('Boolean(document.querySelector(".batch-filter-bar select"))');
  assert.equal(await dom('document.querySelector(".batch-filter-bar select").value'), `${ids[0]}-batch-0`, 'Home recent task should open its exact saved batch');
  await button('工作台', '.sidebar');
  // System -> department -> matter must remain individually collapsible.
  assert.equal(await dom('document.querySelectorAll(".department-nav-title").length'), 0);
  await click('.system-nav-toggle'); await until('document.querySelectorAll(".department-nav-title").length === 3');
  assert.equal(await dom('document.querySelectorAll(".matter-subnav button").length'), 0);
  await click('.department-nav-title'); await until('document.querySelectorAll(".matter-subnav button").length === 1');
  await click('.department-nav-title'); assert.equal(await dom('document.querySelectorAll(".matter-subnav button").length'), 0);
  await click('.system-nav-toggle'); assert.equal(await dom('document.querySelectorAll(".department-nav-title").length'), 0);
  await click('.system-nav-toggle'); await click('.department-nav-title'); await click('.matter-subnav button');
  await until('Boolean(document.querySelector(".one-click-copy"))'); await screenshot('05-government-return');
  assert.equal(await dom('document.querySelectorAll(".return-date-fields input").length'), 2);
  await button('账号配置'); await until('Boolean(document.querySelector(".credential-form"))'); await screenshot('06-system-credentials'); await button('收起', '.system-credential-card');
  await click('.run-return-button'); await until('Boolean(document.querySelector(".task-table-panel tbody tr"))'); await screenshot('07-return-tasks');
  const createdTaskNotice = await dom('document.querySelector("main > .page-message")?.textContent.trim()');
  assert(createdTaskNotice, 'Creating a fixture task should show its contextual return notice');
  assert.equal(await dom('document.querySelectorAll(".task-table-panel tbody tr").length'), 3);
  await button('在回流数据中查看', '.task-table-panel'); await until('Boolean(document.querySelector(".record-table-panel tbody tr .link-button"))'); await screenshot('08-batch-data');
  assert.deepEqual(await dom('[...document.querySelectorAll(".publication-actions button")].map(item=>item.textContent.trim())'),
    ['导出省执法双公示', '导出南山双公示', '报送南山双公示', '报送省行政执法双公示']);
  const reportLayout = await dom(`(()=>{const header=document.querySelector('.publication-page-header').getBoundingClientRect();return [...document.querySelectorAll('.publication-actions button')].map(item=>{const r=item.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height,withinHeader:r.left>=header.left&&r.right<=header.right+1};});})()`);
  assert(reportLayout.every((item: { withinHeader: boolean; height: number }) => item.withinHeader && item.height >= 44), 'Publication buttons must stay in bounds and retain accessible target heights');
  const selectedBeforePublication = await dom('document.querySelector(".batch-filter-bar select").value');
  for (const [label, target] of [['导出省执法双公示', 'guangdong-law'], ['导出南山双公示', 'nanshan']]) {
    await button(label); await until('Boolean(document.querySelector(".export-notice"))');
    const exported = invocations.filter(call => call.method === 'tasks.exportOutput').at(-1)!;
    assert.deepEqual(exported.args, [selectedBeforePublication, undefined, target], 'Template export must retain the selected batch and forward its fixed target');
    assert.equal(await dom('document.querySelector(".batch-filter-bar select").value'), selectedBeforePublication);
  }
  await screenshot('08b-government-export-buttons');
  const exportCallsBeforePublication = calls.get('tasks.exportOutput') ?? 0;
  failPublicationOnce = true;
  await button('报送南山双公示'); await until('document.querySelector("main > .page-message")?.textContent.includes("公示平台入口暂不可用")');
  assert.equal(sourceTabs.activeSystemId, null);
  await type('.batch-filter-bar input', '保留搜索条件');
  for (const platform of Object.values(PUBLICATION_PLATFORMS)) {
    await button(platform.buttonLabel); await until('Boolean(document.querySelector(".browser-remote-stage"))');
    assert.equal(sourceTabs.activeSystemId, platform.id);
    assert.equal(await dom('document.querySelector(".login-detection")'), null, 'Publication entry must not imply business login validation');
    assert.equal(await dom('document.querySelector(".browser-address span").textContent'), platform.allowedOrigin + new URL(platform.url).pathname);
    await screenshot(`08-publication-${platform.id}`);
    await button('返回回流数据', '.browser-toolbar'); await until('!document.querySelector("main").hidden');
    assert.equal(await dom('document.querySelector(".batch-filter-bar select").value'), selectedBeforePublication);
    assert.equal(await dom('document.querySelector(".batch-filter-bar input").value'), '保留搜索条件');
  }
  assert.equal(sourceTabs.tabs.length, 2);
  await button('报送南山双公示'); await until('Boolean(document.querySelector(".browser-remote-stage"))');
  assert.equal(sourceTabs.tabs.length, 2, 'Reopening must reuse the retained page');
  await dom(`document.querySelector('button[aria-label="关闭${PUBLICATION_PLATFORMS['nanshan-publicity'].name}标签页"]').click()`);
  await until('!document.querySelector("main").hidden');
  assert.equal(sourceTabs.tabs.length, 1);
  assert.equal(sourceTabs.tabs[0].systemId, 'guangdong-law-publicity', 'Closing one publication must preserve the other');
  assert.equal(calls.get('tasks.exportOutput') ?? 0, exportCallsBeforePublication, 'Login entry must not export/upload batch data');
  assert(invocations.filter(call => call.method === 'publications.open').every(call => call.args.length === 1 && publicationPlatform(call.args[0])), 'Only a fixed platform ID may cross the publication IPC');
  await type('.batch-filter-bar input', '');
  await button('导出省执法双公示'); await until('[...document.querySelectorAll(".page-message")].some(item=>item.textContent.includes("fixture-only.xlsx"))');
  const batchFolderCalls = calls.get('exports.openFolder') ?? 0;
  await click('.export-notice-path'); assert.equal(calls.get('exports.openFolder'), batchFolderCalls + 1);
  await screenshot('08b-export-result-folder-link');
  await click('.record-table-panel tbody tr .link-button'); await checkDialogFocus('.record-drawer');
  assert(await dom('Boolean(document.querySelector(".snapshot-notice"))'), 'Batch snapshot must remain read-only');
  assert.equal(await dom('document.querySelectorAll(".record-edit-form").length'), 0); await screenshot('09-batch-snapshot'); await escapeDialog('.record-drawer');
  let finishBatch!: () => void;
  const batchStarted = new Promise<void>(started => {
    delayedBatch = { started, wait: new Promise<void>(resolve => { finishBatch = resolve; }) };
  });
  await button('查询', '.batch-filter-bar');
  await bounded(batchStarted, 'delayed historical snapshot query');
  await dom('(()=>{const select=document.querySelector(".batch-filter-bar select");select.value="";select.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await until('document.querySelector(".record-table-panel .link-button")?.textContent.includes("修改")');
  const ledgerText = await dom('document.querySelector(".record-table-panel").textContent');
  finishBatch();
  await settled();
  assert.equal(await dom('document.querySelector(".record-table-panel").textContent.includes("延迟返回的批次样例")'), false, 'A late snapshot must never become an editable ledger row');
  assert.equal(await dom('document.querySelector(".record-table-panel").textContent'), ledgerText);
  for (const [label, target] of [['导出省执法双公示', 'guangdong-law'], ['导出南山双公示', 'nanshan']]) {
    await button(label); await until('[...document.querySelectorAll(".page-message")].some(item=>item.textContent.includes("fixture-only.xlsx"))');
    const exported = invocations.filter(call => call.method === 'records.export').at(-1)!;
    assert.deepEqual(exported.args, [{ keyword: undefined, systemId: ids[0], matterId: matters(ids[0])[0].id }, 'xlsx', target], 'Merged ledger must use the selected matter and selected template');
  }
  const ledgerFolderCalls = calls.get('exports.openFolder') ?? 0;
  await click('.export-notice-path'); assert.equal(calls.get('exports.openFolder'), ledgerFolderCalls + 1);
  await click('.record-table-panel tbody tr .link-button'); await checkDialogFocus('.record-drawer');
  await until('document.querySelectorAll(".version-timeline > div").length === 2'); await screenshot('10-record-detail-history');
  await button('修改数据', '.record-drawer'); await until('Boolean(document.querySelector(".record-edit-form input"))'); await screenshot('11-record-edit');
  await type('.record-edit-form label:nth-of-type(2) input', '已修改的演示企业名称'); await button('保存修改', '.record-drawer'); await until('!document.querySelector(".record-edit-form")');
  assert.equal(recordData.xkXdrMc, '已修改的演示企业名称'); await escapeDialog('.record-drawer');
  // Five system destinations and the normal query/sync workflow.
  for (let index = 1; index < ids.length; index++) {
    await dom(`document.querySelectorAll('.system-nav-toggle')[${index}].click()`);
    await until(`document.querySelector('.system-nav-toggle.active')?.getAttribute('title') === ${JSON.stringify(names[index])}`);
    await until(index === 1 ? 'Boolean(document.querySelector(".query-panel input"))' : 'document.querySelectorAll(".return-preview tbody tr").length === 5');
    if (index === 1) assert.equal(await dom(`document.querySelector('main').textContent.includes(${JSON.stringify(createdTaskNotice)})`), false, 'Switching from government return to market query must clear the previous system task notice');
    await screenshot(`12-system-${ids[index]}`);
    if (index === 3) {
      await button('回流数据', '.matter-workspace-tabs'); await until('Boolean(document.querySelector(".record-table-panel tbody tr .link-button"))');
      assert.equal(await dom('document.querySelectorAll(".publication-actions button").length'), 1, 'Publication buttons belong only to government reflow data');
      await click('.record-table-panel tbody tr .link-button'); await checkDialogFocus('.record-drawer');
      assert(await dom('document.querySelector(".record-drawer").textContent.includes("办件补充依据 · 编号已匹配")'));
      assert(await dom('document.querySelector(".record-drawer").textContent.includes("transportCreditCode")'));
      assert(await dom('document.querySelector(".record-drawer").textContent.includes("经办人不是法人")'));
      await dom('[...document.querySelectorAll(".record-drawer h3")].find(item=>item.textContent.includes("办件补充依据")).scrollIntoView({block:"center"})');
      await screenshot('12c-oversize-application-evidence'); await escapeDialog('.record-drawer');
      oversizeEvidenceStatus = 'conflict'; await button('查询', '.batch-filter-bar');
      await until('document.querySelector(".record-table-panel .status-chip.warning")?.title.includes("办件信用代码冲突")');
      await screenshot('12d-oversize-conflict-warning');
      oversizeEvidenceStatus = 'matched';
    }
    if (index === 1) {
      assert.equal(await dom('document.querySelectorAll(".query-panel .form-grid > label").length'), 4, 'Compact market query must retain its four primary filters');
      await click('.advanced-toggle'); await until('document.querySelectorAll(".query-panel .form-grid > label").length === 8');
      await type('.query-panel input[placeholder="界面测试高级文书号"]', 'ADVANCED-FIXTURE'); await screenshot('12b-market-advanced-conditions');
      await click('.advanced-toggle'); await until('document.querySelectorAll(".query-panel .form-grid > label").length === 4');
      await button('执行查询', '.query-panel'); await until('document.querySelectorAll(".result-panel tbody tr").length === 1');
      assert.equal(queryContexts.at(-1)?.context.filters.recordNo, 'ADVANCED-FIXTURE', 'Collapsing advanced conditions must not erase their submitted value');
      await button('预览本页同步变化', '.result-panel'); await until('Boolean(document.querySelector(".sync-preview"))'); await screenshot('13-query-sync-preview'); await button('确认写入本页', '.sync-preview');
      await verifyMarketQueryPages();
    }
  }
  // The remote page itself is deliberately never loaded. Check only its app chrome.
  await button('打开原系统', '.session-box'); await until('Boolean(document.querySelector(".browser-remote-stage"))');
  assert.equal(await dom('document.querySelector(".browser-remote-stage").getBoundingClientRect().top'), 104); await screenshot('14-source-tab-shell');
  await click('.browser-tab'); await until('!document.querySelector("main").hidden');
  await button('组件管理', '.sidebar'); await until('document.querySelectorAll(".plugin-card").length === 6'); await screenshot('15-system-components');
  const previousBackendStatusCalls = calls.get('backend.status') ?? 0;
  await button('设置', '.sidebar'); await until('Boolean(document.querySelector(".settings-form input"))'); await screenshot('16-settings');
  await button('保存设置'); await button('检查更新');
  assert.equal(calls.get('backend.status') ?? 0, previousBackendStatusCalls, 'Normal settings should not read or display backend connection details');
  await verifyUpdateStates();
  for (let index = 0; index < 5; index++) await click('.diagnostics-trigger'); await until('Boolean(document.querySelector(".diagnostics-panel"))');
  await until('document.querySelectorAll(".diagnostics-row").length === 1'); await screenshot('17-hidden-diagnostics'); await button('返回设置');
  await button('卫健局双公示工具', '.sidebar'); await until('document.querySelectorAll(".health-table tbody tr").length === 1');
  await button('导入 Word 批复'); await until('document.querySelector("[role=status]")?.textContent.includes("已导入")');
  await button('导出所选', 'main', false); await until('document.querySelector(".export-notice-path")?.textContent.includes("fixture-only.xlsx")');
  const healthFolderCalls = calls.get('exports.openFolder') ?? 0;
  await click('.export-notice-path'); assert.equal(calls.get('exports.openFolder'), healthFolderCalls + 1);
  await screenshot('18-health-tool'); await button('核对字段', '.health-table'); await checkDialogFocus('.health-editor');
  assert.equal(await dom('document.querySelectorAll(".health-field").length'), 31); assert(await dom('document.querySelector(".health-source pre").textContent.includes("界面测试样例")'));
  assert.equal(await dom('document.querySelector(".health-source textarea,.health-source input,[contenteditable=true]")'), null, 'Original Word text must stay read-only');
  await screenshot('19-health-31-fields-evidence'); await escapeDialog('.health-editor');
  await button('核对字段', '.health-table'); await type('.health-field:nth-of-type(2) input', '已核对的演示机构'); await button('保存字段', '.health-editor'); await until('!document.querySelector(".health-editor")');
  assert.equal(healthData.xkXdrMc, '已核对的演示机构');
  let restrictedStart = invocations.length;
  await reload('no-tool'); await until('document.querySelectorAll(".system-card-grid > .system-card").length === 5');
  await assertEntitledChrome('20-health-unauthorized-hidden'); await screenshot('20-health-unauthorized-hidden');
  await button('组件管理', '.sidebar'); await until('document.querySelectorAll(".plugin-card").length === 5');
  await assertEntitledChrome('20b-components-without-tool'); await screenshot('20b-components-without-tool');
  assertAuthorizedReads(restrictedStart, 'No tool authorization');

  restrictedStart = invocations.length;
  await reload('tools-only'); await until('Boolean(document.querySelector(".health-documents"))');
  await assertEntitledChrome('21-tools-only-license'); await screenshot('21-tools-only-license');
  await button('组件管理', '.sidebar'); await until('document.querySelectorAll(".plugin-card").length === 1');
  assert.equal(await dom('document.querySelectorAll(".plugin-card[data-component-kind=system]").length'), 0, 'Tool-only component view must not contain business-system rows');
  assert.equal(await dom('document.querySelector(".component-version")?.textContent'), 'v1.2.3', 'Tool version comes from its component metadata');
  await assertEntitledChrome('21b-tools-only-components'); await screenshot('21b-tools-only-components');
  await button('设置', '.sidebar'); await until('Boolean(document.querySelector(".update-settings"))');
  assert.equal(await dom('document.querySelectorAll(".settings-form input[type=number]").length'), 0, 'Tool-only settings must not expose business pagination/concurrency controls');
  await assertEntitledChrome('21c-tools-only-settings'); await screenshot('21c-tools-only-settings');
  assertAuthorizedReads(restrictedStart, 'Tools-only authorization');

  restrictedStart = invocations.length;
  await reload('single-system'); await until('document.querySelectorAll(".system-card-grid > .system-card").length === 1');
  await assertEntitledChrome('22-single-system-license');
  await until('document.querySelectorAll(".home-recent tbody tr").length === 3', 'only the three tasks belonging to the authorized system');
  assert.equal(await dom('document.querySelectorAll(".home-recent tbody tr").length'), 3, 'Recent tasks must exclude the other four unauthorized systems');
  await screenshot('22-single-system-license');
  await button('组件管理', '.sidebar'); await until('document.querySelectorAll(".plugin-card").length === 1');
  assert.equal(await dom('document.querySelector(".plugin-card .component-name span")?.getAttribute("title")'), names[1], 'Component table must retain only the specifically authorized system');
  await assertEntitledChrome('22b-single-system-components'); await screenshot('22b-single-system-components');
  assertAuthorizedReads(restrictedStart, 'Single-system authorization');

  restrictedStart = invocations.length;
  await reload('active-empty'); await until('Boolean(document.querySelector(".update-settings"))');
  await assertEntitledChrome('23-active-empty-license');
  assert.equal(await dom('document.querySelectorAll(".system-card,.home-recent,.home-tools,.component-table,.health-documents,.one-click-panel,.query-panel,.record-table-panel,.task-table-panel").length'), 0, 'An active license with no entitlements must land in settings without business/tool content');
  await screenshot('23-active-empty-license');
  assertAuthorizedReads(restrictedStart, 'Active license with no business or tool grants');

  // Revoke while business data/details are mounted, rather than testing only
  // fresh loads. A returning user must not retain a stale privileged surface.
  await reload('active'); await until('document.querySelectorAll(".system-nav-toggle").length === 5');
  await click('.system-nav-toggle'); await until('document.querySelectorAll(".department-nav-title").length === 3');
  await click('.department-nav-title'); await click('.matter-subnav button');
  await until('Boolean(document.querySelector(".one-click-copy"))');
  await button('回流数据', '.matter-workspace-tabs'); await until('Boolean(document.querySelector(".record-table-panel tbody tr .link-button"))');
  await click('.record-table-panel tbody tr .link-button'); await checkDialogFocus('.record-drawer');
  await changeAuthorization('tools-only'); await until('Boolean(document.querySelector(".health-documents"))');
  assert.equal(await dom('document.querySelectorAll(".record-drawer,.record-edit-form,.one-click-panel,.query-panel,.record-table-panel,.task-table-panel").length'), 0, 'Business revocation must unmount active data, dialog, and task surfaces');
  restrictedStart = invocations.length;
  await assertEntitledChrome('24-live-revoke-business'); await screenshot('24-live-revoke-business');
  await button('核对字段', '.health-table'); await checkDialogFocus('.health-editor');
  assertAuthorizedReads(restrictedStart, 'After live business revocation');

  await changeAuthorization('no-tool'); await until('Boolean(document.querySelector(".home-page"))');
  assert.equal(await dom('document.querySelectorAll(".health-editor,.health-documents,.health-locked").length'), 0, 'Tool revocation must unmount the editor and tool content');
  await assertEntitledChrome('25-live-revoke-tool'); await screenshot('25-live-revoke-tool');
  await changeAuthorization('active-empty'); await until('Boolean(document.querySelector(".update-settings"))');
  restrictedStart = invocations.length;
  await assertEntitledChrome('26-live-revoke-all'); await screenshot('26-live-revoke-all');
  assertAuthorizedReads(restrictedStart, 'After live revocation of all grants');

  // Native source views need explicit hiding when a grant is reduced, and
  // also when the entire workspace unmounts on license loss. Do not clear the
  // original tab/session while preventing its revoked UI from remaining open.
  await reload('active'); await until('document.querySelectorAll(".system-card").length === 5');
  await button('打开原系统', '.system-card'); await until('Boolean(document.querySelector(".browser-remote-stage"))');
  await changeAuthorization('tools-only'); await until('Boolean(document.querySelector(".health-documents"))'); await settled();
  assert.equal(sourceTabs.activeSystemId, null, 'A revoked original-system view must be hidden');
  assert.equal(sourceTabs.tabs.length, 1, 'Revocation hides the source view without deleting its saved tab/session');
  assert.equal(await dom('document.querySelectorAll(".source-tab,.browser-remote-stage").length'), 0);
  await screenshot('27-source-view-revoked');

  await reload('active'); await until('document.querySelectorAll(".system-nav-toggle").length === 5');
  await click('.system-nav-toggle'); await until('document.querySelectorAll(".department-nav-title").length === 3');
  await click('.department-nav-title'); await click('.matter-subnav button');
  await button('回流数据', '.matter-workspace-tabs'); await until('Boolean(document.querySelector(".publication-actions"))');
  await button('报送省行政执法双公示'); await until('Boolean(document.querySelector(".browser-remote-stage"))');
  await changeAuthorization('tools-only'); await until('Boolean(document.querySelector(".health-documents"))'); await settled();
  assert.equal(sourceTabs.activeSystemId, null, 'Government revocation must hide a native publication page too');
  assert.equal(sourceTabs.tabs.length, 1, 'Hiding the publication view must retain its page');
  assert.equal(await dom('document.querySelectorAll(".source-tab,.browser-remote-stage").length'), 0);
  await screenshot('27b-publication-view-revoked');

  await reload('active'); await until('document.querySelectorAll(".system-card").length === 5');
  await button('打开原系统', '.system-card'); await until('Boolean(document.querySelector(".browser-remote-stage"))');
  await changeAuthorization('inactive'); await until('Boolean(document.querySelector(".activation-card"))'); await settled();
  assert.equal(sourceTabs.activeSystemId, null, 'Losing the license must hide the native source view when workspace unmounts');
  assert.equal(sourceTabs.tabs.length, 1, 'Losing the license does not delete source sessions');
  await screenshot('28-live-license-loss');
  await reload('inactive'); await type('.activation-field input', 'UI-FIXTURE-NOT-A-REAL-KEY'); await button('激活并进入工作台', '.activation-shell'); await until('document.querySelectorAll(".system-nav-toggle").length === 5');
  if (width === 1440) { await verifyComponentStartup(); await verifyInitialUpdateRace(); }
}

async function verifyComponentStartup() {
  let releaseComponents!:()=>void, releaseSessions!:()=>void;
  componentGate=new Promise(resolve=>{releaseComponents=resolve;});
  sessionGate=new Promise(resolve=>{releaseSessions=resolve;});
  try {
    await reload('active');await until('Boolean(document.querySelector(".component-bootstrap"))');
    assert.equal(await dom('document.querySelectorAll(".sidebar,.home-tool-card,.health-documents").length'),0,'No tool-only intermediate screen before catalog arrives');
    releaseComponents();componentGate=undefined;
    await until('document.querySelectorAll(".system-nav-toggle").length === 5');
    await assertEntitledChrome('29-atomic-component-startup');
    await button('组件管理','.sidebar');await until('document.querySelectorAll(".plugin-card").length === 6');
    assert.equal(await dom('document.querySelector(".plugin-card[data-component-kind=tool] .component-version")?.textContent'),'v1.2.3');
    assert.equal(await dom('document.querySelectorAll(".component-table").length'),1,'Systems and tools share one table');
    await screenshot('29-atomic-component-startup');
  } finally { releaseComponents();releaseSessions();componentGate=undefined;sessionGate=undefined; }
}

async function keyboardEnter() {
  const wasVisible = window!.isVisible();
  if (!wasVisible) window!.showInactive();
  const client = window!.webContents.debugger;
  if (!client.isAttached()) client.attach('1.3');
  try {
    await client.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await client.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await client.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await settled();
  } finally { if (!wasVisible) window!.hide(); }
}
async function verifyUpdateStates() {
  assert.equal(await dom('document.querySelector(".runtime-settings").textContent.includes("自动检查并下载更新")'), true);
  assert.equal(await dom('document.querySelector(".runtime-settings").textContent.includes("启动时检查更新")'), false);
  const installsBefore = calls.get('updates.install') ?? 0, cancelledBefore = calls.get('tasks.cancel') ?? 0;
  updateCheckMode = 'download';
  await button('检查更新', '.update-settings'); await until('document.querySelector(".update-settings").getAttribute("aria-busy") === "true"');
  assert.equal(await dom('document.querySelector(".update-settings button.secondary").disabled'), true);
  await screenshot('16a-update-checking');
  await invoke('updates.download'); await until('document.querySelector(".update-download-progress progress")?.value === 40');
  assert.equal(await dom('document.querySelector(".update-progress-copy").textContent.includes("48.0 MB / 120.0 MB")'), true);
  assert.equal(await dom('document.querySelector(".update-settings button.primary") === null'), true);
  const checksBeforeDisabled = calls.get('updates.check') ?? 0;
  await dom('document.querySelector(".update-settings button.secondary").click()');
  assert.equal(calls.get('updates.check'), checksBeforeDisabled, 'A disabled check cannot duplicate a download');
  await screenshot('16b-update-downloading');
  publishUpdate({ ...updateState, status: 'ready', progress: { downloaded: 120 * 1024 * 1024, total: 120 * 1024 * 1024, percent: 100 }, message: '更新已下载并校验，保存工作后可重启更新' });
  finishUpdateCheck?.({ configured: true, checkedAt: now, app: updateArtifact }); finishUpdateCheck = undefined;
  await until('document.querySelector(".update-settings button.primary")?.textContent.includes("重启并更新 1.0.4") && !document.querySelector(".update-settings button.primary").disabled');
  await screenshot('16c-update-ready');
  await button('工作台', '.sidebar'); await until('Boolean(document.querySelector(".home-page"))');
  await dom('document.querySelector(".update-banner button").focus()');
  assert.equal(await dom('document.activeElement === document.querySelector(".update-banner button")'), true);
  await keyboardEnter(); await until('Boolean(document.querySelector(".update-settings"))');
  await dom('window.__updateConfirmations = 0; window.confirm = () => { window.__updateConfirmations++; return true; }; document.querySelector(".update-settings button.primary").focus()');
  assert.equal(await dom('document.activeElement === document.querySelector(".update-settings button.primary")'), true);
  await keyboardEnter(); await until('document.querySelector(".update-settings").getAttribute("aria-busy") === "true"');
  assert.equal(calls.get('updates.install'), installsBefore + 1, 'Restart is mocked, not launched as a real installer');
  assert.equal(await dom('window.__updateConfirmations'), 1); await screenshot('16d-update-installing');
  publishUpdate({ ...initialUpdate(), status: 'error', version: updateArtifact.version, message: '更新下载暂时失败，当前版本仍可正常使用',
    lastInstallError: '上次安装未完成（仅供界面回归测试），未更改原程序和数据。' });
  await until('document.querySelector(".update-settings .update-error[role=alert]")?.textContent.includes("更新下载暂时失败")');
  assert.equal(await dom('document.querySelector(".update-last-error").textContent.includes("上次更新未完成")'), true);
  await screenshot('16e-update-error');
  publishUpdate({ ...initialUpdate(), status: 'available', installMode: 'manual', version: updateArtifact.version, notes: updateArtifact.notes, message: '当前为开发或免安装模式，请先安装正式版' });
  await until('Boolean(document.querySelector(".update-manual-note"))');
  assert.equal(await dom('document.querySelector(".update-settings button.primary") === null'), true); await screenshot('16f-update-manual');
  publishUpdate({ ...initialUpdate(), status: 'disabled', message: '当前授权不支持在线更新，可使用管理员提供的安装包' });
  await until('document.querySelector(".update-settings").textContent.includes("当前授权不支持在线更新")');
  assert.equal(await dom('document.querySelector(".update-banner") === null'), true); await screenshot('16g-update-disabled');
  assert.equal(calls.get('tasks.cancel') ?? 0, cancelledBefore, 'Update UI never cancels business tasks');
  assert.equal(calls.get('updates.install'), installsBefore + 1, 'No install is triggered by status rendering');
  updateCheckMode = 'latest'; publishUpdate(initialUpdate());
  await until('!document.querySelector(".update-manual-note,.update-error,.update-last-error,.update-download-progress,.update-banner")');
}
async function verifyInitialUpdateRace() {
  updateState = initialUpdate(); delaySnapshotOnce = true;
  await reload('active');
  publishUpdate({ ...initialUpdate(), status: 'ready', version: updateArtifact.version, message: '新事件：更新已准备好' });
  await new Promise(resolve => setTimeout(resolve, 1350));
  assert.equal(await dom('document.querySelector(".update-banner")?.textContent.includes("已准备好")'), true, 'A delayed initial snapshot cannot overwrite a later ready event');
  publishUpdate(initialUpdate());
}

async function verifyPractitionerNumberScope() {
  await reload('active');
  await until('document.querySelectorAll(".system-card-title").length === 5');
  await click('.system-card:nth-child(3) .system-card-title');
  await button('编号配置', '.session-box');
  await until('document.querySelectorAll(".number-business").length === 2');
  try {
    numberScope = ['taxi-driver-return'];
    await dom('window.dispatchEvent(new Event("focus"))');
    await until('document.querySelectorAll(".number-business").length === 1 && document.querySelector(".number-business h4").textContent === "出租车驾驶员"', 'only the still-authorized numbering form survives a grant reduction');
    numberScope = [];
    await dom('window.dispatchEvent(new Event("focus"))');
    await until('document.querySelector(".session-box") && !document.querySelector(".practitioner-number-dialog") && !document.querySelector(".session-box").textContent.includes("编号配置")', 'removing both matters closes the dialog and hides its entry');
  } finally { numberScope = undefined; }
}

async function verifyAuthorizationInfo() {
  await reload('inactive');
  await click('.activation-card .authorization-info summary');
  await button('复制设备码', '.authorization-info');
  await until('document.querySelector(".authorization-feedback")?.textContent === "设备码已复制"');
  assert.equal(invocations.filter(call => call.method === 'license.copyIdentifier').at(-1)?.args[0], 'device');

  await reload('active');
  await button('设置', '.sidebar');
  await until('Boolean(document.querySelector("main .authorization-info"))');
  assert.equal(await dom('document.querySelector(".authorization-info").open'), false);
  await click('.authorization-info summary');
  assert.equal(await dom('document.querySelector(".authorization-identifier code")?.textContent'), 'ui-only-fixture');
  await button('复制授权编号', '.authorization-info');
  await until('document.querySelector(".authorization-feedback")?.textContent === "授权编号已复制"');
  assert.equal(invocations.filter(call => call.method === 'license.copyIdentifier').at(-1)?.args[0], 'license');
  scopeAfterManualRefresh = 'equipment-only';
  await button('刷新授权', '.authorization-info');
  await until('document.querySelectorAll(".sidebar .system-nav-toggle").length === 1');
  assert.equal(await dom('document.querySelector(".sidebar .system-nav-toggle").title'), equipment.name);
}

async function verifyEquipmentWorkspace() {
  await reload('equipment-only');
  await until('document.querySelectorAll(".system-nav-toggle").length === 1');
  assert.equal(await dom('document.querySelector(".system-nav-toggle").title'), equipment.name);
  await click('.system-nav-toggle');
  await until('document.querySelectorAll(".return-matter-field select").length === 2');
  assert.deepEqual(await dom('[...document.querySelector(".return-matter-field select").options].map(option => option.value)'),
    [USE_REGISTRATION.id, PERSONNEL_ASSESSMENT.id]);
  await dom(`(() => {
    const choose = (node, value) => {
      node.value = value;
      node.dispatchEvent(new Event('change', { bubbles: true }));
    };
    choose(document.querySelector('.return-matter-field select'), ${JSON.stringify(PERSONNEL_ASSESSMENT.id)});
  })()`);
  await until(`document.querySelector(".return-matter-field select").value === "${PERSONNEL_ASSESSMENT.id}"`);
  await dom(`(() => {
    const city = document.querySelectorAll('.return-matter-field select')[1];
    city.value = '440300';
    city.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await click('.one-click-panel .run-return-button');
  await until('Boolean(document.querySelector(".matter-workspace-tabs button.active")?.textContent.includes("回流任务"))');
  const runCall = invocations.filter(call => call.method === 'matters.run').at(-1);
  assert.deepEqual(runCall?.args, [equipment.id, PERSONNEL_ASSESSMENT.id, { page: 1, pageSize: 200,
    filters: { ...equipment.matters[1].createDefaultContext?.().filters, city: '440300' } }]);
  await button('回流数据', '.matter-workspace-tabs');
  await until('document.querySelectorAll(".publication-actions button:not(:disabled)").length === 2');
  for (const [label, target] of [['导出省执法双公示', 'guangdong-law'], ['导出南山双公示', 'nanshan']]) {
    await button(label);
    await until('Boolean(document.querySelector(".export-notice-path"))');
    assert.equal(invocations.filter(call => call.method === 'records.export').at(-1)?.args[2], target);
  }
}

async function verifyFoodDrugWorkspace() {
  await reload('food-drug-only');
  await until('document.querySelectorAll(".system-nav-toggle").length === 1');
  assert.equal(await dom('document.querySelector(".system-nav-toggle").title'), foodDrug.name);
  await click('.system-nav-toggle');
  await until('document.querySelector(".return-matter-field select")?.options.length === 2');
  assert.deepEqual(await dom('[...document.querySelector(".return-matter-field select").options].map(option => option.value)'),
    [FOOD_PRODUCTION.id, MEDICAL_DEVICE_OPERATION.id]);
  assert.equal(await dom('document.querySelector(".return-date-fields").innerText.includes("办结开始日期")'), true);
  await click('.one-click-panel .run-return-button');
  await until('Boolean(document.querySelector(".matter-workspace-tabs button.active")?.textContent.includes("回流任务"))');
  assert.deepEqual(invocations.filter(call => call.method === 'matters.run').at(-1)?.args, [
    foodDrug.id, FOOD_PRODUCTION.id, foodDrug.matters[0].createDefaultContext!(),
  ]);
  await button('回流数据', '.matter-workspace-tabs');
  await until('document.querySelectorAll(".publication-actions button:not(:disabled)").length === 2');
  assert.deepEqual(await dom('[...document.querySelectorAll(".publication-actions button")].map(item => item.textContent.trim())'),
    ['导出省执法双公示', '导出南山双公示']);
}

async function run() {
  profile = process.env.DATA_FUSION_UI_TEST_PROFILE || await mkdtemp(join(tmpdir(), 'fusion-ui-redesign-')); app.setPath('userData', profile);
  await app.whenReady();
  outputDirectory = resolve('.tmp', `ui-redesign-${new Date().toISOString().replace(/[:.]/g, '-')}`); await mkdir(outputDirectory, { recursive: true });
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { preload: resolve('.tmp/ui-redesign-preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => { blockedRequests.push(details.url); callback({ cancel: true }); });
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  window.webContents.on('render-process-gone', (_event, details) => errors.push(`renderer gone: ${details.reason}`));
  ipcMain.handle('ui-redesign:invoke', (_event, method, ...args) => invoke(method, ...args));
  await verifyPractitionerNumberScope();
  await verifyLedgerPreferences();
  await verifyAuthorizationInfo();
  await verifyEquipmentWorkspace();
  await verifyFoodDrugWorkspace();
  await runViewport(1440, 900); await runViewport(1180, 720);
  assertAuthorizedReads(0, 'Complete authorization regression');
  assert.equal(errors.length, 0, `Renderer errors: ${errors.join('\n')}`); assert.equal(blockedRequests.length, 0, `UI tried to access external resources: ${blockedRequests.join(', ')}`);
  const knownSystems = [...ids, ...licenseSystems.map(system => system.id)];
  assert(localRecordQueries.every(query => typeof query.systemId === 'string' && knownSystems.includes(query.systemId)
    && matters(query.systemId).some(matter => matter.id === query.matterId)),
  `Every local record read must retain matching system/matter scope: ${JSON.stringify(localRecordQueries)}`);
  assert.equal(actualFontSamples.length, coverage.length, 'Each screenshot must include an actual-platform-font sample');
  await writeFile(join(outputDirectory, 'report.json'), JSON.stringify({ status: 'pass', coverage, visualMetrics, actualFontSamples, localRecordQueries, queryContexts, calls: Object.fromEntries(calls), invocations, errors, blockedRequests,
    captureMethod: 'Test window only: showInactive, wait 300 ms, Chromium Page.captureScreenshot fromSurface=false, hide',
    keyboardMethod: 'Modal cancelable KeyboardEvents plus Chromium CDP Enter on focused update buttons in this test window only; OS focus never requested',
    automaticUpdateStates: ['checking','downloading','ready','installing','error','manual','disabled'], updateInstallerMocked: true,
    isolation: 'unique temporary profile, memory-only APIs, network blocked' }, null, 2));
  console.log(`PASS: ${coverage.length} page/state screenshots at two sizes; compact 112px cards and first-screen recent tasks, one-line menus, no hero tiles, 44px left return action and five-row local preview, full-width market query/settings, authorized-only component tables, ${actualFontSamples.length} actual platform-font samples; activation, five systems, query/sync, tasks, exports, edit/history, Modal keyboard/focus and 31-field Word evidence checks; no-tool, tools-only, single-system, empty grants and live authorization reductions. No unauthorized feature reads, network requests or renderer errors.\nArtifacts: ${outputDirectory}`);
}
async function finish(code: number) {
  if (code && outputDirectory) { await writeFile(join(outputDirectory, 'failure.json'), JSON.stringify({ status: 'fail', failureReason, coverage, visualMetrics, actualFontSamples, localRecordQueries, errors, blockedRequests, calls: Object.fromEntries(calls) }, null, 2)).catch(() => {}); if (window && !window.isDestroyed()) await capture().then(image => writeFile(join(outputDirectory, 'failure.png'), image)).catch(() => {}); }
  window?.destroy();
  // Only this test-created child of the OS temp directory may be removed.
  if (!process.env.DATA_FUSION_UI_TEST_PROFILE && profile && dirname(resolve(profile)) === resolve(tmpdir()) && profile.startsWith(join(tmpdir(), 'fusion-ui-redesign-'))) await rm(profile, { recursive: true, force: true }).catch(() => {});
  app.exit(code);
}
void run().then(() => finish(0)).catch(error => { failureReason = error instanceof Error ? error.message : String(error); console.error(error); return finish(1); });
