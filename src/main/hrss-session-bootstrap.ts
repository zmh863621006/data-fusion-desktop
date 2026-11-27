import { BrowserWindow, session, type Session } from 'electron';
import { HRSS_HOME_URL, HRSS_ORIGIN, HRSS_PARTITION } from '../plugins/guangdong-hrss/catalog';
import { setTimeout as schedule, clearTimeout as unschedule } from 'node:timers';

export type HrssSessionKind = 'access' | 'wgbt' | 'training';
interface Entry { kind: HrssSessionKind; url?: string; menuId?: string }
interface BootstrapOptions {
  hasCredential(kind: HrssSessionKind): boolean;
  acceptCookie(kind: 'wgbt' | 'training', value: string): void;
}
const trafficGuards = new WeakMap<Session, { active: Set<number>; stopped: Set<number> }>();
function trafficGuard() {
  const browser = session.fromPartition(HRSS_PARTITION);
  let guard = trafficGuards.get(browser);
  if (!guard) {
    guard = { active: new Set(), stopped: new Set() };
    const installed = guard;
    browser.webRequest.onBeforeRequest((details, callback) => {
      // Chromium can dispatch a subframe's unload beacon even after destroy().
      // Suppress traffic only from our closing initialization WebContents.
      if (installed.stopped.has(details.webContentsId ?? -1)) { callback({ cancel: true }); return; }
      if (installed.active.has(details.webContentsId ?? -1)) {
        try { if (new URL(details.url).origin !== HRSS_ORIGIN) { callback({ cancel: true }); return; } }
        catch { callback({ cancel: true }); return; }
      }
      callback({});
    });
    trafficGuards.set(browser, guard);
  }
  return guard;
}

function entryKind(value: string): HrssSessionKind | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== HRSS_ORIGIN || url.username || url.password) return;
    if (/^\/(?:employment\/(?:main|business-tracking)|subsidize\/main)(?:\/|$)/.test(url.pathname)) return 'access';
    if (/^\/WGBT(?:\/|$)/.test(url.pathname)) return 'wgbt';
    if (/^\/ZXZJ(?:\/|$)/.test(url.pathname)) return 'training';
  } catch { /* Unconfigured links are never guessed. */ }
}
function isHomeEntry(value: string): boolean {
  try { return Boolean(entryKind(value)) && /^\/(?:employment\/(?:main|business-tracking)|subsidize\/main|WGBT|ZXZJ)(?:\/(?:index\.(?:html?|jsp))?)?$/.test(new URL(value).pathname); }
  catch { return false; }
}

