import { session } from 'electron';
import { AppError } from '../../core/errors/app-error';
import { RequestGate } from '../../core/network/request-policy';
import { FOOD_DRUG_HOME, FOOD_DRUG_ORIGIN, FOOD_DRUG_PARTITION, FOOD_DRUG_SSO_PATH, type FoodDrugLicense } from './catalog';

export type FoodDrugRow = Record<string, unknown>;
export interface FoodDrugClientOptions {
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  minimumIntervalMs?: number;
}

const SEARCH_PATH = '/dsxk/query/getData.action';
const FORM_PATH = '/dsxk/form/loadForm.action';
const CERTIFICATE_TAB = '/dsxk/dsxk/common/tab_dsxk_wsxx.jsp';
const SEARCH_ENTRY = 'query_v_dsxk_zhcx';
const SEARCH_MENU = '5D4F61234EF26D43E0531234A8C04862';
const ACCEPT_FORM = 'form_b_dsxk_admin_accept';
const COMPLETED_NODE = '%B0%EC%BD%E1';

const isRow = (value: unknown): value is FoodDrugRow => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const foodDrugText = (value: unknown): string =>
  typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)) ? String(value).trim() : '';
export const foodDrugFailure = (message: string) => new AppError('REMOTE_REQUEST_FAILED', message, { retryable: false });
const expired = () => new AppError('SESSION_EXPIRED', '食药监会话已失效，请在原系统重新登录');

function isLoginPath(url: string): boolean {
  if (!url) return false;
  try { return new URL(url, FOOD_DRUG_ORIGIN).pathname.replace(/\/$/, '') === FOOD_DRUG_SSO_PATH; }
  catch { return false; }
}

function parseObject(value: unknown, message: string): FoodDrugRow {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw foodDrugFailure(message); }
  }
  if (!isRow(value)) throw foodDrugFailure(message);
  return value;
}

function authMessage(value: FoodDrugRow): boolean {
  const status = foodDrugText(value.code ?? value.status);
  return status === '401' || /(?:未登录|请.{0,4}登录|会话.{0,4}(?:失效|过期)|session\s+(?:expired|invalid))/i
    .test(foodDrugText(value.message ?? value.msg ?? value.error));
}

export class FoodDrugClient {
  private readonly fetcher: NonNullable<FoodDrugClientOptions['fetcher']>;
  private readonly gate: RequestGate;

  constructor(options: FoodDrugClientOptions = {}) {
    this.fetcher = options.fetcher ?? ((url, init) => session.fromPartition(FOOD_DRUG_PARTITION).fetch(url, init));
    this.gate = new RequestGate({ timeoutMs: 15_000, maxAttempts: 2, retryDelayMs: 600, minimumIntervalMs: options.minimumIntervalMs ?? 250 });
  }

