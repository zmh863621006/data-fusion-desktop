import { session } from 'electron';
import { AppError } from '../../core/errors/app-error';
import { RequestGate } from '../../core/network/request-policy';
import { HAZCHEM_ORIGIN, HAZCHEM_PARTITION, HAZCHEM_SERVICES, type HazardousMatter } from './catalog';

type Row = Record<string, unknown>;
export interface HazardousClientOptions { fetcher?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number; minimumIntervalMs?: number }
export interface HazardousTransport {
  done(matter: HazardousMatter, signal?: AbortSignal): Promise<Row[]>;
  report(signal?: AbortSignal): Promise<Row[]>;
  certificates(serial: string, signal?: AbortSignal): Promise<Row[]>;
}
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const credential = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\r\n]/.test(value);
const invalid = (message: string) => new AppError('REMOTE_REQUEST_FAILED', message, { retryable: false });
export function decodeHazardousReply(value: unknown): Row {
  if (!object(value) || !object(value.SYS_HEAD)) throw invalid('危化品系统返回的数据格式不完整');
  const head = value.SYS_HEAD;
  const ret = Array.isArray(head.RET) ? head.RET.filter(object) : [];
  if (ret.some(item => ['008899', '401', '403'].includes(text(item.RET_CODE)))) throw new AppError('SESSION_EXPIRED', '危化品系统会话已失效，请在原系统重新登录');
  if (head.RET_STATUS !== 'S' || ret.some(item => text(item.RET_CODE) !== '000000') || !object(value.BODY) || value.BODY.status !== 'success') {
    throw invalid('危化品系统未返回成功结果，请在原系统核对查询状态');
  }
  return value.BODY;
}
function rows(body: Row): Row[] {
  if (!Array.isArray(body.data) || body.data.some(row => !object(row))) throw invalid('危化品列表结构异常，未保存本次数据');
  return body.data as Row[];
}

