import { BrowserWindow, WebContentsView, BrowserView } from 'electron';
import { sourceOrigins, type BusinessSystemPlugin } from '../core/plugins/types';
import type { SystemCredentials } from './credential-store';
import type { SourceTab, SourceTabsState } from '../core/session/source-tabs';
import type { SessionState } from '../core/session/types';
import { IPC_CHANNELS } from '../core/ipc/channels';

const BROWSER_CHROME_HEIGHT = 104;
// Early Electron versions expose incomplete experimental View properties. Use
// the stable BrowserView API there rather than probing a native contentView getter.
function modernSourceViews(): boolean {
  return Number(process.versions.electron?.split('.')[0] ?? 30) >= 30 && typeof WebContentsView === 'function';
}
export type SourcePage = Pick<BusinessSystemPlugin, 'id' | 'name' | 'loginPage'> & Partial<Pick<BusinessSystemPlugin, 'getSessionState'>>;
type Tab = { view: WebContentsView | BrowserView; summary: SourceTab; credentials: SystemCredentials | null; allowedOrigin: string; credentialFields?: { account: string; password: string };
  plugin: SourcePage; persistStorage: boolean; checkingSession?: boolean; onLoginPage?: boolean; sessionRevision: number };

interface BrowserStoragePersistence {
  load(systemId: string): Record<string, string>;
  save(systemId: string, value: unknown): Promise<void>;
  forget?(systemId: string): Promise<void>;
}

/** One live WebContents per system or publication platform. Hiding preserves its page and history. */
export class LoginTabController {
  private window: BrowserWindow | null = null;
  private readonly tabs = new Map<string, Tab>();
  private activeSystemId: string | null = null;
  private activity = 0;
  private readonly closeVersions = new Map<string, number>();
  private persistence?: BrowserStoragePersistence;
  private storageTimer?: ReturnType<typeof setInterval>;
  private sessionTimer?: ReturnType<typeof setInterval>;
  private readonly resizeListener = () => this.resize();

  state(): SourceTabsState {
    return { tabs: [...this.tabs.values()].map(({ summary }) => ({ ...summary })), activeSystemId: this.activeSystemId };
  }
  activityVersion(): number { return this.activity; }
  closeVersion(systemId: string): number { return this.closeVersions.get(systemId) ?? 0; }

  configurePersistence(persistence: BrowserStoragePersistence): void {
    this.persistence = persistence;
    if (this.storageTimer) clearInterval(this.storageTimer);
    this.storageTimer = setInterval(() => { void this.flushSessionStorage(); }, 10_000);
    this.storageTimer.unref();
  }

  private async captureStorage(tab: Tab): Promise<void> {
    if (!tab.persistStorage || !this.persistence || tab.onLoginPage || tab.view.webContents.isDestroyed()) return;
    const revision = tab.sessionRevision;
    try {
      if (new URL(tab.view.webContents.getURL()).origin !== tab.allowedOrigin) return;
      const storage = await tab.view.webContents.executeJavaScript(`location.origin === ${JSON.stringify(tab.allowedOrigin)} ? Object.fromEntries(Object.entries(sessionStorage)) : null`);
      if (tab.sessionRevision === revision && storage && typeof storage === 'object' && !Array.isArray(storage)) {
        await this.persistence.save(tab.summary.systemId, storage);
      }
    } catch { console.warn('原系统页面会话存储暂未保存', { systemId: tab.summary.systemId }); }
  }

  async flushSessionStorage(): Promise<void> {
    await Promise.all([...this.tabs.values()].map((tab) => this.captureStorage(tab)));
  }

  private async checkSession(tab: Tab): Promise<void> {
    if (!tab.plugin.getSessionState || tab.onLoginPage || tab.checkingSession || this.tabs.get(tab.summary.systemId) !== tab) return;
    tab.checkingSession = true;
    const revision = tab.sessionRevision;
    try {
      const page = tab.plugin.loginPage;
      if (page?.browserAuth && !tab.view.webContents.isDestroyed()
        && new URL(tab.view.webContents.getURL()).origin === page.allowedOrigin) {
        const captured = await tab.view.webContents.executeJavaScript(`(() => {
          if (location.origin !== ${JSON.stringify(page.allowedOrigin)}) return null;
          return Object.fromEntries([
            ...${JSON.stringify(page.browserAuth.localStorageKeys)}.map(key => [key, localStorage.getItem(key)]),
            ...${JSON.stringify(page.browserAuth.sessionStorageKeys ?? [])}.map(key => [key, sessionStorage.getItem(key)])
          ].filter(([, value]) => typeof value === 'string'));
        })()`);
        if (tab.sessionRevision !== revision || this.tabs.get(tab.summary.systemId) !== tab) return;
        if (captured && typeof captured === 'object' && !Array.isArray(captured)) page.browserAuth.accept(captured);
      }
      const state = await tab.plugin.getSessionState();
      if (tab.sessionRevision === revision) this.publishSession(tab, state);
    } catch {
      console.warn('原系统自动登录检测暂未完成', { systemId: tab.summary.systemId });
    } finally {
      tab.checkingSession = false;
      if (tab.sessionRevision !== revision) void this.checkSession(tab);
    }
  }

