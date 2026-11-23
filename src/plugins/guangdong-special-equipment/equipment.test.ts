import { expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalExportService } from '../../core/export/local-export-service';
import type { StoredRecord } from '../../core/storage/types';
import type { BrowserAuthObservation } from '../../main/browser-auth';
import { createSpecialEquipmentPlugin } from './index';
import {
  EQUIPMENT_API, EQUIPMENT_HOME_URL, EQUIPMENT_LOGIN_URL, EQUIPMENT_SYSTEM_ID,
  PERSONNEL_ASSESSMENT, USE_REGISTRATION,
} from './catalog';

const { observe } = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock('electron', () => ({ session: {} }));
vi.mock('../../main/browser-auth', () => ({ observeBrowserAuth: observe, clearBrowserAuth: vi.fn(async () => {}) }));

const day = '2026-11-20';
const context = { page: 1, pageSize: 200, filters: { startDate: day, endDate: day, city: '441300' } };
const json = (data: unknown) => new Response(JSON.stringify({ code: 200, data }));
const page = (rows: unknown[], total = rows.length) => json({ rows, total });
const token = 'fixture-token';
const workbench = () => Response.json({ status: '200', success: true, data: {
  areaCode: '441300', registerPermits: {}, examOperatorPermits: {},
} });

async function connectedPlugin(fetcher: (url: string, init: RequestInit) => Promise<Response>) {
  const plugin = createSpecialEquipmentPlugin({ fetcher, minimumIntervalMs: 0, now: () => Date.parse(day) });
  await plugin.initialize();
  const observer = observe.mock.calls.at(-1)?.[0] as BrowserAuthObservation;
  expect(observer.urlPattern).toBe(EQUIPMENT_API + '*');
  expect(observer.header).toBe('token');
  observer.accept(token);
  return { plugin, observer };
}

