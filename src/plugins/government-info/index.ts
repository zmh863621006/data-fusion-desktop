import { BrowserWindow } from 'electron';
import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { BusinessMatter } from '../../core/query/types';
import type { AuthAdapter, AuthSession, SessionState } from '../../core/session/types';
import {
  GOVERNMENT_INFO_BASE_URL,
  GOVERNMENT_INFO_LOGIN_URL,
  GOVERNMENT_INFO_PARTITION,
  GovernmentInfoClient,
} from './client';
import { GOVERNMENT_MATTERS, type GovernmentMatterDefinition } from './matter-catalog';
import { queryApprovalData } from './query';
import { mergeCertificateRecord } from './certificate-fields';

const SYSTEM_ID = 'government-info';
const client = new GovernmentInfoClient();

export function configureGovernmentInfoSessionPersistence(options: {
  load: () => Promise<string | null>;
  save: (lid: string) => Promise<void>;
  clear: () => Promise<void>;
}): void {
  client.configureSessionPersistence(options);
}

class GovernmentInfoAuthAdapter implements AuthAdapter {
  private state: SessionState = { status: 'logged-out', systemId: SYSTEM_ID };
  private loginWindow: BrowserWindow | null = null;
  private loginPromise: Promise<SessionState> | null = null;

  async getState(): Promise<SessionState> {
    this.state = await client.isAuthenticated()
      ? { status: 'authenticated', systemId: SYSTEM_ID, displayName: '综合信息平台会话' }
      : { status: 'logged-out', systemId: SYSTEM_ID };
    return this.state;
  }

  async login(): Promise<SessionState> {
    if (this.loginPromise && this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus();
      return this.loginPromise;
    }
    this.state = { status: 'logging-in', systemId: SYSTEM_ID };
    const loginWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 1024,
      minHeight: 680,
      title: '登录政务综合信息平台',
      autoHideMenuBar: true,
      webPreferences: {
        partition: GOVERNMENT_INFO_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.loginWindow = loginWindow;
    const capture = (_event?: unknown, url?: string) => client.captureLid(url ?? loginWindow.webContents.getURL());
    loginWindow.webContents.on('did-navigate', capture);
    loginWindow.webContents.on('did-navigate-in-page', capture);
    loginWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    loginWindow.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== GOVERNMENT_INFO_BASE_URL) event.preventDefault();
    });
    loginWindow.webContents.setWindowOpenHandler(({ url }) => (
      new URL(url).origin === GOVERNMENT_INFO_BASE_URL
        ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { partition: GOVERNMENT_INFO_PARTITION } } }
        : { action: 'deny' }
    ));
    const pending = this.waitForLogin(loginWindow);
    this.loginPromise = pending.finally(() => { this.loginPromise = null; });
    void loginWindow.loadURL(GOVERNMENT_INFO_LOGIN_URL).catch(() => {
      if (!loginWindow.isDestroyed()) loginWindow.close();
    });
    return this.loginPromise;
  }

  async logout(): Promise<void> {
    this.loginWindow?.close();
    this.loginWindow = null;
    await client.clearSession();
    this.state = { status: 'logged-out', systemId: SYSTEM_ID };
  }

  async getSessionForRequest(): Promise<AuthSession> {
    if (!(await client.isAuthenticated())) throw new Error('请先登录政务综合信息平台');
    return { metadata: { partition: GOVERNMENT_INFO_PARTITION } };
  }

  private waitForLogin(loginWindow: BrowserWindow): Promise<SessionState> {
    return new Promise((resolve, reject) => {
      let checking = false;
      let settled = false;
      const finish = async () => {
        if (checking || settled || loginWindow.isDestroyed()) return;
        checking = true;
        try {
          client.captureLid(loginWindow.webContents.getURL());
          if (!(await client.isAuthenticated())) return;
          settled = true;
          clearInterval(timer);
          this.state = { status: 'authenticated', systemId: SYSTEM_ID, displayName: '综合信息平台会话' };
          this.loginWindow = null;
          if (!loginWindow.isDestroyed()) loginWindow.close();
          resolve(this.state);
        } finally {
          checking = false;
        }
      };
      const timer = setInterval(() => { void finish(); }, 1_000);
      loginWindow.webContents.on('did-finish-load', () => { void finish(); });
      loginWindow.once('closed', () => {
        clearInterval(timer);
        this.loginWindow = null;
        if (settled) return;
        void client.isAuthenticated().then((authenticated) => {
          if (authenticated) {
            settled = true;
            this.state = { status: 'authenticated', systemId: SYSTEM_ID, displayName: '综合信息平台会话' };
            resolve(this.state);
          } else {
            this.state = { status: 'logged-out', systemId: SYSTEM_ID };
            reject(new Error('登录窗口已关闭，未检测到有效的 LSID 和 lid'));
          }
        });
      });
    });
  }
}

function createApprovalMatter(definition: GovernmentMatterDefinition): BusinessMatter {
  return {
    id: definition.id,
    name: definition.name,
    departmentId: definition.departmentId,
    departmentName: definition.departmentName,
    departmentOrder: definition.departmentOrder,
    matterOrder: definition.matterOrder,
    description: definition.supportsDoublePublicityEnrichment
      ? '按原项目规则提取、去重并补全双公示字段。'
      : definition.supportsCertificateEnrichment
      ? '保留导出基础数据，按详情部分补充证件名称、编号、制证日期和有效期；不表示完整双公示。'
      : '按原项目规则提取、筛选并保存原始审批数据。',
    mergeRecord: definition.supportsCertificateEnrichment ? mergeCertificateRecord : undefined,
    executionMode: 'one-click-return',
    createDefaultContext: () => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const localDate = (value: Date) => {
      const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
      return shifted.toISOString().slice(0, 10);
    };
    return {
      page: 1,
      pageSize: 5_000,
      filters: {
        startDate: localDate(yesterday),
        endDate: localDate(today),
      },
    };
    },
    uniqueKey: ['cityLsh'],
    querySchema: [
      { key: 'startDate', label: '办结开始日期', type: 'date', required: true },
      { key: 'endDate', label: '办结截止日期', type: 'date', required: true },
    ],
    query: (context) => queryApprovalData(client, {
      ...context,
      filters: {
        ...context.filters,
        maxRows: 5_000,
        matterName: definition.name,
        sxType: definition.sxType,
      },
    }),
  };
}

const approvalReturnMatters = GOVERNMENT_MATTERS.map(createApprovalMatter);

const auth = new GovernmentInfoAuthAdapter();

export const governmentInfoPlugin: BusinessSystemPlugin = {
  id: SYSTEM_ID,
  name: '政务综合信息平台',
  supportsCredentialConfiguration: true,
  workspaceMode: 'return-ledger',
  version: '0.1.0',
  description: '连接南山区政务综合信息平台，回流双公示审批数据。',
  auth,
  sessionRecovery: {
    snapshot: () => client.exportSession(), restore: (value) => client.restoreSession(value),
    validate: (signal) => client.validateSession(signal), homeUrl: () => client.homeUrl(),
  },
  loginPage: {
    url: GOVERNMENT_INFO_LOGIN_URL,
    partition: GOVERNMENT_INFO_PARTITION,
    allowedOrigin: GOVERNMENT_INFO_BASE_URL,
    credentialFields: { account: '#txt_flag', password: '#txt_pwd' },
    onNavigate: (url) => client.captureLid(url),
  },
  matters: approvalReturnMatters,
  async initialize() {
    await client.initialize();
    await auth.getState();
  },
  getSessionState: () => auth.getState(),
};
