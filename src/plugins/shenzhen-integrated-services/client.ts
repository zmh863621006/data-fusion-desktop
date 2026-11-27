import { session } from 'electron';
import { AppError } from '../../core/errors/app-error';
import { SHENZHEN_HOME_URL, SHENZHEN_ORIGIN, SHENZHEN_PARTITION, SHENZHEN_SYSTEM_NAME } from './catalog';

type Row = Record<string, unknown>;
export interface ShenzhenClientOptions {
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
}

const PATHS = {
  identity: '/TRANSB/security/getUserInfoByToken',
  list: '/TRANSB/busiInstanceInfo/queryAllDealtBusiList',
  handling: '/TRANSB/busiInstanceInfo/queryBusiInstanceLog',
} as const;
export const SHENZHEN_STORAGE_KEYS = [
  'access-token', 'empno', 'empname', 'functionid', 'dynamicfunctionid',
  'dynamicfunctionidrc', 'dynamicfunctionidld', 'dynamicfunctionidrs', 'dynamicfunctionidshbz',
] as const;
const VALIDATION_TTL_MS = 30_000;
const MAX_ATTEMPTS = 5;
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const tokenValue = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 16_384 && /^[\x21-\x7e]+$/.test(value) && !/^(?:null|undefined)$/i.test(value);
const cancelled = () => new AppError('TASK_CANCELLED', '任务已取消');
const expired = () => new AppError('SESSION_EXPIRED', '深圳一体化会话已失效或切换，请在原系统重新登录');
const failed = (message: string) => new AppError('REMOTE_REQUEST_FAILED', message, { retryable: false });
const checkCancelled = (signal?: AbortSignal): void => { if (signal?.aborted) throw cancelled(); };

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(cancelled()); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', onAbort); resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort); reject(error);
    });
  });
}

function timeoutFailure(error: unknown): boolean {
  const value = error as { name?: string; code?: string; cause?: { code?: string } } | null;
  return value?.name === 'TimeoutError'
    || ['REMOTE_TIMEOUT', 'ETIMEDOUT', 'ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']
      .includes(value?.code ?? value?.cause?.code ?? '');
}

interface Validation {
  revision: number;
  controller: AbortController;
  promise: Promise<{ displayName: string }>;
  consumers: number;
  settled: boolean;
}

/** Main-process-only, read-only transport. All source requests share one serial queue. */
export class ShenzhenIntegratedClient {
  private token = '';
  private revision = 0;
  private rejected = false;
  private loginVisible = false;
  private storage: Record<string, string> = {};
  private validated?: { revision: number; at: number; value: { displayName: string } };
  private validation?: Validation;
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly fetcher: NonNullable<ShenzhenClientOptions['fetcher']>;