it('maps all equipment including a second linked page and exports the source-specific document numbers', async () => {
  const requests: Array<{ path: string; params: unknown }> = [];
  const items = Array.from({ length: 11 }, (_, i) => ({ id: `EQ-${i}`, certCode: `登记证-${i}`, equKindValue: '电梯', saPerson: '测试法人' }));
  const { plugin } = await connectedPlugin(async (url, init) => {
    expect(new Headers(init.headers).get('Token')).toBe(token);
    const { pathname, searchParams } = new URL(url);
    const path = pathname.split('/semms/')[1];
    const params = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, params });
    if (path === 'registerPreserve/queryMultipleTask/1/200') {
      return params.startDecisionTime === day ? page([{
        businessId: 'USE-1', applyType: '2', nameOfUser: '测试登记企业', socialCreditCodeOfUser: '91440300123456789Q',
        grantGov: '惠州市惠城区市场监督管理局', decisionTime: day + ' 08:20:10',
      }]) : page([]);
    }
    if (path.startsWith('registerPreserveEqu/showEquInfo/')) {
      expect(searchParams.get('businessId')).toBe('USE-1');
      expect(searchParams.get('applyType')).toBe('2');
      return page(path.endsWith('/1/10') ? items.slice(0, 10) : items.slice(10), 11);
    }
    expect(path).toBe('registerDocumentAttachment/findAttachmentList');
    expect(searchParams.get('status')).toBe('归档');
    expect(init.method).toBe('POST');
    return json([{ fileName: '准予行政许可决定书.pdf', number: '许可决定-1' }]);
  });
  const matter = plugin.matters.find(item => item.id === USE_REGISTRATION.id)!;
  const result = await matter.query({ ...context, filters: { ...context.filters, endDate: '2026-11-21' } });
  expect(result.total).toBe(11);
  expect(new Set(result.rows.map(row => row.sourceRecordId)).size).toBe(11);
  expect(requests.filter(request => request.path.startsWith('registerPreserve/')).map(request => request.params)).toEqual([
    { startDecisionTime: day, endDecisionTime: day, equLocateCityValue: '441300' },
    { startDecisionTime: '2026-11-21', endDecisionTime: '2026-11-21', equLocateCityValue: '441300' },
  ]);
  expect(result.rows[10]).toMatchObject({ xkXkbh: '登记证-10', xkWsh: '登记证-10', provincialDocumentNumber: '许可决定-1',
    xkNr: '电梯更名变更', ajmc: '测试登记企业电梯更名变更', xkXkjgdm: '11441302351971239H', xkFrdb: '测试法人',
    xkJdrq: day, xkYxqz: day, xkYxqzi: '2099-12-31' });
  const records: StoredRecord[] = result.rows.map((data, i) => ({ systemId: plugin.id, matterId: matter.id, recordKey: String(i),
    data, updatedAt: 1, firstSeenAt: 1 }));
  const directory = await mkdtemp(join(tmpdir(), 'equipment-export-'));
  try {
    const service = new LocalExportService();
    for (const [target, sheet, row, docColumn, contentColumn, document, content] of [
      ['nanshan', 'Sheet1', 2, 15, 19, '登记证-0', '电梯更名变更'],
      ['guangdong-law', '行政许可案件导入模板', 5, 12, 18, '许可决定-1', '测试登记企业电梯更名变更'],
    ] as const) {
      const file = join(directory, target + '.xlsx');
      expect(await service.export(file, 'xlsx', records, undefined, undefined, target)).toMatchObject({ rowCount: 11, warningCount: 0 });
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(file, { ignoreNodes: ['dataValidations'] });
      const first = workbook.getWorksheet(sheet)!.getRow(row);
      expect(first.getCell(docColumn).value).toBe(document);
      expect(first.getCell(contentColumn).value).toBe(content);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('uses personnel field names and details, excludes denied cases and leaves unknown authority codes blank', async () => {
  const calls: string[] = [];
  const { plugin } = await connectedPlugin(async (url, init) => {
    const path = url.split('/semms/')[1];
    calls.push(path);
    if (path === 'exam/queryMultipleTask/1/200') {
      expect(JSON.parse(String(init.body))).toEqual({ startDecideTime: day, endDecideTime: day, isDisclosure: '1', equLocateCityValue: '440300' });
      return page(['PERSONNEL-1', 'DENIED-1'].map(id => ({ id, name: '测试人', cardNo: 'TEST-ID-01', approvalTime: day,
        operationItemValue: '锅炉作业（G1）', acceptOrgName: '深圳市市场监督管理局' })));
    }
    expect(init.method).toBe('GET');
    if (path === 'exam/findFile/PERSONNEL-1') return json([{ fileName: '准予行政许可决定书（作业人员）.pdf', number: '作业许可-1' }]);
    if (path === 'exam/findFile/DENIED-1') return json([{ fileName: '不准予行政许可决定书(作业人员).pdf', number: '不予许可-1' }]);
    expect(path).toBe('exam/findApplicationById/PERSONNEL-1');
    return json({ effectiveDateStart: day, effectiveDateEnd: '2030-11-19 00:00:00' });
  });
  const result = await plugin.matters.find(matter => matter.id === PERSONNEL_ASSESSMENT.id)!
    .query({ ...context, filters: { ...context.filters, city: '440300' } });
  expect(result.total).toBe(1);
  expect(result.rows[0]).toMatchObject({ sourceRecordId: 'PERSONNEL-1', xkXdrLb: '自然人', xkXdrZjhm: 'TEST-ID-01',
    xkNr: '锅炉作业（G1）', xkWsh: '作业许可-1', xkYxqz: day, xkYxqzi: '2030-11-19', xkXkjg: '深圳市市场监督管理局', xkXkjgdm: '' });
  expect(calls).not.toContain('exam/findApplicationById/DENIED-1');
});

it('monitors the workbench and invalidates the session on explicit rejection or returning to SSO', async () => {
  let status = 200;
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(EQUIPMENT_API + 'workbench/info');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('Token')).toBe(true);
    return status === 200 ? workbench() : new Response(null, { status });
  });
  const { plugin, observer } = await connectedPlugin(fetcher);
  const recovery = plugin.sessionRecovery!;
  expect(new URL(EQUIPMENT_LOGIN_URL).searchParams.get('redirect_uri')).toBe(EQUIPMENT_HOME_URL + 'api/oauth/gov/new/code');
  plugin.loginPage!.onNavigate!(EQUIPMENT_HOME_URL + 'index.html?unused=discard#/home');
  plugin.loginPage!.onNavigate!(EQUIPMENT_HOME_URL + 'api/oauth/gov/new/code?code=fixture');
  expect(await recovery.snapshot()).toEqual({ token, home: EQUIPMENT_HOME_URL + 'index.html#/home' });
  expect(await plugin.getSessionState()).toMatchObject({ systemId: EQUIPMENT_SYSTEM_ID, status: 'authenticated' });
  status = 401;
  expect(await plugin.getSessionState()).toMatchObject({ status: 'expired' });
  observer.accept(token);
  expect(await recovery.snapshot()).toBeNull();
  plugin.loginPage!.onLoginPageChange!(true);
  observer.accept('wrong-still-on-sso');
  expect(observer.credentialGeneration?.()).toBeNull();
  expect(await plugin.getSessionState()).toMatchObject({ status: 'logged-out' });
  plugin.loginPage!.onLoginPageChange!(false);
  observer.accept('new-fixture-token');
  status = 200;
  expect(await plugin.getSessionState()).toMatchObject({ status: 'authenticated' });
  const saved = (await recovery.snapshot())!;
  recovery.restore({ ...saved, token, probeKind: 'personnel' });
  expect(await plugin.getSessionState()).toMatchObject({ status: 'authenticated' });
});

it('keeps a workbench session valid when a matter denies access and separates verification failures from expiration', async () => {
  let workbenchReply = workbench;
  const { plugin, observer } = await connectedPlugin(async url =>
    url === EQUIPMENT_API + 'workbench/info' ? workbenchReply() : new Response(null, { status: 403 }));
  expect(await plugin.getSessionState()).toMatchObject({ status: 'authenticated' });
  await expect(plugin.matters[0].query(context)).rejects.toThrow('账号权限');
  observer.clear();
  expect(await plugin.getSessionState()).toMatchObject({ status: 'authenticated' });

  workbenchReply = () => Response.json({ status: '200', success: true, data: { rows: [] } });
  expect(await plugin.getSessionState()).toMatchObject({ status: 'unverified' });
  expect((await plugin.sessionRecovery!.snapshot())?.token).toBe(token);
  workbenchReply = () => Response.json({ status: '401', success: false, data: null });
  expect(await plugin.getSessionState()).toMatchObject({ status: 'expired' });
  expect(await plugin.sessionRecovery!.snapshot()).toBeNull();
});

it('fails a repeated page rather than returning a partial batch', async () => {
  const { plugin } = await connectedPlugin(async url => {
    if (url.includes('/exam/queryMultipleTask/')) return page(Array.from({ length: 200 }, (_, i) => ({ id: `ID-${i}` })), 201);
    throw new Error('Details must wait for a complete application list');
  });
  await expect(plugin.matters[1].query(context)).rejects.toThrow('分页重复');
});
