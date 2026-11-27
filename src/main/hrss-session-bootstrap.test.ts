import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ windows: [] as any[], entries: [] as string[], onLoad: (_url: string) => {}, cookies: [] as any[] }));
vi.mock('electron', () => ({
  session: { fromPartition: vi.fn(() => ({ cookies: { get: vi.fn(async () => mocks.cookies) }, webRequest: { onBeforeRequest: vi.fn() } })) },
  BrowserWindow: class extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      id: mocks.windows.length + 1,
      debugger: { isAttached: () => false, attach: vi.fn(), sendCommand: vi.fn(async () => {}) },
      getURL: () => this.url, isLoadingMainFrame: () => false,
      executeJavaScript: vi.fn(async () => mocks.entries), setWindowOpenHandler: vi.fn(),
    });
    url = '';
    constructor(public options: unknown) { super(); mocks.windows.push(this); }
    loadURL = vi.fn(async (url: string) => { this.url = url; mocks.onLoad(url); });
    isDestroyed = () => this.destroyed;
    destroy = vi.fn(() => { this.destroyed = true; });
  },
}));
import { HrssSessionBootstrap, hrssPortalEntryScript, type HrssSessionKind } from './hrss-session-bootstrap';

beforeEach(() => { mocks.windows = []; mocks.entries = []; mocks.cookies = []; mocks.onLoad = () => {}; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const home = 'https://hrss.gdgov.cn/portal/template/system.html';

function extract(menus: unknown, suffix = 'fixture-sso=secret', path = '/portal/template/system.html') {
  return runInNewContext(hrssPortalEntryScript(), {
    location: { origin: 'https://hrss.gdgov.cn', pathname: path, href: home }, URL,
    document: { body: { innerText: '系统列表 退出' }, querySelectorAll: () => [{ __vue__: { $store: { state: { homeStore: { systemMenuList: menus } } } } }] },
    window: { indexTool: { getSsoTokenStr: () => suffix } },
  });
}

it('uses the original menu formula and optional SSO suffix, never inventing an entry from its name', () => {
  const menus = [
    { navigationType: '1', prefix: 'https://hrss.gdgov.cn/employment/main/index.html?existing=1', url: '/must-not-append' },
    { navigationType: '1', prefix: '/WGBT/', url: 'index.jsp' },
    { children: [{ navigationType: '1', prefix: '/ZXZJ/', url: 'index.jsp' }] },
    { navigationType: '1', prefix: 'https://evil.example/ZXZJ/', url: '' },
    { navigationType: '1', prefix: '/WGBT-unapproved/', url: '' },
    { navigationType: '1', prefix: '/sso/logout', url: '' },
    { navigationType: '1', prefix: '/subsidize/main/api/auth/logout', url: '' },
    { navigationType: '1', prefix: '/ZXZJ/jycyzjgl/web/cypxbt/cksl/cksl.do', url: '' },
    { navigationType: '1', prefix: '/WGBT/', url: 'denied.jsp', auth: '0' },
    { name: '就业管理', prefix: '/employment/main/', url: 'index.html' },
  ];
  expect(extract(menus)).toEqual([
    'https://hrss.gdgov.cn/employment/main/index.html?existing=1&fixture-sso=secret',
    'https://hrss.gdgov.cn/WGBT/index.jsp?fixture-sso=secret',
    'https://hrss.gdgov.cn/ZXZJ/index.jsp?fixture-sso=secret',
  ]);
  expect(extract(menus, '')).toHaveLength(3);
  expect(extract(menus, '', '/sso/login.html')).toBeNull();
  expect(extract([{ id: 'still-loading' }])).toBeNull();
});

it('selects an embedded query leaf from its actual menu, skipping acceptance and unknown systems', () => {
  const menus = [{ navigationType: '2', prefix: null, url: null, children: [
    { id: 'query', name: '查询进度（创业培训补贴）', prefix: 'https://hrss.gdgov.cn/ZXZJ/', url: 'jycyzjgl/web/cypxbt/cxjd/cxjd.do' },
    { id: 'accept', name: '窗口受理（创业培训补贴）', prefix: 'https://hrss.gdgov.cn/ZXZJ/', url: 'jycyzjgl/web/cypxbt/cksl/cksl.do' },
    { id: 'external', name: '查询进度', prefix: 'https://evil.example/ZXZJ/', url: 'query' },
  ] }];
  expect(extract(menus)).toEqual([{ kind: 'training', menuId: 'query' }]);
});

it('initializes existing authorized source entries serially without displaying or reusing a source window', async () => {
  mocks.entries = ['https://evil.example/employment/main/', 'https://hrss.gdgov.cn/employment/main/', 'https://hrss.gdgov.cn/subsidize/main/', 'https://hrss.gdgov.cn/WGBT/', 'https://hrss.gdgov.cn/ZXZJ/'];
  const ready = new Set<HrssSessionKind>();
  mocks.onLoad = url => {
    const live = mocks.windows.filter(window => !window.destroyed);
    expect(live).toHaveLength(1);
    if (url.includes('/employment/')) ready.add('access');
    else if (url.includes('/WGBT/')) ready.add('wgbt');
    else if (url.includes('/ZXZJ/')) ready.add('training');
  };
  const bootstrap = new HrssSessionBootstrap({ hasCredential: kind => ready.has(kind), acceptCookie: vi.fn() });
  bootstrap.onNavigate('https://hrss.gdgov.cn/sso/login.html');
  expect(mocks.windows).toHaveLength(0);
  bootstrap.onNavigate(home); bootstrap.onNavigate(home);
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(4));
  expect(ready.size).toBe(3);
  expect(mocks.windows.every(window => window.destroyed)).toBe(true);
  expect(mocks.windows.map(window => window.url)).toEqual([home, mocks.entries[1], mocks.entries[3], mocks.entries[4]]);
  for (const window of mocks.windows) expect(window.options).toMatchObject({ show: false, webPreferences: {
    partition: 'persist:guangdong-hrss', sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  bootstrap.onNavigate(home);
  expect(mocks.windows).toHaveLength(4);
});

it('cancels pending initialization on sign-out and ignores its late result; a fresh login can try again', async () => {
  vi.useFakeTimers();
  mocks.entries = ['https://hrss.gdgov.cn/employment/main/'];
  const bootstrap = new HrssSessionBootstrap({ hasCredential: () => false, acceptCookie: vi.fn() });
  bootstrap.onNavigate(home);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.windows).toHaveLength(2);
  bootstrap.cancel();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.windows).toHaveLength(2);
  expect(mocks.windows.every(window => window.destroyed)).toBe(true);
  bootstrap.onNavigate(home);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.windows).toHaveLength(4);
  bootstrap.cancel(); await vi.advanceTimersByTimeAsync(250);
});

it('rejects external redirects and never opens source popups during initialization', async () => {
  const bootstrap = new HrssSessionBootstrap({ hasCredential: () => true, acceptCookie: vi.fn() });
  bootstrap.onNavigate(home);
  const source = mocks.windows[0];
  const blocked = { preventDefault: vi.fn() }, allowed = { preventDefault: vi.fn() };
  source.webContents.emit('will-redirect', blocked, 'https://evil.example/steal');
  source.webContents.emit('will-navigate', allowed, 'https://hrss.gdgov.cn/sso/login.html');
  expect(blocked.preventDefault).toHaveBeenCalledOnce(); expect(allowed.preventDefault).not.toHaveBeenCalled();
  expect(source.webContents.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://evil.example/' })).toEqual({ action: 'deny' });
  bootstrap.cancel();
});

it('does not mistake a portal cookie for a completed WGBT login', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.entries = ['https://hrss.gdgov.cn/WGBT/'];
  mocks.cookies = [{ name: 'portal', value: 'synthetic' }];
  const acceptCookie = vi.fn();
  const bootstrap = new HrssSessionBootstrap({ hasCredential: () => false, acceptCookie });
  bootstrap.onNavigate(home);
  await vi.advanceTimersByTimeAsync(16_000);
  expect(acceptCookie).not.toHaveBeenCalled();
  expect(mocks.windows.every(window => window.destroyed)).toBe(true);
  await bootstrap.cancel();
});
