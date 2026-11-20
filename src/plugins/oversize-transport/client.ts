import { AppError } from '../../core/errors/app-error';
import { RequestGate } from '../../core/network/request-policy';

export const OVERSIZE_PAGE_URL = 'https://td.gd.gov.cn/appLzxt/login';
export const OVERSIZE_HOME_URL = 'https://td.gd.gov.cn/appLzxt/manage/home';
export const OVERSIZE_API_ORIGIN = 'https://highwayluzheng.zcits.com.cn';
export const OVERSIZE_CERTIFICATE_PATH = '/gddj/api/approve/permission/getCertificateList';
export const OVERSIZE_APPLICATION_PATH = '/gddj/api/approve/permission/selectRequest';
export const OVERSIZE_PARTITION = 'persist:oversize-transport';
export const OVERSIZE_PORTAL_TOKEN_KEY = 'pro__Access-Token';

export interface OversizeListItem extends Record<string, unknown> { id?: string; reqNo?: string; handerTime?: string }
/** Deliberate allowlist: no agent, identity number, phone or full upstream object leaves the client. */
export interface OversizeApplication { id: string; reqNo: string; transportName: string; transportCreditCode: string }
interface ApiReply { code?: unknown; isSuccess?: unknown; msg?: unknown; data?: Record<string, unknown> }
interface CertificatePage { records: OversizeListItem[]; total: number; current: number }
const tokenValue = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9._-]{16,4096}$/.test(value) ? value : '';
const isCounter = (value: unknown): boolean => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0;

/** Vue-ls wrapper used by the road-administration portal. Main process only. */
export function portalTokenFromStorage(values: Record<string, string>): string {
  try {
    const stored = JSON.parse(values[OVERSIZE_PORTAL_TOKEN_KEY] ?? 'null') as { value?: unknown; expire?: unknown } | null;
    if (!stored || (typeof stored.expire === 'number' && stored.expire > 0 && stored.expire <= Date.now())) return '';
    return tokenValue(stored.value);
  } catch { return ''; }
}

export class OversizeTransportClient {
  private readonly gate = new RequestGate({ timeoutMs: 30_000, maxAttempts: 2, retryDelayMs: 800, minimumIntervalMs: 250 });
  private token = '';
  private portalToken = '';
  private expiresAt?: number;
  private generation = 0;
  private portalLoginVisible = false;

  // Account/password remain in the existing encrypted credential store and original login tab.
  configureCredentials(_credentials: { account: string; password: string } | null): void { this.clearSession(); }
  isAuthenticated(): boolean { return Boolean(this.token && this.expiresAt && this.expiresAt > Date.now()); }
  sessionExpiresAt(): number | undefined { return this.expiresAt; }
  exportSession(): Record<string, unknown> | null {
    return this.token || this.portalToken ? { token: this.token, portalToken: this.portalToken } : null;
  }
  restoreSession(value: Record<string, unknown>): void {
    this.generation++;
    this.token = tokenValue(value.token); this.portalToken = tokenValue(value.portalToken); this.expiresAt = 0;
    // An old /bis JSESSIONID cannot authenticate to 3.0.
  }
  setPortalLoginVisible(visible: boolean): void {
    this.portalLoginVisible = visible;
    if (visible) this.clearSession();
  }
  browserAuthGeneration(): number | null { return this.portalLoginVisible ? null : this.generation; }
  acceptPortalStorage(values: Record<string, string>): void {
    if (this.portalLoginVisible) return;
    const token = portalTokenFromStorage(values);
    if (token && token !== this.portalToken) { this.generation++; this.portalToken = token; this.token = ''; this.expiresAt = 0; }
  }
  acceptBrowserToken(value: string): void {
    const token = tokenValue(value);
    if (token && token !== this.token) { this.generation++; this.token = token; this.expiresAt = 0; }
  }
  clearSession(): void { this.generation++; this.token = ''; this.portalToken = ''; this.expiresAt = undefined; }
  captureQuerySession(): () => void {
    const generation = this.generation;
    return () => this.requireGeneration(generation);
  }
  private requireGeneration(generation: number): void {
    if (this.generation !== generation) throw new AppError('REMOTE_REQUEST_FAILED', '登录状态已更新，请重新检测', { retryable: false, sessionChanged: true });
  }
  async login(): Promise<void> {
    throw new AppError('SYSTEM_LOGIN_REQUIRED', '请在新平台原系统标签页完成登录，应用会自动填入已配置的账号密码');
  }

