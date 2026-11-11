import { session, type Session } from 'electron';
import { AppError } from '../../core/errors/app-error';
import { RequestGate } from '../../core/network/request-policy';

export const MARKET_ACCESS_BASE_URL = 'http://19.88.234.125';
export const MARKET_ACCESS_HOME_URL = `${MARKET_ACCESS_BASE_URL}/app/page/frame.html`;
export const MARKET_ACCESS_PARTITION = 'persist:market-access';

export interface MarketAccessUser {
  userid: string;
  loginname: string;
  username: string;
  orgcode: string;
}

interface CurrentUserResponse {
  _error?: string;
  userinfo?: Partial<MarketAccessUser>;
}

export class MarketAccessClient {
  private readonly requestGate = new RequestGate();
  private browserSession?: Session;

  initialize(): void {
    this.browserSession = session.fromPartition(MARKET_ACCESS_PARTITION);
  }

  get session(): Session {
    if (!this.browserSession) throw new Error('市场准入系统客户端尚未初始化');
    return this.browserSession;
  }

  async currentUser(): Promise<MarketAccessUser | null> {
    try {
      const response = await this.fetchJson<CurrentUserResponse>(
        '/approve/sys/login/getCurrentUser.do',
        {},
        false,
        AbortSignal.timeout(10_000),
      );
      const user = response.userinfo;
      if (!user?.userid || !user.loginname || !user.username || !user.orgcode) return null;
      return user as MarketAccessUser;
    } catch {
      return null;
    }
  }

  async validateSession(signal: AbortSignal): Promise<{ displayName: string }> {
    const response = await this.fetchJson<CurrentUserResponse>('/approve/sys/login/getCurrentUser.do', {}, true, signal);
    const user = response.userinfo;
    if (!user?.userid || !user.loginname || !user.username || !user.orgcode) {
      throw new AppError('SESSION_EXPIRED', '市场准入系统会话已失效');
    }
    return { displayName: user.username };
  }

  async post<T>(path: string, body: unknown, outerSignal?: AbortSignal): Promise<T> {
    return this.requestGate.execute((signal) => this.fetchJson<T>(path, body, true, signal), outerSignal);
  }

  async clearSession(): Promise<void> {
    try {
      await this.session.fetch(`${MARKET_ACCESS_BASE_URL}/approve/sys/login/logout.do`, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'include',
      });
    } finally {
      await this.session.clearStorageData({ storages: ['cookies', 'localstorage'] });
    }
  }

  private async fetchJson<T>(
    path: string,
    body: unknown,
    requireAuthentication: boolean,
    signal?: AbortSignal,
  ): Promise<T> {
    const payload = JSON.stringify(body);
    const response = await this.session.fetch(`${MARKET_ACCESS_BASE_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json;charset=UTF-8',
        'X-Auth': 'torch',
      },
      body: payload,
      signal,
    });
    if (response.status === 401 || response.status === 403 || response.url.includes('/app/page/login')) {
      throw new AppError('SESSION_EXPIRED', '市场准入系统登录已失效，请重新登录');
    }
    if (!response.ok) {
      throw new AppError('REMOTE_REQUEST_FAILED', `市场准入系统请求失败（${response.status}）`);
    }
    const responseText = await response.text();
    let data: T & { _error?: string };
    try {
      data = JSON.parse(responseText) as T & { _error?: string };
    } catch {
      if (requireAuthentication) {
        throw new AppError('SESSION_EXPIRED', '市场准入系统登录已失效，请重新登录');
      }
      throw new Error('Not authenticated');
    }
    if (data?._error) throw new AppError('REMOTE_REQUEST_FAILED', data._error);
    return data;
  }
}
