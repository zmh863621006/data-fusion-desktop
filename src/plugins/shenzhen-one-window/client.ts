import { session } from 'electron';
import { load } from 'cheerio';
import { AppError } from '../../core/errors/app-error';
import { RequestGate } from '../../core/network/request-policy';
import {
  ONE_WINDOW_HOME_URL, ONE_WINDOW_LIST_PATH, ONE_WINDOW_MATTERS, ONE_WINDOW_ORIGIN,
  ONE_WINDOW_PARTITION, ONE_WINDOW_WORKSPACE_PATH, type OneWindowMatter,
} from './catalog';
import {
  oneWindowDetailLinks, oneWindowDisplayData, oneWindowFailure, oneWindowLiteral, oneWindowObject,
  oneWindowText, parseOneWindowFormFields, parseOneWindowHtml, parseOneWindowJson, sanitizeOneWindowData,
} from './parser';
import type { OneWindowDetailSection, OneWindowFormData } from './types';

export interface OneWindowClientOptions {
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  minimumIntervalMs?: number;
  cookieReader?: () => Promise<Array<{ name: string; value: string }>>;
}

export interface OneWindowSourceFilters {
  dateType: 'all' | 'received' | 'finished';
  startDate: string;
  endDate: string;
  state: string;
}

const sections = [
  ['base', 'businessBase', '基本信息'], ['item', 'itemInfo', '事项信息'],
  ['opinions', 'businessOpinion', '办理意见'], ['businessFlow', 'businessFlow', '办理流程'],
  ['serviceList', 'serviceList', '服务清单'], ['delivery', 'showDeliverInfo', '送达信息'],
  ['ems', 'showEmsInfo', '邮寄信息'], ['fileDelivery', 'showDetail', '文件送达'],
  ['unionHandle', 'show', '联办流转'],
] as const;
const allowedGetPaths = new Set([
  ONE_WINDOW_HOME_URL.replace(ONE_WINDOW_ORIGIN, '').split('?')[0], ONE_WINDOW_WORKSPACE_PATH,
  '/Accept/accept/business/completework/detail',
  ...sections.filter(([,name]) => !['showDetail', 'show'].includes(name)).map(([,name]) => '/Accept/accept/worktodolist/' + name),
  '/Accept/accept/worktodolist/businessInfo', '/Accept/accept/worktodolist/businessFile',
  '/Accept/accept/dockingcenter/filebag/showDetail', '/Accept/accept/business/unionHandle/show',
  '/ebus/form/service/formData', '/ebus/form/service/info',
]);
const allowedPostPaths = new Set([ONE_WINDOW_LIST_PATH, '/Accept/accept/business/correction/queryMaterialNew',
  '/Accept/accept/business/correction/queryWorkTodoFile', '/Accept/accept/business/license/queryLicenselist',
  '/Accept/accept/business/proceFile/queryprocefilelist', '/Accept/accept/print/yxqOrder/busiPrintList']);
const expired = () => new AppError('SESSION_EXPIRED', '一窗平台会话已失效，请在原系统重新登录');

function isLoginUrl(value: string): boolean {
  try { return new URL(value, ONE_WINDOW_ORIGIN).pathname.replace(/\/$/, '') === '/Accept/login'; }
  catch { return false; }
}

/** A read-only client that uses the source tab's cookie jar and literal detail-page references. */
export class OneWindowClient {
  private readonly fetcher: NonNullable<OneWindowClientOptions['fetcher']>;
  private readonly cookieReader: NonNullable<OneWindowClientOptions['cookieReader']>;
  private readonly gate: RequestGate;
  private workspace = { orgId: '', from: '', idJDTB: '', isprivilege: '', usedFor: '' };
  private states = new Map<string, string>();

  constructor(options: OneWindowClientOptions = {}) {
    this.fetcher = options.fetcher ?? ((url, init) => session.fromPartition(ONE_WINDOW_PARTITION).fetch(url, init));
    this.cookieReader = options.cookieReader ?? (() => session.fromPartition(ONE_WINDOW_PARTITION).cookies.get({ url: ONE_WINDOW_HOME_URL }));
    this.gate = new RequestGate({ timeoutMs: 20_000, maxAttempts: 2, retryDelayMs: 500,
      minimumIntervalMs: options.minimumIntervalMs ?? 180 });
  }