  async validateSession(signal: AbortSignal): Promise<{ displayName: string }> {
    const generation = this.generation;
    if (!this.token && this.portalToken) await this.exchangePortalSession(signal);
    if (!this.token) throw new AppError('SESSION_EXPIRED', '请先登录路政平台并连接大件运输3.0');
    try { await this.certificatePage(1, 1, signal); }
    catch (error) {
      this.requireGeneration(generation);
      if (!(error instanceof AppError) || error.code !== 'SESSION_EXPIRED' || !this.portalToken) throw error;
      await this.exchangePortalSession(signal);
      await this.certificatePage(1, 1, signal);
    }
    this.requireGeneration(generation);
    this.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
    return { displayName: '大件运输3.0系统会话' };
  }

  private async exchangePortalSession(signal: AbortSignal): Promise<void> {
    const generation = this.generation;
    const url = new URL('/gddj/api/oauth/anyTenant/lzxt/sso/login', OVERSIZE_API_ORIGIN);
    url.searchParams.set('token', this.portalToken);
    const result = await this.request(url, 'POST', signal, false);
    this.requireGeneration(generation);
    const token = tokenValue(result.data?.token);
    if (!token) throw new AppError('REMOTE_REQUEST_FAILED', '大件运输3.0单点登录未返回有效会话');
    this.token = token; this.expiresAt = 0;
  }

  async fetchIssuedList(_startDate: string, _endDate: string, signal?: AbortSignal): Promise<OversizeListItem[]> {
    if (!this.isAuthenticated()) throw new AppError('SESSION_EXPIRED', '大件运输3.0会话未验证，请先连接原系统');
    const generation = this.generation;
    const records: OversizeListItem[] = [], seen = new Set<string>();
    let total: number | undefined;
    for (let page = 1; ; page++) {
      const data = await this.certificatePage(page, 10, signal);
      this.requireGeneration(generation);
      total ??= data.total;
      if (total > 10_000) throw new AppError('REMOTE_REQUEST_FAILED', '大件运输惠州证件超过单次10000条上限，请联系管理员');
      if (data.total !== total || data.current !== page) throw new AppError('REMOTE_REQUEST_FAILED', '大件运输分页总数或页码发生变化，请重新回流');
      for (const row of data.records) {
        const id = String(row.id ?? '').trim();
        if (!id || seen.has(id)) throw new AppError('REMOTE_REQUEST_FAILED', '大件运输分页出现缺失或重复证件标识，已停止以避免漏采');
        seen.add(id); records.push(row);
      }
      if (records.length === total) return records;
      if (!data.records.length || records.length > total) throw new AppError('REMOTE_REQUEST_FAILED', '大件运输分页数量不一致，未保存不完整数据');
    }
  }