  constructor(options: ShenzhenClientOptions = {}) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0 ? options.timeoutMs! : 20_000;
    this.fetcher = options.fetcher ?? ((url, init) => session.fromPartition(SHENZHEN_PARTITION).fetch(url, init));
  }

  apiCredentials() {
    return { revision: this.revision, status: this.rejected ? 'expired' : this.token && !this.loginVisible ? 'present' : 'missing' } as const;
  }

  browserAuthGeneration(): number | null { return this.loginVisible ? null : this.revision; }

  acceptToken(value: string): void {
    if (this.loginVisible || !tokenValue(value) || value === this.token) return;
    this.revision++;
    this.token = value;
    this.rejected = false;
    this.validated = undefined;
    this.storage = { 'access-token': value };
  }

  acceptStorage(values: Record<string, string>): void {
    const token = values['access-token'];
    if (!tokenValue(token) || this.loginVisible) return;
    this.acceptToken(token);
    if (this.rejected || this.token !== token) return;
    for (const key of SHENZHEN_STORAGE_KEYS) {
      const value = values[key];
      if (typeof value === 'string' && value.length <= 65_536 && !/[\u0000]/.test(value)) this.storage[key] = value;
    }
  }

  setLoginVisible(visible: boolean): void {
    if (visible && !this.loginVisible) this.clear();
    this.loginVisible = visible;
  }

  noteNavigation(value: string): void {
    try {
      const url = new URL(value);
      if (url.origin !== SHENZHEN_ORIGIN) return;
      const path = url.pathname.replace(/\/$/, '');
      this.setLoginVisible(path === '/cas/login' || path === '/TRANS/login');
    } catch { /* Navigation metadata never establishes a valid API session. */ }
  }

  snapshot(): Row | null {
    return this.apiCredentials().status === 'present'
      ? { token: this.token, storage: { ...this.storage, 'access-token': this.token } } : null;
  }

  restore(value: Row): void {
    this.clear();
    this.loginVisible = false;
    const saved = object(value.storage) ? value.storage : {};
    const token = tokenValue(value.token) ? value.token : saved['access-token'];
    if (!tokenValue(token)) return;
    const storage: Record<string, string> = { 'access-token': token };
    for (const key of SHENZHEN_STORAGE_KEYS) if (typeof saved[key] === 'string') storage[key] = saved[key] as string;
    storage['access-token'] = token;
    this.acceptStorage(storage);
  }

  clear(): void {
    this.revision++;
    this.token = '';
    this.rejected = false;
    this.validated = undefined;
    this.storage = {};
  }

  private assertCurrent(revision: number): void {
    if (revision !== this.revision || this.apiCredentials().status !== 'present') throw expired();
  }

  private rejectToken(revision: number): never {
    this.assertCurrent(revision);
    this.rejected = true;
    this.revision++;
    this.validated = undefined;
    throw expired();
  }

  private async queued<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    checkCancelled(signal);
    const previous = this.tail;
    let release!: () => void;
    const slot = new Promise<void>(resolve => { release = resolve; });
    this.tail = previous.then(() => slot);
    try {
      await abortable(previous, signal);
      checkCancelled(signal);
      return await work();
    } finally { release(); }
  }

  private request(path: typeof PATHS[keyof typeof PATHS], parameters: Row, signal?: AbortSignal, revision = this.revision): Promise<unknown> {
    return this.queued(async () => {
      this.assertCurrent(revision);
      let body: string;
      try { body = JSON.stringify(parameters); }
      catch { throw new AppError('QUERY_INVALID', '深圳一体化查询条件格式无效'); }
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        checkCancelled(signal);
        this.assertCurrent(revision);
        const controller = new AbortController();
        let timedOut = false;
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
        try {
          const operation = (async () => {
            const response = await this.fetcher(SHENZHEN_ORIGIN + path, {
              method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Access-Token': this.token,
                Origin: SHENZHEN_ORIGIN, Referer: SHENZHEN_HOME_URL },
              body, redirect: 'manual', signal: controller.signal,
            });
            this.assertCurrent(revision);
            if (response.status === 401 || response.status === 403) this.rejectToken(revision);
            if (response.status >= 300 && response.status < 400) {
              const location = response.headers.get('location');
              if (location) {
                const next = new URL(location, SHENZHEN_ORIGIN);
                if (next.origin === SHENZHEN_ORIGIN && ['/cas/login', '/TRANS/login'].includes(next.pathname.replace(/\/$/, ''))) this.rejectToken(revision);
              }
              throw failed('深圳一体化接口发生跳转，请在原系统核对登录状态');
            }
            if (response.status === 429) throw new AppError('REMOTE_RATE_LIMITED', '深圳一体化请求过于频繁，请稍后重试', { retryable: false });
            if (!response.ok) throw failed(`深圳一体化请求失败（HTTP ${response.status}）`);
            if (!/\bjson\b|\+json\b/i.test(response.headers.get('content-type') ?? '')) throw failed('深圳一体化未返回有效JSON，请在原系统核对登录状态');
            let reply: unknown;
            try { reply = await response.json(); }
            catch (error) {
              if (timeoutFailure(error)) throw error;
              throw failed('深圳一体化接口JSON格式异常');
            }
            this.assertCurrent(revision);
            if (!object(reply)) throw failed('深圳一体化接口返回的数据结构异常');
            if (reply.appcode === '401' || reply.appcode === 401) this.rejectToken(revision);
            if (reply.appcode !== '0' || !Object.hasOwn(reply, 'map')) throw failed('深圳一体化未返回成功的业务结果');
            return reply.map;
          })();
          const result = await abortable(operation, controller.signal);
          checkCancelled(signal);
          this.assertCurrent(revision);
          return result;
        } catch (error) {
          if (signal?.aborted) throw cancelled();
          this.assertCurrent(revision);
          this.validated = undefined;
          if (timedOut || timeoutFailure(error)) {
            if (attempt < MAX_ATTEMPTS) continue;
            throw new AppError('REMOTE_TIMEOUT', '深圳一体化请求尝试5次仍超时，请稍后重试', { attempts: MAX_ATTEMPTS, retryable: false });
          }
          if (error instanceof AppError) throw error;
          throw failed('连接深圳一体化失败，请检查网络或原系统页面');
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        }
      }
      throw failed('深圳一体化请求未完成');
    }, signal);
  }

  async validateSession(signal?: AbortSignal, force = false): Promise<{ displayName: string }> {
    checkCancelled(signal);
    const revision = this.revision;
    this.assertCurrent(revision);
    if (!force && this.validated?.revision === revision && this.now() - this.validated.at >= 0
      && this.now() - this.validated.at < VALIDATION_TTL_MS) return { ...this.validated.value };
    let validation = this.validation;
    if (!validation || validation.revision !== revision || validation.controller.signal.aborted) {
      this.validated = undefined;
      const controller = new AbortController();
      validation = { revision, controller, consumers: 0, settled: false, promise: Promise.resolve({ displayName: '' }) };
      const current = validation;
      current.promise = (async () => {
        const reply = await this.request(PATHS.identity, {}, controller.signal, revision);
        this.assertCurrent(revision);
        if (!object(reply) || !text(reply.userId) || text(reply.userId).length > 256) throw failed('深圳一体化未返回有效的登录用户信息');
        const value = { displayName: `${SHENZHEN_SYSTEM_NAME}会话` };
        this.validated = { revision, at: this.now(), value };
        return value;
      })().catch(error => {
        if (this.revision === revision) this.validated = undefined;
        throw error;
      }).finally(() => {
        current.settled = true;
        if (this.validation === current) this.validation = undefined;
      });
      this.validation = current;
    }
    const current = validation;
    current.consumers++;
    try { return await abortable(current.promise, signal); }
    finally {
      current.consumers--;
      if (!current.settled && !current.consumers) current.controller.abort();
    }
  }

  async list(parameters: Row, signal?: AbortSignal): Promise<Row[]> {
    const value = await this.request(PATHS.list, parameters, signal);
    if (!Array.isArray(value) || value.length > 50_000 || !value.every(object)) throw failed('深圳一体化办件列表格式异常或超过保护上限，请缩小日期范围');
    return value;
  }

  async handling(parameters: { ywlsh?: string; lsh?: string }, signal?: AbortSignal): Promise<Row[]> {
    const selected: Row = {};
    for (const key of ['ywlsh', 'lsh'] as const) {
      if (typeof parameters[key] === 'string' && /[\u0000-\u001f]/.test(parameters[key]!)) throw new AppError('QUERY_INVALID', '深圳一体化办件关联编号无效');
      const value = text(parameters[key]);
      if (!value) continue;
      if (value.length > 256 || /[\u0000-\u001f]/.test(value)) throw new AppError('QUERY_INVALID', '深圳一体化办件关联编号无效');
      selected[key] = value;
    }
    if (!Object.keys(selected).length) throw new AppError('QUERY_INVALID', '深圳一体化办件缺少办理过程关联编号');
    const value = await this.request(PATHS.handling, selected, signal);
    if (!Array.isArray(value) || value.length > 10_000 || !value.every(object)) throw failed('深圳一体化办理过程格式异常或超过保护上限');
    return value;
  }
}