  async list(matter: FoodDrugLicense, start: string, end: string, page: number, size: number, signal?: AbortSignal, probe = false) {
    const reqParam = { clearQueryCriteria: !probe, menuId: SEARCH_MENU };
    const query = {
      queryEntryId: SEARCH_ENTRY, pageSize: String(size), pageNumber: String(page), moreBtn: true,
      criteriaValueMap: { ITEM_TYPE: matter.itemType, SFBJ: '1', LCJSSJ: start, LCJSSJ_v0: end, ISAGREE: '1', ISQUERY: '1' },
      reqParam,
    };
    const body = new URLSearchParams({ queryJson: JSON.stringify(query), pageSize: query.pageSize, pageNumber: query.pageNumber });
    const data = await this.post(SEARCH_PATH, reqParam, body, signal, !probe);
    const result = parseObject(data.result, '食药监未返回有效的分页结果');
    const count = foodDrugText(result.totalCount);
    const total = Number(count);
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(total)) throw foodDrugFailure('食药监返回的办件总数无效');
    const rows = isRow(result.data) ? result.data.rows : undefined;
    if (total === 0 && rows == null) return { total, rows: [] as FoodDrugRow[] };
    if (!Array.isArray(rows) || !rows.every(isRow)) throw foodDrugFailure('食药监返回的办件列表格式异常');
    return { total, rows };
  }

  acceptance(matter: FoodDrugLicense, businessId: string, signal?: AbortSignal) {
    return this.form(ACCEPT_FORM, businessId, {
      cardId: 'null', business_record_id: businessId, process_definition_name: matter.workflow,
      isSjwh: '', is_cxhq: '0', actionType: 'view', process_transaction_id: '',
    }, signal);
  }

  async certificate(matter: FoodDrugLicense, businessId: string, signal?: AbortSignal): Promise<FoodDrugRow> {
    const params = {
      business_record_id: businessId, process_definition_name: matter.workflow, xkzFormEntry: matter.certificateForm,
      process_transaction_id: '', node_name: COMPLETED_NODE, isSjwh: '', actionType: 'view',
    };
    const page = await this.request(CERTIFICATE_TAB, new URLSearchParams(params), undefined, signal);
    // The read-only document tab exposes the linked certificate form's detail ID.
    const match = /\bvar\s+xkzDetailId\s*=\s*(["'])([\w-]{0,160})\1\s*;/.exec(page);
    if (!match) throw foodDrugFailure('食药监证书页未返回可识别的关联编号，请在原系统核对');
    if (!match[2]) return {};
    return this.form(matter.certificateForm, match[2], params, signal);
  }

  private async form(entry: string, detailId: string, reqParam: Record<string, string>, signal?: AbortSignal) {
    const body = new URLSearchParams({ formEntryId: entry, actionType: 'view', detailId, 'fieldValueMap[detailId]': '' });
    for (const [key, value] of Object.entries(reqParam)) body.set('reqParam[' + key + ']', value);
    const data = await this.post(FORM_PATH, reqParam, body, signal, true);
    return parseObject(data.result, '食药监未返回有效的许可表单');
  }

  private async post(path: string, reqParam: FoodDrugRow, body: URLSearchParams, signal: AbortSignal | undefined, saveCriteria: boolean) {
    const search = new URLSearchParams({ saveCriteria: String(saveCriteria), REQUEST_HIDDEN_PARAMS: JSON.stringify(reqParam) });
    const data = parseObject(await this.request(path, search, body, signal), '食药监返回的许可查询结果格式异常');
    if (authMessage(data)) throw expired();
    return data;
  }

  private request(path: string, search: URLSearchParams, body?: URLSearchParams, outerSignal?: AbortSignal) {
    return this.gate.execute(async signal => {
      const url = FOOD_DRUG_ORIGIN + path + '?' + search;
      const response = await this.fetcher(url, {
        method: body ? 'POST' : 'GET', credentials: 'include', redirect: 'manual', signal,
        headers: { Accept: body ? 'application/json, text/plain, */*' : 'text/html, */*', Referer: FOOD_DRUG_HOME },
        body,
      });
      if (response.status === 401 || isLoginPath(response.headers.get('location') ?? '') || isLoginPath(response.url)) throw expired();
      if (response.status === 403) throw foodDrugFailure('食药监系统拒绝访问，请核对账号权限');
      if (response.status >= 500) throw new AppError('REMOTE_REQUEST_FAILED', '食药监系统服务暂时不可用');
      if (!response.ok) throw foodDrugFailure('食药监接口返回异常状态，请在原系统核对');
      const charset = /\bcharset\s*=\s*["']?(gb2312|gbk|gb18030)\b/i.exec(response.headers.get('content-type') ?? '');
      const content = charset ? new TextDecoder('gb18030').decode(await response.arrayBuffer()) : await response.text();
      if (/^\s*</.test(content) && /\bname\s*=\s*["']execution["']/i.test(content)
        && /\bname\s*=\s*["']_eventId["']/i.test(content)) throw expired();
      return content;
    }, outerSignal);
  }
}