  async fetchApplicationRecords(reqNo: string, signal?: AbortSignal): Promise<OversizeApplication[]> {
    if (!this.isAuthenticated()) throw new AppError('SESSION_EXPIRED', '大件运输3.0会话未验证，请先连接原系统');
    if (!/^[A-Za-z]4413[0-9]+$/.test(reqNo)) throw new AppError('QUERY_INVALID', '办件查询需要完整的惠州申请编号');
    const generation = this.generation, records: OversizeApplication[] = [], seen = new Set<string>();
    let total: number | undefined;
    for (let page = 1; ; page++) {
      const result = await this.request(new URL(OVERSIZE_APPLICATION_PATH, OVERSIZE_API_ORIGIN), 'POST', signal, true, {
        agentName: '', endTime: '', pageNo: page, pageSize: 10, reqNo, startTime: '', status: '', tractorNo: '', trailerNo: '', versionSource: '',
      });
      this.requireGeneration(generation);
      const data = result.data;
      if (!data || !Array.isArray(data.records) || !isCounter(data.total) || !isCounter(data.current)
        || data.records.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw new AppError('REMOTE_REQUEST_FAILED', '大件运输办件查询响应无法确认');
      }
      total ??= Number(data.total);
      if (total > 100 || Number(data.total) !== total || Number(data.current) !== page) {
        throw new AppError('REMOTE_REQUEST_FAILED', '大件运输办件查询范围过大或分页不稳定，请核对申请编号');
      }
      for (const row of data.records as Record<string, unknown>[]) {
        const str = (value: unknown) => typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
        const id = str(row.id);
        if (!id || seen.has(id)) throw new AppError('REMOTE_REQUEST_FAILED', '大件运输办件分页缺少或重复标识', { identityConflict: true, retryable: false });
        seen.add(id);
        records.push({ id, reqNo: str(row.reqNo), transportName: str(row.transportName), transportCreditCode: str(row.transportCreditCode) });
      }
      if (records.length === total) return records;
      if (!data.records.length || records.length > total) throw new AppError('REMOTE_REQUEST_FAILED', '大件运输办件分页数量不一致');
    }
  }

  private async certificatePage(page: number, size: number, signal?: AbortSignal): Promise<CertificatePage> {
    const url = new URL(OVERSIZE_CERTIFICATE_PATH, OVERSIZE_API_ORIGIN);
    url.search = new URLSearchParams({ reqNo: '4413', pageNo: String(page), pageSize: String(size) }).toString();
    const result = await this.request(url, 'GET', signal);
    const data = result.data;
    if (!data || !Array.isArray(data.records) || !isCounter(data.total) || !isCounter(data.current) || Number(data.current) < 1
      || data.records.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new AppError('REMOTE_REQUEST_FAILED', '大件运输3.0证件查询响应无法确认');
    }
    return { records: data.records as OversizeListItem[], total: Number(data.total), current: Number(data.current) };
  }

  private async request(url: URL, method: 'GET' | 'POST', signal?: AbortSignal, authenticated = true, body?: Record<string, unknown>): Promise<ApiReply> {
    const generation = this.generation, token = this.token;
    return this.gate.execute(async (requestSignal) => {
      let response: Response;
      try {
        response = await fetch(url, { method, signal: requestSignal, redirect: 'error', body: body ? JSON.stringify(body) : undefined, headers: {
          Accept: 'application/json', ...(authenticated ? { Token: token, ApplicationId: '3' } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        } });
      } catch {
        // SSO URLs contain a portal credential. Never propagate raw fetch messages/URLs.
        this.requireGeneration(generation);
        throw new AppError('REMOTE_REQUEST_FAILED', '大件运输3.0连接失败，请检查网络后重试');
      }
      this.requireGeneration(generation);
      if ([401, 403].includes(response.status)) {
        if (authenticated && this.generation === generation && this.token === token) { this.token = ''; this.expiresAt = 0; }
        throw new AppError('SESSION_EXPIRED', '大件运输3.0会话已失效，请重新登录');
      }
      if (!response.ok) throw new AppError('REMOTE_REQUEST_FAILED', `大件运输3.0请求失败（${response.status}）`);
      let result: ApiReply;
      try { result = await response.json() as ApiReply; }
      catch { this.requireGeneration(generation); throw new AppError('REMOTE_REQUEST_FAILED', '大件运输3.0未返回有效JSON响应'); }
      this.requireGeneration(generation);
      if (!result || ![0, '0'].includes(result.code as number | string) || result.isSuccess === false) {
        if (result && ([401, 403].includes(Number(result.code))
          || /(?:登录|令牌|会话|token).*(?:失效|过期|无效)|未登录|unauthorized/i.test(String(result.msg ?? '')))) {
          if (authenticated && this.generation === generation && this.token === token) { this.token = ''; this.expiresAt = 0; }
          throw new AppError('SESSION_EXPIRED', '大件运输3.0会话已失效，请重新登录');
        }
        throw new AppError('REMOTE_REQUEST_FAILED', '大件运输3.0业务接口未返回成功结果', { retryable: false });
      }
      return result;
    }, signal);
  }
}
