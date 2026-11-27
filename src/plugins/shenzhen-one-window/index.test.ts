import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ session: {} }));
import { AppError } from '../../core/errors/app-error';
import { ONE_WINDOW_LIST_PATH, ONE_WINDOW_MATTERS, ONE_WINDOW_ORIGIN, ONE_WINDOW_WORKSPACE_PATH } from './catalog';
import { OneWindowClient } from './client';
import { createOneWindowPlugin } from './index';
import { oneWindowDetailLinks, parseOneWindowHtml, sanitizeOneWindowData } from './parser';
import { mergeOneWindowRecord, normalizeOneWindowFilters, queryOneWindow } from './query';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const html = (value: string) => new Response(value, { headers: { 'content-type': 'text/html' } });
const context = { page: 1, pageSize: 1, filters: { dateType: 'all', state: '' } };

function fixture(options: { loginHtml?: boolean; mismatch?: boolean; missingDetail?: boolean; failBase?: boolean;
  repeatedList?: boolean; relatedPages?: boolean; expiredDetail?: boolean } = {}) {
  const requests: Array<{ url: URL; body: string; method: string }> = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const address = new URL(url), body = String(init.body ?? '');
    requests.push({ url: address, body, method: init.method ?? 'GET' });
    const path = address.pathname;
    if (options.loginHtml) return html('<input id="password"><input id="loginBtn">');
    if (path === ONE_WINDOW_WORKSPACE_PATH) return html('<input id="orgId" value="fixture-organization"><script>var from="";var idJDTB="";var isprivilege="";var usedFor="";var endpoint="accept/monitor/allbusiness/queryAll";formatBusinessState(\'[\{"CODE":"15","NAME":"受理通过"\}]\',state);</script>');
    if (path === ONE_WINDOW_LIST_PATH) {
      const params = new URLSearchParams(body), name = decodeURIComponent(params.get('itemname') || '');
      const index = options.repeatedList ? 1 : Number(params.get('page'));
      const matterName = options.mismatch ? '另外一个业务' : name;
      return json({ records: 2, total: 2, page: index, rows: [{ cell: { BSNUM: 'fixture-' + index,
        RECEIVE_NUMBER: 'fixture-receive-' + index, ITEM_NAME: matterName, STATE: '15', APPLICANT: '合成申请单位', ORG_NAME: '合成办理部门' } }] });
    }
    if (path.endsWith('/completework/detail')) {
      if (options.expiredDetail) return new Response(null, { status: 302, headers: { location: '/Accept/login' } });
      if (options.missingDetail) return html('<main>无此业务详情</main>');
      const bsnum = address.searchParams.get('bsnum');
      return html(`<script>
        $("#base").load("/Accept/accept/worktodolist/businessBase?itemId=fixture-item&objectCode=fixture-org&objecType=3&busNum=${bsnum}");
        $("#base").load("/Accept/accept/worktodolist/businessBase?itemId=fixture-item&objectCode=fixture-org&objecType=3");
        $("#item").load("/Accept/accept/worktodolist/itemInfo?itemId=fixture-item&caseId=fixture-case&busNum=${bsnum}");
        $("#form").load("/Accept/accept/worktodolist/businessInfo?formId=fixture-form&dataId=fixture-data&busNum=${bsnum}");
        $("#opinion").load("/Accept/accept/worktodolist/businessOpinion?busNum=${bsnum}&itemId=fixture-item&state=");
        </script>`);
    }
    if (path.endsWith('/businessBase')) {
      if (options.failBase) return new Response('fixture transient', { status: 503 });
      return html('<table><tr><th>法定代表人：</th><td><input id="LEGAL_PERSON" type="checkbox">合成负责人</td><th>组织机构名称：</th><td>合成单位</td></tr></table>');
    }
    if (path.endsWith('/itemInfo')) return html('<table><tr><th>事项名称：</th><td>合成事项</td></tr></table>');
    if (path.endsWith('/businessOpinion')) return html('<div>合成办理意见，源详情无结构表格</div>');
    if (path.endsWith('/businessInfo')) return html('<script>var iframeUrl = "http://10.248.79.52/t/cform/form/view?token=fixture-form-token&formId=fixture-form&formDataId=fixture%2Bencrypted";</script>');
    if (path.endsWith('/service/formData')) return json({ state: 1, row: { formName: '合成电子表单', formVersionId: 'fixture-v1',
      accessToken: 'never-serialize-this', data: JSON.stringify({ TongYiSheHuiXinYongDaiMa: 'SYNTHETIC-CREDIT', OperatorName: '合成法定代表人',
        GuangGaoLeiBie: 'code1', XingShiCaiZhiJiGuiGe: [{ code0: 'code3', code4: 12 }, { code0: 'code1', code4: 24 }],
        UntypedSourceField: { nested: '原始字段保留' } }) } });
    if (path.endsWith('/service/info')) return json({ state: 1, row: { name: '合成电子表单', content: JSON.stringify({ content: [
      { props: { title: '广告类别', keyCode: 'GuangGaoLeiBie', optionVal: { data: [{ value: 'code1', label: '商业性广告' }] } } },
      { props: { title: '广告形式', keyCode: 'code0', optionVal: { data: [{ value: 'code1', label: '电子显示屏' }, { value: 'code3', label: '灯箱' }] } } },
    ] }) } });
    if (path.endsWith('queryMaterialNew') && options.relatedPages) {
      const page = JSON.parse(body).page;
      return json({ state: 1, total: 101, list: Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
        ID: 'fixture-material-' + ((page - 1) * 100 + index), NAME: '合成材料',
      })) });
    }
    if (path.endsWith('queryMaterialNew') || path.endsWith('queryWorkTodoFile')) return json({ state: 1, total: 1,
      list: [{ NAME: '合成文件目录', accessToken: 'do-not-retain', URL: '/document?id=fixture&accessToken=private' }] });
    if (/queryLicenselist|queryprocefilelist|busiPrintList/.test(path)) return json({ total: 0, records: 0, page: 1, rows: [] });
    throw new Error('Unexpected fixture route ' + path);
  });
  const client = new OneWindowClient({ fetcher, minimumIntervalMs: 0,
    cookieReader: async () => [{ name: 'webfinal.session.id', value: 'fixture-session' }] });
  return { client, fetcher, requests };
}

