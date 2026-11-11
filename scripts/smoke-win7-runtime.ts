import '../src/compat/win7/bootstrap';
import { app, BrowserWindow, session, safeStorage } from 'electron';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { NodeSqliteDriver } from '../src/core/storage/database';
import { LocalExportService } from '../src/core/export/local-export-service';
import { SecureSessionStore } from '../src/main/session-store';
import { LoginTabController } from '../src/main/login-tab';
import type { StoredRecord } from '../src/core/storage/types';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readHealthDocx } from '../src/core/tools/health-publicity/parser';

const directory = resolve('.tmp/win7-runtime-smoke');
app.setPath('userData', join(directory, 'profile'));
const report: Record<string, unknown> = { electron: process.versions.electron, node: process.versions.node,
  actualHost: process.getSystemVersion(), win7HardwareTested: false };
const server = createServer((request, response) => {
  if (request.url === '/login') { response.setHeader('set-cookie', 'fixtureCookie=fixture-only; HttpOnly; Path=/'); response.end('ok'); return; }
  if (request.url === '/redirect') { response.writeHead(302, { location: '/check' }); response.end(); return; }
  if (request.url === '/slow') { const timer = setTimeout(() => response.end('too late'), 5000); request.on('close', () => clearTimeout(timer)); return; }
  if (request.url === '/check') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ valid: request.headers.cookie?.includes('fixtureCookie=fixture-only') })); return; }
  response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>Compatibility fixture</title><p>本地兼容测试</p>');
});
let window: BrowserWindow | undefined;
const tabs = new LoginTabController();
async function run() {
  await app.whenReady(); await mkdir(directory, { recursive: true });
  assert.equal(process.versions.electron, '22.3.27'); assert.equal(typeof globalThis.crypto.randomUUID(), 'string');
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = session.fromPartition('persist:win7-network-fixture');
  assert.equal((await browser.fetch(`${origin}/login`, { credentials: 'include' })).status, 200);
  assert((await (await browser.fetch(`${origin}/check`, { credentials: 'include' })).json() as { valid: boolean }).valid);
  const manual = await browser.fetch(`${origin}/redirect`, { redirect: 'manual', credentials: 'include' }); assert.equal(manual.status, 302);
  assert(manual.headers.get('location')?.endsWith('/check'));
  await assert.rejects(browser.fetch(`${origin}/redirect`, { redirect: 'error' }));
  assert((await (await browser.fetch(`${origin}/redirect`, { credentials: 'include' })).json() as { valid: boolean }).valid);
  await assert.rejects(browser.fetch(`${origin}/slow`, { signal: AbortSignal.timeout(40) }));
  report.sessionFetch = { cookies: true, manualRedirect: true, rejectedRedirect: true, followedRedirect: true, timeout: true };
  const database = new NodeSqliteDriver(join(directory, 'fixture.sqlite'));
  await database.exec('CREATE TABLE IF NOT EXISTS fixture (id INTEGER PRIMARY KEY,value TEXT)'); await database.exec('DELETE FROM fixture');
  await database.transaction(async () => { await database.run('INSERT INTO fixture(value) VALUES(?)', ['中文数据']); });
  await assert.rejects(database.transaction(async () => { await database.run('INSERT INTO fixture(value) VALUES(?)', ['rollback']); throw new Error('rollback'); }));
  assert.equal((await database.all('SELECT * FROM fixture')).length, 1); await database.close();
  const reopened = new NodeSqliteDriver(join(directory, 'fixture.sqlite')); assert.equal((await reopened.get<{ value: string }>('SELECT value FROM fixture'))?.value, '中文数据'); await reopened.close();
  report.sqlite = { persisted: true, commit: true, rollback: true };
  assert(safeStorage.isEncryptionAvailable());
  const vault = new SecureSessionStore(join(directory, 'fixture.secure.json')); await vault.set('fixture', 'non-production-fixture-secret');
  assert.equal(await vault.get('fixture'), 'non-production-fixture-secret');
  assert(!(await readFile(join(directory, 'fixture.secure.json'), 'utf8')).includes('non-production-fixture-secret'));
  report.encryptedStorage = true;
  window = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const page = (id: string) => ({ id, name: id, loginPage: { url: `${origin}/${id}`, allowedOrigin: origin, partition: `persist:${id}` } });
  tabs.open(window, page('source-one')); tabs.open(window, page('source-two'));
  const deadline = Date.now() + 10000;
  while (tabs.state().tabs.some(tab => tab.loading) && Date.now() < deadline) await new Promise(done => setTimeout(done, 30));
  assert.equal(tabs.state().tabs.length, 2); assert(tabs.state().tabs.every(tab => !tab.loading && !tab.error));
  tabs.activate('source-one'); tabs.activate('source-two'); tabs.activate(null);
  report.sourceTabs = { independent: true, browserView: true, sandboxed: true };
  const data: Record<string, unknown> = { xzxkmc: '兼容性测试许可', xkXdrMc: '测试有限公司', xkXdrLb: '法人及非法人组织',
    xkXdrShxym: '91440300123456789X', xkFrdb: '测试法人', xkXkws: '测试决定书', xkWsh: 'TEST-001', xkXklb: '普通',
    xkNr: '本地虚构数据', xkJdrq: '2026-11-10', xkYxqz: '2026-11-10', xkYxqzi: '2027-11-10',
    xkXkjg: '测试机关', xkXkjgdm: '11440305007544177A', xkZt: '有效', xkLydw: '测试机关', xkLydwdm: '11440305007544177A' };
  const record = { systemId: 'oversize-transport', matterId: 'oversize-transport-return', recordKey: 'fixture', data, updatedAt: Date.now() } as StoredRecord;
  const path = join(directory, `行政许可-兼容测试-${Date.now()}.xlsx`);
  const exported = await new LocalExportService().export(path, 'xlsx', [record], async () => { throw new Error('Fixture must have no missing fields'); });
  assert.equal(exported?.rowCount, 1);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path); assert.equal(workbook.worksheets[0].getCell('K3').value, '测试法人');
  report.excel = { generated: true, readBack: true, legalPerson: true };
  const paragraphs = ['深南卫健医政〔2026〕227号', '南山区卫生健康局关于同意测试中医门诊部变更登记注册的批复',
    '赖某（测试中医门诊部）：', '你提交的关于测试中医门诊部（统一社会信用代码：91440300MAA5DL1LTT）变更登记注册申请材料收悉。经审核，同意有关业务办理人由张某变更为赖某。',
    '此复。', '深圳市南山区卫生健康局', '2026年9月14日', '公开方式：主动公开'];
  const docx = new JSZip(); docx.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  const parsed = await readHealthDocx(await docx.generateAsync({ type: 'nodebuffer' }), '兼容测试.docx');
  assert.equal(parsed.data.xkXdrMc, '测试中医门诊部'); assert.equal(parsed.data.xkXdrShxym, '91440300MAA5DL1LTT'); assert.equal(parsed.data.xkJdrq, '2026-09-14');
  report.wordParser = true;
  const health = await fetch('https://193.112.96.168/api/health', { signal: AbortSignal.timeout(10000) });
  assert(health.ok); assert.equal((await health.json() as { status: string }).status, 'ok'); report.backendHttps = true;
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, ...report }));
  tabs.close(); window.destroy(); server.close(); app.exit(0);
}
void run().catch(async error => { console.error('Compatibility runtime smoke failed', error); try { tabs.close(); } catch {} try { window?.destroy(); } catch {} server.close();
  await writeFile(join(directory, 'failure.json'), JSON.stringify({ ...report, error: error.message }, null, 2)).catch(() => {}); app.exit(1); });
