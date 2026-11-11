import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { AuthAdapter, AuthSession, SessionState } from '../../core/session/types';
import { OnlineCarPermitClient, ONLINE_CAR_PAGE_URL, ONLINE_CAR_PARTITION } from './client';
import { observeBrowserAuth, clearBrowserAuth } from '../../main/browser-auth';
import { queryOnlineCarPermits } from './query';

const SYSTEM_ID = 'online-car-permit';
const client = new OnlineCarPermitClient();
export function configureOnlineCarPermitCredentials(credentials: { account: string; password: string } | null): void { client.configureCredentials(credentials); }

class OnlineCarPermitAuth implements AuthAdapter {
  async getState(): Promise<SessionState> { return client.isAuthenticated() ? { status: 'authenticated', systemId: SYSTEM_ID, displayName: '网约车车证接口会话', expiresAt: client.sessionExpiresAt() } : { status: 'logged-out', systemId: SYSTEM_ID }; }
  async login(): Promise<SessionState> { await client.login(); return this.getState(); }
  async logout(): Promise<void> { client.clearSession(); await clearBrowserAuth(ONLINE_CAR_PARTITION); }
  async getSessionForRequest(): Promise<AuthSession> { if (!client.isAuthenticated()) throw new Error('请先连接网约车车证系统'); return { expiresAt: client.sessionExpiresAt(), metadata: { auth: 'bearer-token' } }; }
}

const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const createDefaultContext = () => { const today = new Date(); const start = new Date(today); start.setDate(today.getDate() - 4); return { page: 1, pageSize: 10_000, filters: { startDate: localDate(start), endDate: localDate(today) } }; };
const auth = new OnlineCarPermitAuth();

export const onlineCarPermitPlugin: BusinessSystemPlugin = {
  id: SYSTEM_ID, name: '惠州市网约车监管系统（车证）', version: '0.1.0',
  description: '按日期回流网络预约出租汽车运输证行政许可双公示数据。', loginMode: 'embedded', auth,
  loginPage: { url: ONLINE_CAR_PAGE_URL, partition: ONLINE_CAR_PARTITION, allowedOrigin: new URL(ONLINE_CAR_PAGE_URL).origin },
  workspaceMode: 'return-ledger', supportsCredentialConfiguration: true,
  sessionRecovery: {
    snapshot: () => client.exportSession(), restore: (value) => client.restoreSession(value),
    validate: (signal) => client.validateSession(signal), homeUrl: () => ONLINE_CAR_PAGE_URL,
  },
  matters: [{
    id: 'online-car-permit-return', name: '网约车车证', description: '提取网约车车辆运输证记录并转换为双公示行政许可模板。',
    executionMode: 'one-click-return', createDefaultContext, uniqueKey: ['xkWsh', 'xkJdrq', 'xkXdrMc'],
    querySchema: [{ key: 'startDate', label: '许可开始日期', type: 'date', required: true }, { key: 'endDate', label: '许可结束日期', type: 'date', required: true }],
    query: (context) => queryOnlineCarPermits(client, context),
  }],
  async initialize() {
    observeBrowserAuth({ partition: ONLINE_CAR_PARTITION, urlPattern: new URL(process.env.DATA_FUSION_ONLINE_CAR_DATA_URL || 'http://19.88.233.100:18080/api/tBizVehicleTrafInfo').origin + '/api/*',
      header: 'authorization', accept: (value) => client.acceptBrowserToken(value), clear: () => client.clearSession() });
    await auth.getState();
  }, getSessionState: () => auth.getState(),
};