  async hasCookie(): Promise<boolean> {
    return (await this.cookieReader()).some(cookie => cookie.name === 'webfinal.session.id' && Boolean(cookie.value));
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    const html = await this.request(ONE_WINDOW_WORKSPACE_PATH, {}, undefined, signal);
    const $ = load(html);
    if (!$('#orgId').length || !html.includes('monitor/allbusiness/queryAll')) {
      throw oneWindowFailure('一窗办件工作台结构无法识别，请在原系统打开“全部办件”后重试');
    }
    this.workspace = { orgId: oneWindowText($('#orgId').val()),
      from: oneWindowLiteral(html, 'from'), idJDTB: oneWindowLiteral(html, 'idJDTB'),
      isprivilege: oneWindowLiteral(html, 'isprivilege'), usedFor: oneWindowLiteral(html, 'usedFor') };
    const stateJson = /formatBusinessState\(\s*'([^'\r\n]+)'/.exec(html)?.[1];
    this.states.clear();
    if (stateJson) {
      try {
        const values: unknown = JSON.parse(stateJson);
        if (Array.isArray(values)) this.states = new Map(values.filter(oneWindowObject)
          .map(value => [oneWindowText(value.CODE), oneWindowText(value.NAME)]));
      } catch { /* The source list remains readable when its optional status dictionary changes. */ }
    }
  }

  statusLabel(value: string): string { return this.states.get(value) || value; }

  async validateSession(signal: AbortSignal): Promise<{ displayName: string }> {
    if (!await this.hasCookie()) throw expired();
    await this.prepare(signal);
    await this.list(ONE_WINDOW_MATTERS[0], { dateType: 'all', startDate: '', endDate: '', state: '' }, 1, 1, signal);
    return { displayName: '深圳一窗受理会话' };
  }

  async list(matter: OneWindowMatter, filters: OneWindowSourceFilters, page: number, rows: number, signal?: AbortSignal) {
    if (!ONE_WINDOW_MATTERS.some(known => known.id === matter.id && known.name === matter.name)) {
      throw new AppError('QUERY_INVALID', '该事项不属于已登记的一窗回流事项');
    }
    // The legacy page URI-encodes a text filter before the form encoder encodes the percent signs.
    const body = new URLSearchParams({ _search: 'false', nd: String(Date.now()), rows: String(rows), page: String(page),
      sidx: 'RECEIVE_TIME', sord: 'asc', itemname: encodeURIComponent(matter.name), curState: filters.state,
      bjstart: filters.dateType === 'finished' ? filters.startDate : '', bjend: filters.dateType === 'finished' ? filters.endDate : '',
      start: filters.dateType === 'received' ? filters.startDate : '', end: filters.dateType === 'received' ? filters.endDate : '',
      applicant: '', applyFrom: '', state: '', haslicense: '', applynum: '', regionCode: '', applicantId: '',
      acceptUser: '', serviceObjectType: '', busiType: '', windowName: '', applySubject: '' });
    const data = parseOneWindowJson(await this.request(ONE_WINDOW_LIST_PATH, this.workspace, body, signal));
    const count = oneWindowText(data.records);
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)) || !Array.isArray(data.rows)) {
      throw oneWindowFailure('一窗系统未返回完整的办件分页结果');
    }
    const cells = data.rows.map(row => oneWindowObject(row) ? row.cell : undefined);
    if (!cells.every(oneWindowObject)) throw oneWindowFailure('一窗办件列表包含无法识别的记录');
    return { total: Number(count), rows: cells as Record<string, unknown>[] };
  }

  async details(bsnum: string, signal?: AbortSignal): Promise<Record<string, OneWindowDetailSection>> {
    const detail: Record<string, OneWindowDetailSection> = {};
    const html = await this.request('/Accept/accept/business/completework/detail', { bsnum, type: '', source: '', from: '' }, undefined, signal);
    const links = oneWindowDetailLinks(html);
    if (!links.has('businessBase') || !links.has('itemInfo')) throw oneWindowFailure('一窗详情页未返回有效的办件信息入口');
    const identifiers: Record<string, string> = { bsnum };
    for (const link of links.values()) {
      for (const key of ['itemId','caseId','objectCode','objecType','formId','dataId','serviceListId']) {
        const value = link.searchParams.get(key);
        if (value && !identifiers[key]) identifiers[key] = value;
      }
    }
    detail.identifiers = { status: 'complete', data: identifiers };
    for (const [name, path, label] of sections) {
      const link = links.get(path);
      if (!link) { detail[name] = { status: 'absent', data: null }; continue; }
      await this.section(detail, name, label, async () => parseOneWindowHtml(await this.requestUrl(link, undefined, signal)));
    }
    const businessInfo = links.get('businessInfo');
    if (businessInfo) {
      await this.section(detail, 'form', '电子表单', async () => this.form(await this.requestUrl(businessInfo, undefined, signal), signal));
    } else detail.form = { status: 'absent', data: null };
    await this.related(detail, bsnum, identifiers, signal);
    return detail;
  }

  private async related(detail: Record<string, OneWindowDetailSection>, bsnum: string, ids: Record<string, string>, signal?: AbortSignal) {
    if (ids.itemId && ids.caseId) {
      await this.section(detail, 'materials', '申请材料', async () => this.relatedPages('/Accept/accept/business/correction/queryMaterialNew',
        { method: 'itemFileList-detail' }, { page: 1, rows: 100, param: JSON.stringify({ itemId: ids.itemId, caseId: ids.caseId, bsNum: bsnum }) }, signal));
    } else detail.materials = { status: 'absent', data: null };
    await this.section(detail, 'files', '办件文件', async () => this.relatedPages('/Accept/accept/business/correction/queryWorkTodoFile',
      { method: 'workToDoFile' }, { page: 1, rows: 100, param: JSON.stringify({ fileType: 'CRS', bsNum: bsnum }) }, signal));
    for (const [name, path, label] of [
      ['licenses','/Accept/accept/business/license/queryLicenselist','证照清单'],
      ['processFiles','/Accept/accept/business/proceFile/queryprocefilelist','过程文件'],
      ['printFiles','/Accept/accept/print/yxqOrder/busiPrintList','打印清单'],
    ]) {
      await this.section(detail, name, label, async () => this.relatedPages(path, { bsnum },
        new URLSearchParams({ _search: 'false', rows: '100', page: '1', sidx: '', sord: 'asc' }), signal));
    }
  }

  private async relatedPages(path: string, params: Record<string, string>, body: URLSearchParams | Record<string, unknown>, signal?: AbortSignal) {
    const pages: Record<string, unknown>[] = [], combined: unknown[] = [], seenPages = new Set<string>();
    const fieldName = body instanceof URLSearchParams ? 'rows' : 'list';
    let count: number | undefined;
    for (let page = 1; count === undefined || combined.length < count; page++) {
      const current = body instanceof URLSearchParams ? new URLSearchParams(body) : { ...body, page };
      if (current instanceof URLSearchParams) current.set('page', String(page));
      const result = await this.json(path, params, current, signal);
      const rawCount = fieldName === 'rows' ? result.records : result.total;
      const rawRows = result[fieldName];
      if (!/^\d+$/.test(oneWindowText(rawCount)) || !Array.isArray(rawRows)) throw oneWindowFailure('一窗详情清单分页结构不完整');
      const total = Number(rawCount);
      if (total > 50_000 || count !== undefined && count !== total) throw oneWindowFailure('一窗详情清单条数已变化或超过支持的范围');
      count = total;
      if ((!rawRows.length && combined.length < count) || combined.length + rawRows.length > count) throw oneWindowFailure('一窗详情清单分页不完整');
      const fingerprint = JSON.stringify(rawRows);
      if (rawRows.length && seenPages.has(fingerprint)) throw oneWindowFailure('一窗详情清单重复返回同一页，等待重新采集');
      seenPages.add(fingerprint);
      combined.push(...rawRows); pages.push(result);
    }
    return { ...pages[0], [fieldName]: combined, ...(pages.length > 1 ? { pages } : {}) };
  }

  private async form(html: string, signal?: AbortSignal): Promise<OneWindowFormData> {
    const $ = load(html);
    const iframe = oneWindowLiteral(html, 'iframeUrl') || $('#formWin2').attr('src') || '';
    let url: URL;
    try { url = new URL(iframe, ONE_WINDOW_ORIGIN); } catch { throw oneWindowFailure('一窗电子表单地址无法识别'); }
    if (url.origin !== ONE_WINDOW_ORIGIN || url.pathname !== '/t/cform/form/view') throw oneWindowFailure('一窗电子表单来源地址无法识别');
    const accessToken = url.searchParams.get('token') || '';
    const formDataId = url.searchParams.get('formDataId') || '';
    const formId = url.searchParams.get('formId') || '';
    if (!accessToken || !formDataId || !formId) throw oneWindowFailure('一窗电子表单关联信息不完整');
    const response = parseOneWindowJson(await this.request('/ebus/form/service/formData', { accessToken, formDataId }, undefined, signal));
    if (String(response.state) !== '1' || !oneWindowObject(response.row)) throw oneWindowFailure('一窗电子表单数据读取失败');
    let raw = response.row.data;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { throw oneWindowFailure('一窗电子表单内容无法解析'); }
    }
    if (!oneWindowObject(raw)) throw oneWindowFailure('一窗电子表单未返回有效的业务字段');
    const version = oneWindowText(response.row.formVersionId);
    const info = parseOneWindowJson(await this.request('/ebus/form/service/info',
      { accessToken, mode: 'edit', formId, formVersionId: version }, undefined, signal));
    if (String(info.state) !== '1' || !oneWindowObject(info.row)) throw oneWindowFailure('一窗电子表单字段定义读取失败');
    const fields = parseOneWindowFormFields(info.row.content);
    const data = sanitizeOneWindowData(raw) as Record<string, unknown>;
    const { data: _data, ...metadata } = response.row;
    let schema: unknown = info.row.content;
    if (typeof schema === 'string') { try { schema = JSON.parse(schema); } catch { throw oneWindowFailure('一窗电子表单字段定义格式异常'); } }
    return { name: oneWindowText(response.row.formName ?? info.row.name), version,
      data, fields, displayData: oneWindowDisplayData(data, fields), schema: sanitizeOneWindowData(schema),
      metadata: sanitizeOneWindowData(metadata) as Record<string, unknown> };
  }

  private async section(target: Record<string, OneWindowDetailSection>, name: string, label: string, read: () => Promise<unknown>) {
    try { target[name] = { status: 'complete', data: sanitizeOneWindowData(await read()) }; }
    catch (error) {
      if (error instanceof AppError && ['SESSION_EXPIRED','TASK_CANCELLED'].includes(error.code)) throw error;
      target[name] = { status: 'failed', data: null, message: `${label}读取失败，等待补采` };
    }
  }

  private async json(path: string, params: Record<string, string>, body: URLSearchParams | Record<string, unknown>, signal?: AbortSignal) {
    const result = parseOneWindowJson(await this.request(path, params, body, signal));
    if (result.state !== undefined && !['1','true','success'].includes(String(result.state).toLowerCase())) {
      throw oneWindowFailure('一窗详情清单读取失败');
    }
    return result;
  }

  private request(path: string, params: Record<string, string>, body: URLSearchParams | Record<string, unknown> | undefined, signal?: AbortSignal) {
    const url = new URL(path, ONE_WINDOW_ORIGIN);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.requestUrl(url, body, signal);
  }

  private requestUrl(url: URL, body: URLSearchParams | Record<string, unknown> | undefined, outerSignal?: AbortSignal) {
    if (url.origin !== ONE_WINDOW_ORIGIN || !(body ? allowedPostPaths : allowedGetPaths).has(url.pathname)) {
      throw new AppError('QUERY_INVALID', '该地址不属于一窗只读业务接口');
    }
    return this.gate.execute(async signal => {
      let response: Response;
      try {
        response = await this.fetcher(url.href, { method: body ? 'POST' : 'GET', signal, credentials: 'include', redirect: 'manual',
          headers: { Accept: 'application/json,text/html,*/*', Referer: ONE_WINDOW_HOME_URL,
            ...(body ? { 'Content-Type': body instanceof URLSearchParams ? 'application/x-www-form-urlencoded;charset=UTF-8' : 'application/json;charset=UTF-8' } : {}) },
          ...(body ? { body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body) } : {}) });
      } catch {
        if (signal.aborted) throw new AppError('REMOTE_TIMEOUT', '一窗请求超时，请检查内网连接');
        throw new AppError('REMOTE_REQUEST_FAILED', '无法连接一窗平台，请检查内网连接');
      }
      if (response.status === 401 || isLoginUrl(response.headers.get('location') || '') || response.url && isLoginUrl(response.url)) throw expired();
      if (response.status === 403) throw oneWindowFailure('一窗平台拒绝读取，请核对当前账号事项权限');
      if (!response.ok) throw oneWindowFailure(`一窗读取失败（HTTP ${response.status}）`);
      const max = 8 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > max) throw oneWindowFailure('一窗单个响应超过支持的大小');
      const reader = response.body?.getReader();
      if (!reader) throw oneWindowFailure('一窗未返回有效的业务响应');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > max) throw oneWindowFailure('一窗单个响应超过支持的大小');
          chunks.push(chunk.value);
        }
      } finally { void reader.cancel().catch(() => {}); }
      const content = Buffer.concat(chunks).toString('utf8');
      if (/\bid\s*=\s*['"]loginBtn['"]/.test(content) && /\bid\s*=\s*['"]password['"]/.test(content)) throw expired();
      if (signal.aborted) throw new AppError('TASK_CANCELLED', '回流任务已取消');
      return content;
    }, outerSignal);
  }
}
