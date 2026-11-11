import { BrowserWindow } from 'electron';
import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { AuthAdapter, AuthSession, SessionState } from '../../core/session/types';
import type { BusinessMatter } from '../../core/query/types';
import { MarketAccessClient, MARKET_ACCESS_BASE_URL, MARKET_ACCESS_HOME_URL, MARKET_ACCESS_PARTITION } from './client';
import { queryBusinessApplications } from './query';

const SYSTEM_ID = 'market-access';
const client = new MarketAccessClient();

class MarketAccessAuthAdapter implements AuthAdapter {
  private state: SessionState = { status: 'logged-out', systemId: SYSTEM_ID };
  private loginWindow: BrowserWindow | null = null;
  private loginPromise: Promise<SessionState> | null = null;

  async getState(): Promise<SessionState> {
    const user = await client.currentUser();
    this.state = user
      ? { status: 'authenticated', systemId: SYSTEM_ID, displayName: user.username }
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
      width: 1180,
      height: 780,
      minWidth: 960,
      minHeight: 640,
      title: '登录广东省市场准入信息系统',
      autoHideMenuBar: true,
      webPreferences: {
        partition: MARKET_ACCESS_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.loginWindow = loginWindow;
    loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    loginWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    loginWindow.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== MARKET_ACCESS_BASE_URL) event.preventDefault();
    });
    const pendingLogin = this.waitForLogin(loginWindow);
    this.loginPromise = pendingLogin.finally(() => {
      this.loginPromise = null;
    });
    void loginWindow.loadURL(`${MARKET_ACCESS_BASE_URL}/`).catch(() => {
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
    const state = await this.getState();
    if (state.status !== 'authenticated') throw new Error('请先登录市场准入系统');
    return { metadata: { partition: MARKET_ACCESS_PARTITION } };
  }

  private waitForLogin(loginWindow: BrowserWindow): Promise<SessionState> {
    return new Promise((resolve, reject) => {
      let checking = false;
      let settled = false;
      const finish = async () => {
        if (checking || settled || loginWindow.isDestroyed()) return;
        checking = true;
        try {
          const user = await client.currentUser();
          if (!user) return;
          settled = true;
          clearInterval(timer);
          this.state = { status: 'authenticated', systemId: SYSTEM_ID, displayName: user.username };
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
        void client.currentUser().then((user) => {
          if (user) {
            settled = true;
            this.state = { status: 'authenticated', systemId: SYSTEM_ID, displayName: user.username };
            resolve(this.state);
            return;
          }
          this.state = { status: 'logged-out', systemId: SYSTEM_ID };
          reject(new Error('登录窗口已关闭，未检测到有效登录会话'));
        });
      });
    });
  }
}

const businessApplicationMatter: BusinessMatter = {
  id: 'business-application-query',
  name: '业务办理查询',
  description: '查询市场主体业务办理记录；至少填写一个查询条件。',
  uniqueKey: ['applyno'],
  querySchema: [
    { key: 'applyno', label: '业务号', type: 'text' },
    { key: 'subjectName', label: '主体名称', type: 'text' },
    {
      key: 'nameMatch', label: '主体名称匹配方式', type: 'select',
      options: [{ label: '模糊查询', value: '1' }, { label: '以前缀开头', value: '0' }],
    },
    { key: 'uniscid', label: '注册号/统一社会信用代码', type: 'text' },
    { key: 'linkman', label: '申请人（被委托人）', type: 'text' },
    { key: 'cerno', label: '申请人证件号码', type: 'text' },
    { key: 'curoper', label: '当前经办人', type: 'text' },
    { key: 'pastcuroper', label: '以往经办人', type: 'text' },
    { key: 'dom', label: '住所', type: 'text' },
    { key: 'applyDate', label: '申请日期', type: 'date-range' },
    { key: 'acceptDate', label: '受理日期', type: 'date-range' },
    { key: 'approveDate', label: '核准日期', type: 'date-range' },
    {
      key: 'subjectCategories', label: '主体大类', type: 'multi-select',
      options: [
        { label: '企业', value: 'cp' },
        { label: '个体', value: 'id' },
        { label: '农民专业合作社', value: 'nmzyhzs' },
        { label: '合作社分支机构', value: 'hzsfzzg' },
      ],
    },
  ],
  query: (context) => queryBusinessApplications(client, context),
};

const auth = new MarketAccessAuthAdapter();

export const marketAccessPlugin: BusinessSystemPlugin = {
  id: SYSTEM_ID,
  name: '广东省市场准入信息系统',
  supportsCredentialConfiguration: true,
  version: '0.1.0',
  description: '连接广东省市场准入信息系统，提供业务办理查询与本地同步。',
  auth,
  sessionRecovery: {
    snapshot: () => ({}), restore: () => {},
    validate: (signal) => client.validateSession(signal), homeUrl: () => MARKET_ACCESS_HOME_URL,
  },
  loginPage: {
    url: `${MARKET_ACCESS_BASE_URL}/`,
    partition: MARKET_ACCESS_PARTITION,
    allowedOrigin: MARKET_ACCESS_BASE_URL,
    credentialFields: { account: '#loginname', password: '#loginpwd' },
  },
  matters: [businessApplicationMatter],
  async initialize() {
    client.initialize();
    // Login validation belongs to the visible workspace/session recovery. A fresh
    // tools-only installation must not wait for an unreachable government intranet.
  },
  getSessionState: () => auth.getState(),
};