/** Main-process only. The portal's Authorization and userId are sessionStorage values. */
export class HazardousClient implements HazardousTransport {
  private token = '';
  private userId = '';
  private validatedAt: number | undefined;
  private validation?: Promise<{ displayName: string }>;
  private readonly now: () => number;
  private readonly fetcher: NonNullable<HazardousClientOptions['fetcher']>;
  private readonly gate: RequestGate;
  constructor(options: HazardousClientOptions = {}) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? ((url, init) => session.fromPartition(HAZCHEM_PARTITION).fetch(url, init));
    this.gate = new RequestGate({ timeoutMs: 30_000, maxAttempts: 2, retryDelayMs: 500, minimumIntervalMs: options.minimumIntervalMs ?? 180 });
  }
  acceptStorage(values: Record<string, string>): void {
    const token = credential(values.Authorization) ? values.Authorization.trim() : '';
    const userId = credential(values.userId) ? values.userId.trim() : '';
    if (token === this.token && userId === this.userId) return;
    this.token = token; this.userId = userId; this.validatedAt = undefined;
  }
  hasSession(): boolean { return !!this.token && !!this.userId; }
  verified(): boolean { return this.hasSession() && this.validatedAt !== undefined; }
  needsValidation(): boolean { return this.hasSession() && (this.validatedAt === undefined || this.now() - this.validatedAt > 60_000); }
  exportSession(): Row | null { return this.hasSession() ? { Authorization: this.token, userId: this.userId } : null; }
  restoreSession(value: Row): void { this.acceptStorage({ Authorization: text(value.Authorization), userId: text(value.userId) }); this.validatedAt = undefined; }
  clearSession(): void { this.token = ''; this.userId = ''; this.validatedAt = undefined; }
  async logout(): Promise<void> { this.clearSession(); await session.fromPartition(HAZCHEM_PARTITION).clearStorageData(); }
  private async request(service: string, params: Row, signal?: AbortSignal): Promise<Row> {
    if (!Object.values(HAZCHEM_SERVICES).includes(service as typeof HAZCHEM_SERVICES[keyof typeof HAZCHEM_SERVICES])) throw new AppError('QUERY_INVALID', '不支持的危化品接口');
    if (!this.hasSession()) throw new AppError('SESSION_EXPIRED', '请先登录危化品系统');
    const token = this.token;
    const payload = JSON.stringify({ ...params, CONSUMER_ID: token, SERVICE_CODE: service });
    return this.gate.execute(async gateSignal => {
      let response: Response;
      try { response = await this.fetcher(HAZCHEM_ORIGIN + '/DataBus/exchange', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: HAZCHEM_ORIGIN, Referer: HAZCHEM_ORIGIN + '/iHome/' },
        body: payload, redirect: 'error', signal: gateSignal,
      }); } catch { throw invalid('连接危化品系统失败，请检查网络或原系统页面'); }
      if ([401, 403].includes(response.status)) { this.clearSession(); throw new AppError('SESSION_EXPIRED', '危化品系统会话已失效，请重新登录'); }
      if (!response.ok) throw invalid(`危化品列表请求失败（HTTP ${response.status}）`);
      if (/text\/html/i.test(response.headers.get('content-type') ?? '')) throw invalid('危化品系统未返回列表，请在原系统核对登录状态');
      let value: unknown;
      try { value = await response.json(); } catch { throw invalid('危化品系统未返回有效 JSON 数据'); }
      try {
        const reply = decodeHazardousReply(value);
        if (token !== this.token) throw new AppError('SESSION_EXPIRED', '危化品会话已切换，请重新开始回流');
        return reply;
      } catch (error) { if (error instanceof AppError && error.code === 'SESSION_EXPIRED' && token === this.token) this.clearSession(); throw error; }
    }, signal);
  }
  async validateSession(signal?: AbortSignal): Promise<{ displayName: string }> {
    if (!this.validation) this.validation = (async () => {
      const body = await this.request(HAZCHEM_SERVICES.done, this.doneParams(1, 1), signal);
      rows(body); if (!Number.isSafeInteger(Number(body.total)) || Number(body.total) < 0) throw invalid('危化品会话校验未返回有效列表');
      this.validatedAt = this.now(); return { displayName: '深圳危化品系统会话' };
    })().finally(() => { this.validation = undefined; });
    return this.validation;
  }
  private doneParams(page: number, size: number, matter?: HazardousMatter): Row {
    return { userId: this.userId, pageSize: size, pageNumber: page, type: 1,
      sblshShort: '', sxmc: matter?.name ?? '', sqdw: '', entpId: '', sxbmShort: matter?.sourceCode ?? '' };
  }
  async done(matter: HazardousMatter, signal?: AbortSignal): Promise<Row[]> {
    const result: Row[] = []; let expected: number | undefined;
    for (let page = 1; page <= 500; page++) {
      const body = await this.request(HAZCHEM_SERVICES.done, this.doneParams(page, 100, matter), signal);
      const current = rows(body), total = Number(body.total);
      if (!Number.isSafeInteger(total) || total < 0 || total > 50_000 || (expected !== undefined && expected !== total)) throw invalid('危化品已办列表数量发生变化或超出上限，请重新查询');
      expected = total; result.push(...current);
      if (result.length === total) return result;
      if (!current.length || result.length > total) throw invalid('危化品已办列表分页不完整，未保存本次数据');
    }
    throw invalid('危化品已办列表超过回流上限');
  }
  async report(signal?: AbortSignal): Promise<Row[]> {
    const result = rows(await this.request(HAZCHEM_SERVICES.report, { administrativeName: '', licenseName: '', result: '', undertakePerson: '', startTime: '', endTime: '' }, signal));
    if (result.length > 50_000) throw invalid('危化品制证导出数据超过50000条，请在原系统缩小范围');
    return result;
  }
  async certificates(serial: string, signal?: AbortSignal): Promise<Row[]> {
    const result: Row[] = []; let expected: number | undefined;
    for (let page = 1; page <= 50; page++) {
      const body = await this.request(HAZCHEM_SERVICES.certificates, { bizNum: serial, companyName: '', pageSize: 100, pageNumber: page, agentPeopleName: '', agentTimeBegin: '', agentTimeEnd: '' }, signal);
      const current = rows(body), total = Number(body.total);
      if (!Number.isSafeInteger(total) || total < 0 || total > 5000 || (expected !== undefined && expected !== total)) throw invalid('危化品制证关联列表数量异常');
      expected = total; result.push(...current);
      if (result.length === total) return result.filter(row => text(row.bizNum) === serial);
      if (!current.length || result.length > total) throw invalid('危化品制证列表分页不完整');
    }
    throw invalid('同一流水号的制证记录超出上限');
  }
}
