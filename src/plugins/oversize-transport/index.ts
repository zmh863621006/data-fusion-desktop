import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { AuthAdapter, AuthSession, SessionState } from '../../core/session/types';
import { OversizeTransportClient, OVERSIZE_API_ORIGIN, OVERSIZE_HOME_URL, OVERSIZE_PAGE_URL, OVERSIZE_PARTITION, OVERSIZE_PORTAL_TOKEN_KEY } from './client';
import { observeBrowserAuth, clearBrowserAuth } from '../../main/browser-auth';
import { queryOversizeTransport } from './query';

const SYSTEM_ID = 'oversize-transport';
const client = new OversizeTransportClient();
export function configureOversizeTransportCredentials(credentials: { account: string; password: string } | null): void { client.configureCredentials(credentials); }

class OversizeAuth implements AuthAdapter {
  async getState(): Promise<SessionState> { return client.isAuthenticated() ? { status: 'authenticated', systemId: SYSTEM_ID, displayName: '大件运输许可系统会话', expiresAt: client.sessionExpiresAt() } : { status: 'logged-out', systemId: SYSTEM_ID }; }
  async login(): Promise<SessionState> { await client.login(); return this.getState(); }
  async logout(): Promise<void> { client.clearSession(); await clearBrowserAuth(OVERSIZE_PARTITION); }
  async getSessionForRequest(): Promise<AuthSession> { if (!client.isAuthenticated()) throw new Error('请先连接大件运输系统'); return { expiresAt: client.sessionExpiresAt(), metadata: { auth: 'sso-token' } }; }
}

const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const createDefaultContext = () => { const today = new Date(); const start = new Date(today); start.setDate(today.getDate() - 4); return { page: 1, pageSize: 10_000, filters: { startDate: localDate(start), endDate: localDate(today) } }; };
const auth = new OversizeAuth();

export const oversizeTransportPlugin: BusinessSystemPlugin = {
  id: SYSTEM_ID, name: '广东省交通运输厅大件运输许可系统', version: '0.1.0',
  description: '通过公路路政平台登录大件运输3.0，回流惠州许可双公示数据。', loginMode: 'embedded', auth,
  loginPage: { url: OVERSIZE_PAGE_URL, partition: OVERSIZE_PARTITION, allowedOrigin: new URL(OVERSIZE_PAGE_URL).origin,
    additionalAllowedOrigins: [OVERSIZE_API_ORIGIN], credentialPaths: ['/appLzxt/login'],
    credentialFields: { account: 'input#username, input#account, input.login_username, input.login_userName, input[placeholder*="用户名"], input[placeholder*="账号"]', password: 'input[type="password"]' },
    browserAuth: { localStorageKeys: [OVERSIZE_PORTAL_TOKEN_KEY], accept: (values) => client.acceptPortalStorage(values) } },
  workspaceMode: 'return-ledger', supportsCredentialConfiguration: true,
  sessionRecovery: {
    snapshot: () => client.exportSession(), restore: (value) => client.restoreSession(value),
    validate: (signal) => client.validateSession(signal), homeUrl: () => OVERSIZE_HOME_URL,
  },
  matters: [{
    id: 'oversize-transport-return', name: '大件运输许可', description: '按惠州编号和办理日期筛选3.0证件，再按申请编号查询办件信用代码；缺失法人由后台按代码补齐。',
    executionMode: 'one-click-return', createDefaultContext, uniqueKey: ['xkWsh', 'xkJdrq', 'xkXdrMc'],
    querySchema: [{ key: 'startDate', label: '办理开始日期', type: 'date', required: true }, { key: 'endDate', label: '办理结束日期', type: 'date', required: true }],
    query: (context) => queryOversizeTransport(client, context),
  }],
  async initialize() {
    observeBrowserAuth({ partition: OVERSIZE_PARTITION, urlPattern: OVERSIZE_API_ORIGIN + '/gddj/api/*',
      header: 'token', accept: (value) => client.acceptBrowserToken(value), clear: () => client.clearSession() });
    await auth.getState();
  }, getSessionState: () => auth.getState(),
};