describe('Shenzhen one-window full business details', () => {
  it.each(ONE_WINDOW_MATTERS)('collects every page and full form/repeating data for $name only', async matter => {
    const { client, requests } = fixture();
    const result = await queryOneWindow(client, matter, context, 123456);
    expect(result.total).toBe(2);
    expect(result.rows.map(row => row.bsnum)).toEqual(['fixture-1','fixture-2']);
    const record = result.rows[0];
    expect(record).toMatchObject({ matterName: matter.name, detailStatus: 'complete', collectedAt: 123456,
      creditCode: 'SYNTHETIC-CREDIT', legalPerson: '合成法定代表人', statusLabel: '受理通过', detailFailures: [] });
    expect(record.details.form.data).toMatchObject({ data: { GuangGaoLeiBie: 'code1',
      XingShiCaiZhiJiGuiGe: [{ code0: 'code3', code4: 12 }, { code0: 'code1', code4: 24 }],
      UntypedSourceField: { nested: '原始字段保留' } }, displayData: { GuangGaoLeiBie: '商业性广告',
        XingShiCaiZhiJiGuiGe: [{ code0: '灯箱', code4: 12 }, { code0: '电子显示屏', code4: 24 }] } });
    expect(record.details.opinions.data).toMatchObject({ text: '合成办理意见，源详情无结构表格' });
    expect(JSON.stringify(record)).not.toMatch(/never-serialize-this|fixture-form-token|do-not-retain|accessToken/);
    const list = requests.filter(req => req.url.pathname === ONE_WINDOW_LIST_PATH);
    expect(list).toHaveLength(2);
    for (const req of list) {
      const params = new URLSearchParams(req.body);
      expect(decodeURIComponent(params.get('itemname')!)).toBe(matter.name);
      expect(params.get('start')).toBe(''); expect(params.get('end')).toBe('');
      expect(req.url.searchParams.get('orgId')).toBe('fixture-organization');
    }
    const form = requests.find(req => req.url.pathname.endsWith('/service/formData'))!;
    expect(form.url.searchParams.get('accessToken')).toBe('fixture-form-token');
    expect(form.url.searchParams.get('formDataId')).toBe('fixture+encrypted');
    expect(requests.every(req => req.url.origin === ONE_WINDOW_ORIGIN)).toBe(true);
  });

  it('binds received and finished dates to their separate source fields', async () => {
    for (const dateType of ['received','finished']) {
      const f = fixture();
      await queryOneWindow(f.client, ONE_WINDOW_MATTERS[0], { ...context,
        filters: { dateType, startDate: '2026-11-01', endDate: '2026-11-24', state: '4' } });
      const params = new URLSearchParams(f.requests.find(req => req.url.pathname === ONE_WINDOW_LIST_PATH)!.body);
      expect(params.get('curState')).toBe('4');
      expect(params.get(dateType === 'received' ? 'start' : 'bjstart')).toBe('2026-11-01');
      expect(params.get(dateType === 'received' ? 'bjstart' : 'start')).toBe('');
    }
    expect(() => normalizeOneWindowFilters({ dateType: 'received', startDate: '2026-02-30', endDate: '2026-03-01' })).toThrow('日期范围');
  });

  it('rejects other matters and a successful HTTP response that is actually the login page', async () => {
    await expect(queryOneWindow(fixture({ mismatch: true }).client, ONE_WINDOW_MATTERS[0], context)).rejects.toThrow('其他事项');
    await expect(fixture({ loginHtml: true }).client.validateSession(new AbortController().signal)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(fixture().client.list({ id: 'unknown', name: '其他事项' }, normalizeOneWindowFilters({}), 1, 1)).rejects.toMatchObject({ code: 'QUERY_INVALID' });
  });

  it('keeps details partial and preserves previous content when a section or wrapper fails', async () => {
    const complete = (await queryOneWindow(fixture().client, ONE_WINDOW_MATTERS[0], context)).rows[0];
    const partial = (await queryOneWindow(fixture({ failBase: true }).client, ONE_WINDOW_MATTERS[0], context)).rows[0];
    expect(partial).toMatchObject({ detailStatus: 'partial', detailFailures: ['base'] });
    const merged = mergeOneWindowRecord(partial, complete);
    expect(merged.details.base).toMatchObject({ status: 'failed', data: complete.details.base.data });
    const wrapper = (await queryOneWindow(fixture({ missingDetail: true }).client, ONE_WINDOW_MATTERS[0], context)).rows[0];
    expect(mergeOneWindowRecord(wrapper, complete).details.form).toMatchObject({ status: 'failed', data: complete.details.form.data });
  });

  it('reports a cancellation rather than converting it into partially collected data', async () => {
    const source = fixture();
    const signal = AbortSignal.abort();
    await expect(queryOneWindow(source.client, ONE_WINDOW_MATTERS[0], { ...context, signal })).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    expect(source.fetcher).not.toHaveBeenCalled();
  });

  it('reads every page of a material directory instead of truncating at the source page size', async () => {
    const source = fixture({ relatedPages: true });
    const result = await queryOneWindow(source.client, ONE_WINDOW_MATTERS[0], context);
    const materials = result.rows[0].details.materials.data as { list: unknown[]; pages: unknown[] };
    expect(materials.list).toHaveLength(101);
    expect(materials.pages).toHaveLength(2);
    expect(source.requests.filter(request => request.url.pathname.endsWith('/queryMaterialNew'))).toHaveLength(4);
  });

  it('rejects repeated source pages and stops the entire query when the login expires during details', async () => {
    const repeated = fixture({ repeatedList: true });
    await expect(queryOneWindow(repeated.client, ONE_WINDOW_MATTERS[0], context)).rejects.toThrow('重复');
    expect(repeated.requests.some(request => request.url.pathname.endsWith('/completework/detail'))).toBe(false);
    await expect(queryOneWindow(fixture({ expiredDetail: true }).client, ONE_WINDOW_MATTERS[0], context)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('captures table labels and ignores external or expression-based detail links', () => {
    const parsed = parseOneWindowHtml('<table><tr><th>字段：</th><td><input id="field" type="checkbox">值</td></tr></table><script>secret()</script>');
    expect(parsed.fields).toEqual([{ key: 'field', label: '字段', value: '值' }]);
    expect(parsed.tables).toEqual([[['字段：','值']]]);
    expect(parsed.text).not.toContain('secret');
    const links = oneWindowDetailLinks('$("#a").load("https://other.invalid/Accept/accept/worktodolist/businessBase");$("#b").load(variable);');
    expect(links.size).toBe(0);
    expect(sanitizeOneWindowData({ accessToken: 'x', payload: { token: 'y', field: 'keep' }, href: '/read?id=a&token=b' }))
      .toEqual({ payload: { field: 'keep' }, href: '/read?id=a' });
  });

  it('exposes manual login with both authorized source matters and a real session validation hook', async () => {
    const source = fixture();
    const plugin = createOneWindowPlugin({ fetcher: source.fetcher, minimumIntervalMs: 0,
      cookieReader: async () => [{ name: 'webfinal.session.id', value: 'fixture-session' }] });
    expect(plugin.matters.map(matter => matter.id)).toEqual(ONE_WINDOW_MATTERS.map(matter => matter.id));
    expect(plugin.supportsCredentialConfiguration).toBe(true);
    expect(plugin.loginMode).toBe('embedded');
    expect(plugin.loginPage!.credentialPaths).toEqual(['/Accept/login']);
    const fields = plugin.loginPage!.credentialFields!;
    // IDs/types from the source login HAR; no account values or captured page data are retained.
    const $ = load('<input id="checkcode_password" type="text"><input id="checkcode" type="text">'
      + '<input id="uname" name="uname" type="text"><input id="capassword" type="password">'
      + '<input id="password" name="password" type="password"><input id="loginBtn" type="submit">');
    expect($(fields.account).map((_, el) => $(el).attr('id')).get()).toEqual(['uname']);
    expect($(fields.password).map((_, el) => $(el).attr('id')).get()).toEqual(['password']);
    expect(plugin.workspaceMode).toBe('detail-ledger');
    expect((await plugin.getSessionState()).status).toBe('authenticated');
    plugin.loginPage!.onLoginPageChange!(true);
    await expect(plugin.sessionRecovery!.validate(new AbortController().signal)).rejects.toBeInstanceOf(AppError);
    plugin.loginPage!.onLoginPageChange!(false);
    expect((await plugin.getSessionState()).status).toBe('authenticated');
  });
});
