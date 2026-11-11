import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { BusinessMatter } from '../../core/query/types';
import type { AuthAdapter, AuthSession, SessionState } from '../../core/session/types';
import { PractitionerClient, PRACTITIONER_BASE_URL, PRACTITIONER_HOME_URL, PRACTITIONER_PAGE_URL, PRACTITIONER_PARTITION } from './client';
import { observeBrowserAuth, clearBrowserAuth } from '../../main/browser-auth';
import { queryPractitionerCategory } from './query';

const SYSTEM_ID = 'transport-practitioner';
const client = new PractitionerClient();

export function configurePractitionerCredentials(credentials: { account: string; password: string } | null): void {
  client.configureCredentials(credentials);
}

class PractitionerAuthAdapter implements AuthAdapter {
  async getState(): Promise<SessionState> {
    return client.isAuthenticated()
      ? { status: 'authenticated', systemId: SYSTEM_ID, displayName: '省从业人员平台会话', expiresAt: client.sessionExpiresAt() }
      : { status: 'logged-out', systemId: SYSTEM_ID };
  }

  async login(): Promise<SessionState> {
    await client.login();
    return this.getState();
  }

  async logout(): Promise<void> {
    client.clearSession();
    await clearBrowserAuth(PRACTITIONER_PARTITION);
  }

  async getSessionForRequest(): Promise<AuthSession> {
    if (!client.isAuthenticated()) throw new Error('请先连接从业人员系统');
    return { expiresAt: client.sessionExpiresAt(), metadata: { auth: 'gateway-token' } };
  }
}

const localDate = (value: Date): string => {
  const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
};

const createDefaultContext = () => {
    const today = new Date();
    const fiveDayStart = new Date(today);
    fiveDayStart.setDate(today.getDate() - 4);
    return { page: 1, pageSize: 200_000, filters: { startDate: localDate(fiveDayStart), endDate: localDate(today) } };
};

const querySchema: BusinessMatter['querySchema'] = [
  { key: 'startDate', label: '发证开始日期', type: 'date', required: true },
  { key: 'endDate', label: '发证结束日期', type: 'date', required: true },
];

const roadPractitionerMatter: BusinessMatter = {
  id: 'road-practitioner-return',
  name: '道路运输从业人员',
  description: '按发证日期提取道路运输从业人员档案，并转换为行政许可双公示模板。',
  executionMode: 'one-click-return',
  createDefaultContext,
  uniqueKey: ['xkXdrZjhm', 'xkJdrq'],
  querySchema,
  query: (context) => queryPractitionerCategory(client, 'road', context),
};

const taxiDriverMatter: BusinessMatter = {
  id: 'taxi-driver-return',
  name: '出租车驾驶员',
  description: '按发证日期提取出租车驾驶员档案，并按网约车/巡游车较新证件日期生成双公示数据。',
  executionMode: 'one-click-return',
  createDefaultContext,
  uniqueKey: ['xkXdrZjhm', 'xkJdrq'],
  querySchema: [
    { key: 'startDate', label: '发证开始日期', type: 'date', required: true },
    { key: 'endDate', label: '发证结束日期', type: 'date', required: true },
  ],
  query: (context) => queryPractitionerCategory(client, 'taxi', context),
};

const auth = new PractitionerAuthAdapter();

export const transportPractitionerPlugin: BusinessSystemPlugin = {
  id: SYSTEM_ID,
  name: '广东省道路运输从业人员管理服务平台',
  version: '0.1.0',
  description: '回流惠州市从业人员行政许可双公示数据。',
  workspaceMode: 'return-ledger',
  supportsCredentialConfiguration: true,
  loginMode: 'embedded',
  loginPage: { url: PRACTITIONER_PAGE_URL, partition: PRACTITIONER_PARTITION, allowedOrigin: new URL(PRACTITIONER_PAGE_URL).origin },
  auth,
  sessionRecovery: {
    snapshot: () => client.exportSession(), restore: (value) => client.restoreSession(value),
    validate: (signal) => client.validateSession(signal), homeUrl: () => PRACTITIONER_HOME_URL,
  },
  matters: [roadPractitionerMatter, taxiDriverMatter],
  async initialize() {
    observeBrowserAuth({ partition: PRACTITIONER_PARTITION, urlPattern: PRACTITIONER_BASE_URL + 'api/*/DataService*',
      header: 'token', accept: (value) => client.acceptBrowserToken(value), clear: () => client.clearSession() });
    await auth.getState();
  },
  getSessionState: () => auth.getState(),
};