/** Runs only in the source page. Its result stays in the main process, including any SSO query. */
export function hrssPortalEntryScript(open?: Pick<Entry, 'kind' | 'menuId'>): string {
  return `(() => {
    if (location.origin !== ${JSON.stringify(HRSS_ORIGIN)} || location.pathname !== '/portal/template/system.html') return null;
    if (!/系统列表/.test(document.body?.innerText || '') || !/退出/.test(document.body?.innerText || '')) return null;
    const tool = window.indexTool;
    if (!tool || typeof tool.getSsoTokenStr !== 'function') return null;
    const states = [];
    for (const node of [...document.querySelectorAll('*')].slice(0, 1000)) {
      const vm = node.__vue__;
      if (!vm) continue;
      if (vm.$store?.state?.homeStore) states.push(vm.$store.state.homeStore);
      if (vm.state?.systemMenuList) states.push(vm.state);
    }
    const menus = states.flatMap(state => [state.systemMenuList, state.allMenuList]).filter(Boolean);
    if (!menus.some(menu => Array.isArray(menu) ? menu.length : menu && typeof menu === 'object')) return null;
    const suffix = tool.getSsoTokenStr();
    if (typeof suffix !== 'string' || suffix.length > 65536 || /[\\r\\n]/.test(suffix)) return null;
    const found = [], internal = [], seen = new Set();
    const kindOf = url => /^\\/(?:employment\\/(?:main|business-tracking)|subsidize\\/main)(?:\\/|$)/.test(url.pathname) ? 'access'
      : /^\\/WGBT(?:\\/|$)/.test(url.pathname) ? 'wgbt' : /^\\/ZXZJ(?:\\/|$)/.test(url.pathname) ? 'training' : null;
    const visit = (item, depth) => {
      if (!item || typeof item !== 'object' || depth > 10 || seen.has(item)) return;
      seen.add(item);
      if (Array.isArray(item)) { item.forEach(child => visit(child, depth + 1)); return; }
      if (item.auth === '0' || item.auth === false) return;
      if (String(item.navigationType) === '1' && typeof item.prefix === 'string' && typeof item.url === 'string') {
        // Match the original toIndexPage formula, including the absolute-prefix branch.
        let entry = /^https?:\\/\\//.test(item.prefix) ? item.prefix : item.prefix + item.url;
        try {
          const url = new URL(entry, location.href);
          if (url.origin === location.origin && !url.username && !url.password &&
              /^\\/(?:employment\\/(?:main|business-tracking)|subsidize\\/main|WGBT|ZXZJ)(?:\\/(?:index\\.(?:html?|jsp))?)?$/.test(url.pathname)) {
            entry = url.href;
            if (suffix) entry += (entry.includes('?') ? '&' : '?') + suffix;
            if (entry.length <= 131072) found.push(entry);
          }
        } catch {}
      }
      // Embedded modules are opened by the source's own menu implementation.
      // Restrict this to existing query leaves, never acceptance/approval forms.
      if ((!Array.isArray(item.children) || !item.children.length) && item.id != null && typeof item.url === 'string' && item.url) {
        const prefix = item.prefix || states.map(state => state.systemInfos?.[item.sysCode]?.url).find(Boolean) || '';
        try {
          const url = new URL(/^https?:\\/\\//.test(item.url) ? item.url : String(prefix).replace(/\\/?$/, '/') + item.url, location.href);
          const kind = kindOf(url);
          const query = /查询/.test(String(item.name || '')) && !/受理|审核|审批|登记|维护|追回|划拨/.test(String(item.name || ''));
          if (kind && url.origin === location.origin && !url.username && !url.password && query && String(item.id).length <= 256) {
            internal.push({kind, menuId: String(item.id), item});
          }
        } catch {}
      }
      visit(item.children, depth + 1);
    };
    menus.forEach(menu => visit(menu, 0));
    const open = ${JSON.stringify(open ?? null)};
    if (open) {
      const target = internal.find(entry => entry.kind === open.kind && entry.menuId === open.menuId);
      if (!target || typeof tool.openTabMenu !== 'function') return false;
      // Preserve the original framework's systemInfos fallback for an embedded module.
      const copy = {...target.item};
      if (!copy.prefix && copy.sysCode) copy.prefix = states.map(state => state.systemInfos?.[copy.sysCode]?.url).find(Boolean) || '';
      tool.openTabMenu(copy);
      return true;
    }
    const entries = [...internal.map(({kind, menuId}) => ({kind, menuId})), ...new Set(found)];
    return entries.length ? entries : null;
  })()`;
}

/** Bounded, serial SSO page initialization. It never navigates or focuses the visible source tab. */
export class HrssSessionBootstrap {
  private generation = 0;
  private attempted = false;
  private attempts = 0;
  private pending?: Promise<void>;
  private readonly windows = new Set<BrowserWindow>();
  private readonly closing = new WeakMap<BrowserWindow, Promise<void>>();
  constructor(private readonly options: BootstrapOptions) {}

  onNavigate(value: string): void {
    try {
      const url = new URL(value);
      if (url.origin !== HRSS_ORIGIN || url.pathname !== '/portal/template/system.html' || this.attempted || this.pending || this.attempts >= 2) return;
    } catch { return; }
    this.attempted = true;
    this.attempts++;
    const generation = this.generation;
    this.pending = this.run(generation).catch(() => {
      if (this.generation === generation) console.warn('人社子系统会话初始化暂未完成', { systemId: 'guangdong-hrss', reason: 'HRSS_BOOTSTRAP_FAILED' });
    }).finally(() => { if (this.generation === generation) this.pending = undefined; });
  }

  async cancel(): Promise<void> {
    this.generation++;
    this.attempted = false;
    this.attempts = 0;
    this.pending = undefined;
    await Promise.all([...this.windows].map(window => this.destroy(window)));
  }

  private destroy(window: BrowserWindow): Promise<void> {
    const closing = this.closing.get(window);
    if (closing) return closing;
    const work = (async () => {
      if (window.isDestroyed()) { this.windows.delete(window); return; }
      const guard = trafficGuard(), contents = window.webContents;
      guard.active.delete(contents.id); guard.stopped.add(contents.id);
      // Child frames can dispatch unload even when BrowserWindow.destroy skips
      // the top page's handlers. Block the private target before destroying it.
      try {
        if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
        await contents.debugger.sendCommand('Network.enable');
        await contents.debugger.sendCommand('Network.setBlockedURLs', { urls: ['*'] });
        await contents.debugger.sendCommand('Page.stopLoading');
      } catch { /* The target may already have gone away during cancellation. */ }
      if (!window.isDestroyed()) window.destroy();
      this.windows.delete(window);
    })();
    this.closing.set(window, work);
    return work;
  }

