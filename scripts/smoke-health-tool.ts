import { app, BrowserWindow, dialog } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { HealthPublicityService } from '../src/core/tools/health-publicity/service';
import { NodeSqliteDriver } from '../src/core/storage/database';
import { appRuntime } from '../src/main/runtime';
import { registerIpcHandlers } from '../src/main/ipc';
import { DOUBLE_PUBLICITY_TEMPLATE } from '../src/core/double-publicity/template';
import { PERMIT_SHEET_NAME } from '../src/core/double-publicity/permit-workbook';

let window: BrowserWindow | undefined, directory = '', database: NodeSqliteDriver | undefined;
const paths = process.argv.slice(2).filter(value => value.toLowerCase().endsWith('.docx'));
app.commandLine.appendSwitch('disable-gpu');
const dom = (script: string) => window!.webContents.executeJavaScript(script);
async function until(script: string) {
  const until = Date.now() + 15000;
  while (Date.now() < until) { if (await dom(script)) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(`UI assertion timed out: ${script}`);
}
async function run() {
  assert.equal(paths.length, 4, 'Pass the four authorized Word sample paths');
  directory = await mkdtemp(join(tmpdir(), 'fusion-health-ui-')); app.setPath('userData', directory);
  await app.whenReady();
  database = new NodeSqliteDriver(join(directory, 'test.sqlite'));
  const service = new HealthPublicityService(database); await service.initialize();
  const grant = { licenseId: 'isolated-tools-only-test', allowedSystems: [], allowedTools: ['health-publicity'], allowExport: true, expiresAt: Date.now() + 60000 };
  Object.assign(appRuntime, { healthPublicityService: service, currentGrant: async () => grant,
    license: { getStatus: async () => ({ state: 'active', deviceId: 'fixture', grant }) }, getSettings: async () => ({ autoCheckUpdates: false }) });
  Object.assign(dialog, { showOpenDialog: async () => ({ canceled: false, filePaths: paths }) });
  window = new BrowserWindow({ show: false, width: 1440, height: 980, webPreferences: { preload: resolve('out/preload/index.js'), contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
  registerIpcHandlers(() => window?.webContents.id);
  await window.loadFile(resolve('out/renderer/index.html'));
  await until('document.querySelector("h1")?.textContent === "卫健局双公示工具"');
  assert.equal(await dom('document.querySelectorAll(".system-nav-toggle").length'), 0);
  await dom('[...document.querySelectorAll("button")].find(button=>button.textContent==="导入 Word 批复").click()');
  await until('document.querySelectorAll(".health-table tbody tr").length === 4');
  const state = await service.state(); assert.equal(state.documents.length, 4);
  const byNumber = (number: string) => state.documents.find(doc => doc.data.xkWsh.includes(number + '号'))!;
  assert.equal(byNumber('230').data.xkXdrShxym, '');
  assert.equal(byNumber('231').data.xkXdrMc, '深圳瑞光门诊部');
  assert.equal(byNumber('227').data.xkJdrq, '2026-09-14');
  assert.equal(byNumber('163').kind, '注销登记');
  for (const doc of state.documents) { assert.equal(doc.data.xkFrdb, ''); assert.ok(doc.data.xkNr); assert.equal(doc.data.xkXklb, ''); }
  const records = await service.records(state.documents.map(doc => doc.id));
  const output = join(directory, '行政许可-卫健局双公示工具-测试.xlsx');
  const result = await appRuntime.exportHealthDocuments(records.map(record => record.recordKey), output, async report => { assert.equal(report.invalid, 4); return true; });
  assert.equal(result?.rowCount, 4);
  const book = await new ExcelJS.Workbook().xlsx.readFile(output, { ignoreNodes: ['dataValidations'] }); assert.equal(book.getWorksheet(PERMIT_SHEET_NAME)!.rowCount, 6);
  records.forEach((record, index) => DOUBLE_PUBLICITY_TEMPLATE.forEach(([key], column) => {
    assert.equal(String(book.getWorksheet(PERMIT_SHEET_NAME)!.getRow(index + 3).getCell(column + 2).value ?? ''), String(record.data[key] ?? ''), `export field ${key}`);
  }));
  await writeFile(resolve('private/health-publicity-ui-20261017.png'), (await window.webContents.capturePage()).toPNG());
  await dom('document.querySelector(".health-table tbody tr .text-button").click()');
  await until('Boolean(document.querySelector(".health-editor"))');
  assert.equal(await dom('document.querySelectorAll(".health-fields .health-field").length'), 31);
  assert.equal(await dom('document.querySelector(".health-source pre").textContent.length > 100'), true);
  await dom('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await new Promise(resolve => setTimeout(resolve, 120));
  await writeFile(resolve('private/health-publicity-editor-20261017.png'), (await window.webContents.capturePage()).toPNG());
  console.log('PASS: real four DOCX files; tools-only UI and secure IPC import; rename, parent-code exclusion, signed date and cancellation; 4-row flagged export; 31 editable fields and original evidence.');
}
async function finish(code: number) {
  window?.destroy(); await database?.close();
  if (directory && dirname(resolve(directory)) === resolve(tmpdir()) && directory.startsWith(join(tmpdir(), 'fusion-health-ui-'))) await rm(directory, { recursive: true, force: true });
  app.exit(code);
}
void run().then(() => finish(0)).catch(error => { console.error(error); return finish(1); });