  private publishSession(tab: Tab, state: SessionState): void {
    if (this.tabs.get(tab.summary.systemId) !== tab || !this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    // Push only the status DTO, never a plugin, cookie or API credential.
    this.window.webContents.send(IPC_CHANNELS.systemSessionChanged, {
      systemId: tab.summary.systemId, status: state.status, displayName: state.displayName,
      expiresAt: state.expiresAt, message: state.message,
    });
  }

  open(window: BrowserWindow, plugin: SourcePage, credentials: SystemCredentials | null = null, options: { url?: string; background?: boolean; persistStorage?: boolean } = {}): void {
    const loginPage = plugin.loginPage;
    if (!loginPage) throw new Error('该业务系统没有配置原系统页面');
    const targetUrl = options.url ?? loginPage.url;
    const origins = sourceOrigins(loginPage);
    if (!origins.includes(new URL(targetUrl).origin)) throw new Error('拒绝恢复到非原系统地址');
    if (this.window && this.window !== window) this.close();
    if (!this.window) {
      this.window = window;
      window.on('resize', this.resizeListener);
    }
    const existing = this.tabs.get(plugin.id);
    if (existing && !existing.view.webContents.isDestroyed()) {
      const previous = existing.credentials;
      existing.credentials = credentials;
      this.activate(plugin.id);
      if (!existing.summary.loading) {
        // An explicit authenticated open may replace the exact login entry, never a business page.
        if (options.url && targetUrl !== loginPage.url && existing.view.webContents.getURL() === loginPage.url) {
          void existing.view.webContents.loadURL(targetUrl).catch(() => {
            existing.summary.error = '原系统首页加载失败，请检查网络后点击刷新';
            this.publish();
          });
        } else this.fillCredentials(existing, previous);
      }
      return;
    }
    if (existing) this.close(plugin.id);

    const SourceView = modernSourceViews() ? WebContentsView : BrowserView;
    const view = new SourceView({
      webPreferences: { partition: loginPage.partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const tab: Tab = { view, credentials, plugin, persistStorage: options.persistStorage !== false, allowedOrigin: loginPage.allowedOrigin, credentialFields: loginPage.credentialFields, sessionRevision: 0, summary: {
      systemId: plugin.id, systemName: plugin.name, displayUrl: this.displayUrl(loginPage.url), loading: true,
    } };
    this.tabs.set(plugin.id, tab);
    if (!this.sessionTimer) {
      // Main-process polling includes background source tabs and is not throttled with a hidden renderer.
      this.sessionTimer = setInterval(() => { for (const source of this.tabs.values()) void this.checkSession(source); }, 5_000);
      this.sessionTimer.unref();
    }
    const allowed = (url: string) => {
      try { return origins.includes(new URL(url).origin); } catch { return false; }
    };
    const update = () => {
      if (this.tabs.get(plugin.id) !== tab) return;
      tab.summary.displayUrl = this.displayUrl(view.webContents.getURL() || loginPage.url);
      this.publish();
    };
    const loginPath = new URL(loginPage.url).pathname.replace(/\/$/, '');
    const observe = (url: string, successfulMainFrame: boolean) => {
      if (this.tabs.get(plugin.id) !== tab) return;
      if (successfulMainFrame && loginPage.onLoginPageChange && allowed(url)) {
        const page = new URL(url);
        const visible = page.origin === loginPage.allowedOrigin && page.pathname.replace(/\/$/, '') === loginPath;
        if (visible !== tab.onLoginPage) {
          tab.onLoginPage = visible;
          tab.sessionRevision++;
          loginPage.onLoginPageChange(visible);
          if (visible) {
            void this.persistence?.forget?.(plugin.id).catch(() => {
              console.warn('原系统会话快照暂未清除', { systemId: plugin.id });
            });
            this.publishSession(tab, { systemId: plugin.id, status: 'logged-out' });
          }
        }
      }
      loginPage.onNavigate?.(url);
      update();
      void this.checkSession(tab);
    };
    view.webContents.on('did-navigate', (_event, url, status) => observe(url, !(status >= 400)));
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => observe(url, isMainFrame));
    view.webContents.on('did-start-loading', () => { tab.summary.loading = true; tab.summary.error = undefined; update(); });
    view.webContents.on('did-stop-loading', () => { tab.summary.loading = false; update(); });
    view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        tab.summary.error = '原系统页面加载失败，请检查网络后点击刷新';
        tab.summary.loading = false;
        console.warn('原系统页面加载失败', { systemId: plugin.id, errorCode: code,
          reason: /^ERR_[A-Z_]+$/.test(description) ? description : 'LOAD_FAILED' });
        update();
      }
    });
    view.webContents.on('render-process-gone', () => {
      tab.summary.loading = false;
      tab.summary.error = '原系统页面已停止响应，请点击刷新恢复';
      update();
    });
    view.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    view.webContents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    view.webContents.on('will-attach-webview', (event) => event.preventDefault());
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (allowed(url)) setImmediate(() => {
        if (!view.webContents.isDestroyed()) void view.webContents.loadURL(url).catch(() => {});
      });
      return { action: 'deny' };
    });
    let storageRestored = false;
    view.webContents.on('did-finish-load', () => { void this.checkSession(tab); });
    view.webContents.on('did-finish-load', () => { void (async () => {
      // Never copy the portal's sessionStorage into a cross-origin SSO destination.
      if (tab.persistStorage && !tab.onLoginPage && !storageRestored && this.persistence && new URL(view.webContents.getURL()).origin === loginPage.allowedOrigin) {
        storageRestored = true;
        const revision = tab.sessionRevision;
        const saved = this.persistence.load(plugin.id);
        if (Object.keys(saved).length) {
          const changed = await view.webContents.executeJavaScript(`(() => {
            if (location.origin !== ${JSON.stringify(loginPage.allowedOrigin)}) return false;
            let changed = false;
            for (const [key, value] of Object.entries(${JSON.stringify(saved)})) {
              if (sessionStorage.getItem(key) === null) { sessionStorage.setItem(key, value); changed = true; }
            }
            return changed;
          })()`);
          if (changed && tab.sessionRevision === revision && !view.webContents.isDestroyed()) {
            await view.webContents.loadURL(targetUrl);
            return;
          }
        }
      }
      this.fillCredentials(tab);
      await this.captureStorage(tab);
    })().catch(() => console.warn('原系统页面会话恢复暂未完成', { systemId: plugin.id })); });
    if (!options.background) this.activate(plugin.id);
    else this.publish();
    void view.webContents.loadURL(targetUrl).catch((error: unknown) => {
      const failure = error as { code?: unknown; errno?: unknown } | null;
      // SSO/page navigation can replace an unfinished login load. Its cancellation is not a failed page.
      if (failure?.code === 'ERR_ABORTED' || failure?.errno === -3) return;
      if (!tab.summary.error) console.warn('原系统页面加载失败', { systemId: plugin.id,
        errorCode: typeof failure?.errno === 'number' ? failure.errno : undefined,
        reason: typeof failure?.code === 'string' && /^ERR_[A-Z_]+$/.test(failure.code) ? failure.code : 'LOAD_FAILED' });
      tab.summary.loading = false;
      tab.summary.error = '原系统页面加载失败，请检查网络后点击刷新';
      update();
    });
  }

  // Populate only the original site's login form. Never submit or replace user-entered values.
  private fillCredentials(tab: Tab, previous: SystemCredentials | null = null): void {
    if (!tab.credentials || tab.view.webContents.isDestroyed()) return;
    try {
      const url = new URL(tab.view.webContents.getURL());
      if (url.origin !== tab.allowedOrigin) return;
      if (tab.plugin.loginPage?.credentialPaths && !tab.plugin.loginPage.credentialPaths.includes(url.pathname)) return;
    } catch { return; }
    const script = `(() => {
        const expectedOrigin = ${JSON.stringify(tab.allowedOrigin)};
        if (location.origin !== expectedOrigin) return;
        const allowedPaths = ${JSON.stringify(tab.plugin.loginPage?.credentialPaths ?? null)};
        if (allowedPaths && !allowedPaths.includes(location.pathname)) return;
        window.__dataFusionLoginFillCleanup?.();
        const values = ${JSON.stringify(tab.credentials)};
        const previous = ${JSON.stringify(previous)};
        const fields = ${JSON.stringify(tab.credentialFields ?? null)};
        const fill = () => {
          if (location.origin !== expectedOrigin || allowedPaths && !allowedPaths.includes(location.pathname)) return false;
          const inputs = [...document.querySelectorAll('input')].filter(el => el.getClientRects().length && !el.disabled);
          const password = inputs.find(el => fields ? el.matches(fields.password) : el.type === 'password');
          if (!password) return false;
          const siblings = inputs.filter(el => el.form === password.form);
          const account = fields ? siblings.find(el => el.matches(fields.account)) : siblings.find(el => ['text', 'email', 'tel'].includes(el.type)
            && /username|account|loginname|用户名|账号/i.test(el.name + ' ' + el.id + ' ' + el.placeholder + ' ' + el.autocomplete));
          if (!account) return false;
          // Legacy login pages switch text fields to password only on focus. Mask before autofill,
          // without moving focus, and only for the explicitly configured password field.
          if (fields && password.type === 'text') password.type = 'password';
          const set = (el, value, oldValue) => {
            if (el.value && el.value !== oldValue) return;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };
          set(account, values.account, previous?.account); set(password, values.password, previous?.password);
          return true;
        };
        if (!fill()) {
          const cleanup = () => { observer.disconnect(); clearTimeout(timer); delete window.__dataFusionLoginFillCleanup; };
          const observer = new MutationObserver(() => { if (fill()) cleanup(); });
          observer.observe(document.documentElement, { childList: true, subtree: true });
          const timer = setTimeout(cleanup, 30000);
          window.__dataFusionLoginFillCleanup = cleanup;
        }
      })()`;
    void tab.view.webContents.executeJavaScript(script).catch(() => {
      console.warn('原系统登录表单未能自动填入，请在页面中手动输入', { systemId: tab.summary.systemId });
    });
  }

  activate(systemId: string | null): void {
    this.activity++;
    if (systemId !== null) this.requireTab(systemId);
    if (this.activeSystemId) {
      const current = this.tabs.get(this.activeSystemId);
      if (current && this.window && !this.window.isDestroyed()) {
        if (modernSourceViews()) this.window.contentView.removeChildView(current.view as WebContentsView);
        else this.window.removeBrowserView(current.view as BrowserView);
      }
    }
    this.activeSystemId = systemId;
    if (systemId && this.window && !this.window.isDestroyed()) {
      const view = this.requireTab(systemId).view;
      if (modernSourceViews()) this.window.contentView.addChildView(view as WebContentsView);
      else this.window.addBrowserView(view as BrowserView);
      this.resize();
      this.requireTab(systemId).view.webContents.focus();
    } else if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.focus();
    }
    this.publish();
  }

  close(systemId?: string): void {
    if (systemId !== undefined) {
      this.closeVersions.set(systemId, this.closeVersion(systemId) + 1);
      const tab = this.tabs.get(systemId);
      if (!tab) return;
      if (this.activeSystemId === systemId) this.activate(null);
      this.tabs.delete(systemId);
      if (!this.tabs.size && this.sessionTimer) { clearInterval(this.sessionTimer); this.sessionTimer = undefined; }
      if (!tab.view.webContents.isDestroyed()) {
        if (modernSourceViews() && typeof tab.view.webContents.close === 'function') tab.view.webContents.close();
        else (tab.view.webContents as unknown as { destroy(): void }).destroy();
      }
      this.publish();
      return;
    }
    for (const id of [...this.tabs.keys()]) this.close(id);
    if (this.storageTimer) clearInterval(this.storageTimer);
    if (this.sessionTimer) clearInterval(this.sessionTimer);
    this.storageTimer = undefined;
    this.sessionTimer = undefined;
    if (this.window && !this.window.isDestroyed()) this.window.off('resize', this.resizeListener);
    this.window = null;
  }

  reload(systemId: string): void { this.requireTab(systemId).view.webContents.reload(); }

  back(systemId: string): boolean {
    const contents = this.requireTab(systemId).view.webContents;
    if (modernSourceViews() && contents.navigationHistory) {
      if (!contents.navigationHistory.canGoBack()) return false;
      contents.navigationHistory.goBack();
    } else {
      if (!contents.canGoBack()) return false;
      contents.goBack();
    }
    return true;
  }

  currentSystemId(): string | null { return this.activeSystemId; }

  private requireTab(systemId: string): Tab {
    const tab = this.tabs.get(systemId);
    if (!tab || tab.view.webContents.isDestroyed()) throw new Error('该系统标签页已关闭，请重新打开');
    return tab;
  }

  private publish(): void {
    if (this.window && !this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send(IPC_CHANNELS.systemTabsChanged, this.state());
    }
  }

  private displayUrl(url: string): string {
    try { const parsed = new URL(url); return parsed.origin + parsed.pathname; } catch { return ''; }
  }

  private resize(): void {
    if (!this.window || !this.activeSystemId || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    const sidebarWidth = width <= 1_250 ? 220 : 260;
    this.requireTab(this.activeSystemId).view.setBounds({
      x: sidebarWidth, y: BROWSER_CHROME_HEIGHT,
      width: Math.max(0, width - sidebarWidth), height: Math.max(0, height - BROWSER_CHROME_HEIGHT),
    });
  }
}

export const loginTabController = new LoginTabController();
