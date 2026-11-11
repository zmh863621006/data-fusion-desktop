import { AppError } from '../../core/errors/app-error';
import { RequestGate } from '../../core/network/request-policy';

const DEFAULT_LOGIN_URL = 'http://19.88.233.100:18080/api/login';
const DEFAULT_DATA_URL = 'http://19.88.233.100:18080/api/tBizVehicleTrafInfo';
export const ONLINE_CAR_PAGE_URL = process.env.DATA_FUSION_ONLINE_CAR_PAGE_URL?.trim() || new URL(process.env.DATA_FUSION_ONLINE_CAR_LOGIN_URL?.trim() || DEFAULT_LOGIN_URL).origin + '/';
export const ONLINE_CAR_PARTITION = 'persist:online-car-permit';

export class OnlineCarPermitClient {
  private readonly gate = new RequestGate({ timeoutMs: 60_000, maxAttempts: 2, retryDelayMs: 1_000, minimumIntervalMs: 250 });
  private credentials?: { account: string; password: string };
  private token = '';
  private expiresAt?: number;

  configureCredentials(credentials: { account: string; password: string } | null): void {
    this.credentials = credentials ?? undefined;
    this.clearSession();
  }

  isAuthenticated(): boolean { return Boolean(this.token) && Boolean(this.expiresAt && this.expiresAt > Date.now()); }
  sessionExpiresAt(): number | undefined { return this.expiresAt; }
  exportSession(): Record<string, unknown> | null { return this.token ? { token: this.token } : null; }
  restoreSession(value: Record<string, unknown>): void {
    if (typeof value.token === 'string' && /^Bearer\s+\S+$/i.test(value.token)) { this.token = value.token; this.expiresAt = 0; }
  }
  async validateSession(signal: AbortSignal): Promise<{ displayName: string }> {
    if (!this.token) throw new AppError('SESSION_EXPIRED', '网约车会话不存在');
    const url = new URL(process.env.DATA_FUSION_ONLINE_CAR_DATA_URL?.trim() || DEFAULT_DATA_URL);
    const today = new Date().toISOString().slice(0, 10);
    url.search = new URLSearchParams({ beginTime: today, endTime: today, size: '1' }).toString();
    const response = await fetch(url, { signal, headers: { authorization: this.token }, redirect: 'error' });
    if (response.status === 401 || response.status === 403) throw new AppError('SESSION_EXPIRED', '网约车会话已失效');
    if (!response.ok) throw new AppError('REMOTE_REQUEST_FAILED', '网约车会话验证请求失败');
    const result = await response.json() as { code?: unknown; data?: { records?: unknown } };
    if (Number(result.code) === 401 || Number(result.code) === 403) throw new AppError('SESSION_EXPIRED', '网约车会话已失效');
    if (result.code !== undefined && ![0, 200].includes(Number(result.code))) throw new AppError('REMOTE_REQUEST_FAILED', '网约车会话验证未获成功响应');
    if (!Array.isArray(result.data?.records)) throw new AppError('REMOTE_REQUEST_FAILED', '网约车会话验证响应无法确认');
    this.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
    return { displayName: '网约车车证接口会话' };
  }
  acceptBrowserToken(token: string): void {
    if (!/^Bearer\s+\S+$/i.test(token)) return;
    this.token = token;
    this.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
  }
  clearSession(): void { this.token = ''; this.expiresAt = undefined; }

  async login(): Promise<void> {
    const account = this.credentials?.account.trim() || process.env.DATA_FUSION_ONLINE_CAR_ACCOUNT?.trim();
    const password = this.credentials?.password || process.env.DATA_FUSION_ONLINE_CAR_PASSWORD;
    if (!account || !password) throw new AppError('SYSTEM_LOGIN_REQUIRED', '网约车车证系统尚未配置登录账号和密码');
    const url = process.env.DATA_FUSION_ONLINE_CAR_LOGIN_URL?.trim() || DEFAULT_LOGIN_URL;
    const result = await this.gate.execute(async (signal) => {
      const response = await fetch(url, {
        method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account, password }),
      });
      if (!response.ok) throw new AppError('REMOTE_REQUEST_FAILED', `网约车车证系统登录失败（${response.status}）`);
      return response.json() as Promise<{ data?: unknown; message?: unknown; msg?: unknown }>;
    });
    if (typeof result.data !== 'string' || !result.data.trim()) {
      throw new AppError('SYSTEM_LOGIN_REQUIRED', String(result.message ?? result.msg ?? '网约车车证系统账号或密码无效'));
    }
    this.token = `Bearer ${result.data.trim()}`;
    this.expiresAt = Date.now() + 2 * 60 * 60 * 1_000;
  }

  async fetchRecords(startDate: string, endDate: string, outerSignal?: AbortSignal): Promise<Record<string, unknown>[]> {
    if (!this.isAuthenticated()) throw new AppError('SESSION_EXPIRED', '网约车车证系统会话已失效，请重新连接');
    const base = process.env.DATA_FUSION_ONLINE_CAR_DATA_URL?.trim() || DEFAULT_DATA_URL;
    const url = new URL(base);
    url.searchParams.set('beginTime', startDate);
    url.searchParams.set('endTime', endDate);
    url.searchParams.set('size', '10000');
    const result = await this.gate.execute(async (signal) => {
      const response = await fetch(url, { signal, headers: { authorization: this.token } });
      if (response.status === 401 || response.status === 403) {
        this.clearSession();
        throw new AppError('SESSION_EXPIRED', '网约车车证系统登录已失效，请重新连接');
      }
      if (!response.ok) throw new AppError('REMOTE_REQUEST_FAILED', `网约车车证数据请求失败（${response.status}）`);
      return response.json() as Promise<{ data?: { records?: unknown } }>;
    }, outerSignal);
    const records = result.data?.records;
    if (!Array.isArray(records)) return [];
    return records.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  }
}