  private create(): BrowserWindow {
    const window = new BrowserWindow({ show: false, webPreferences: {
      partition: HRSS_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    this.windows.add(window);
    trafficGuard().active.add(window.webContents.id);
    const allowed = (value: string) => {
      try {
        const url = new URL(value);
        return url.origin === HRSS_ORIGIN && !url.username && !url.password
          && (/^\/(?:portal|sso)(?:\/|$)/.test(url.pathname) || Boolean(entryKind(value)));
      } catch { return false; }
    };
    window.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    window.webContents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return window;
  }

  private async until<T>(window: BrowserWindow, generation: number, check: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T | undefined> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && this.generation === generation && !window.isDestroyed()) {
      let timer: ReturnType<typeof schedule> | undefined;
      try {
        const result = await Promise.race([check(), new Promise<undefined>(resolve => { timer = schedule(() => resolve(undefined), end - Date.now()); })]);
        if (result !== undefined) return result;
      } catch { /* Page may still be navigating. */ }
      finally { if (timer) unschedule(timer); }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  private async run(generation: number): Promise<void> {
    const portal = this.create();
    let entries: Entry[] = [];
    try {
      void portal.loadURL(HRSS_HOME_URL).catch(() => {});
      const values = await this.until(portal, generation, async () => {
        const result: unknown = await portal.webContents.executeJavaScript(hrssPortalEntryScript());
        return Array.isArray(result) ? result : undefined;
      });
      if (this.generation !== generation) return;
      if (!values) {
        this.attempted = false;
        console.warn('人社子系统会话初始化暂未完成', { systemId: 'guangdong-hrss', reason: 'HRSS_BOOTSTRAP_PORTAL_UNAVAILABLE' });
        return;
      }
      for (const value of values) {
        if (typeof value === 'string') {
          const kind = isHomeEntry(value) ? entryKind(value) : undefined;
          if (kind && !entries.some(entry => entry.kind === kind)) entries.push({ kind, url: value });
        } else if (value && typeof value === 'object' && ['access', 'wgbt', 'training'].includes(value.kind)
          && typeof value.menuId === 'string' && value.menuId.length <= 256 && !entries.some(entry => entry.kind === value.kind)) {
          entries.push({ kind: value.kind, menuId: value.menuId });
        }
      }
    } finally { await this.destroy(portal); }
    for (const entry of entries.slice(0, 3)) {
      if (this.generation !== generation) return;
      if (this.options.hasCredential(entry.kind)) continue;
      const source = this.create();
      try {
        void source.loadURL(entry.url ?? HRSS_HOME_URL).catch(() => {});
        let opened = !entry.menuId;
        const ready = await this.until(source, generation, async () => {
          if (this.options.hasCredential(entry.kind)) return true;
          if (!opened) {
            opened = await source.webContents.executeJavaScript(hrssPortalEntryScript(entry)) === true;
            return;
          }
          // WGBT is acquired from an actual successful source API observation;
          // ordinary portal cookies alone cannot initialize that independent session.
          if (entry.kind !== 'training' || source.webContents.isLoadingMainFrame()) return;
          const current = entry.menuId
            ? await source.webContents.executeJavaScript(`Array.from(document.querySelectorAll('iframe')).map(frame => frame.src).find(value => {
              try { const url = new URL(value); return url.origin === ${JSON.stringify(HRSS_ORIGIN)} && url.pathname.startsWith(${JSON.stringify(entry.kind === 'training' ? '/ZXZJ/' : '/WGBT/')}); } catch { return false; }
            })`) : source.webContents.getURL();
          if (entryKind(current) !== entry.kind) return;
          const cookies = await session.fromPartition(HRSS_PARTITION).cookies.get({ url: current });
          if (this.generation !== generation || source.isDestroyed()) return;
          // Read only cookies the browser would send to this actual source entry.
          if (entry.kind === 'training' && !cookies.some(cookie => cookie.name === 'hz_zxzj')) return;
          if (cookies.length) this.options.acceptCookie(entry.kind, cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
          return this.options.hasCredential(entry.kind) ? true : undefined;
        });
        if (!ready && this.generation === generation) {
          this.attempted = false;
          console.warn('人社子系统会话初始化暂未完成', {
            systemId: 'guangdong-hrss', reason: 'HRSS_BOOTSTRAP_NOT_READY', credentialKind: entry.kind,
          });
        }
      } finally { await this.destroy(source); }
    }
  }
}
