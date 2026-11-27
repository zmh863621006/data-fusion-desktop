import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { BusinessSystemPlugin } from '../core/plugins/types';

const mocks = vi.hoisted(() => ({ views: [] as any[], nextLoadError: null as (Error & { code?: string; errno?: number }) | null }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { BrowserWindow: class {}, WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      url: '', destroyed: false,
      getURL() { return this.url; }, isDestroyed() { return this.destroyed; },
      loadURL: vi.fn(async (url: string) => { this.webContents.url = url; const error = mocks.nextLoadError; mocks.nextLoadError = null; if (error) throw error; }),
      close: vi.fn(() => { this.webContents.destroyed = true; }),
      reload: vi.fn(), focus: vi.fn(), executeJavaScript: vi.fn(async () => undefined),
      navigationHistory: { canGoBack: vi.fn(() => true), goBack: vi.fn() },
      setWindowOpenHandler: vi.fn(),
    });
    setBounds = vi.fn();
    constructor(public options: unknown) { mocks.views.push(this); }
  } };
});
import { LoginTabController, type SourcePage } from './login-tab';
import { IPC_CHANNELS } from '../core/ipc/channels';
import { REVIEWED_CERTIFICATE } from './source-endpoint-certificate.test-fixture';

afterEach(() => { vi.useRealTimers(); });

function plugin(id: string): BusinessSystemPlugin {
  return { id, name: `System ${id}`, version: '1.0.0', matters: [],
    auth: {} as BusinessSystemPlugin['auth'], initialize: async () => {},
    getSessionState: async () => ({ status: 'logged-out', systemId: id }),
    loginPage: { url: `https://${id}.example/login?sid=SECRET#lid=SECRET`, allowedOrigin: `https://${id}.example`, partition: `persist:${id}` },
  };
}
function windowMock() {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getContentSize: vi.fn(() => [1440, 900]),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { isDestroyed: () => false, send: vi.fn(), focus: vi.fn() },
  }) as unknown as BrowserWindow;
}

describe('persistent source system tabs', () => {
  it('preserves independent publication pages without business login polling, credential filling or storage injection', async () => {
    vi.useFakeTimers();
    const controller = new LoginTabController(), window = windowMock();
    const load = vi.fn(() => ({ governmentToken: 'must-not-copy' })), save = vi.fn(async () => {});
    controller.configurePersistence({ load, save });
    const page = (id: string): SourcePage => ({ id, name: id,
      loginPage: { url: `https://${id}.example/login`, allowedOrigin: `https://${id}.example`, partition: `persist:${id}` } });
    controller.open(window, page('nanshan-publicity'), null, { persistStorage: false });
    controller.open(window, page('guangdong-law-publicity'), null, { persistStorage: false });
    for (const view of mocks.views) view.webContents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(10_000);
    await controller.flushSessionStorage();
    expect(load).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    expect(mocks.views.every(view => !view.webContents.executeJavaScript.mock.calls.length)).toBe(true);
    expect(vi.mocked(window.webContents.send).mock.calls.some(([channel]) => channel === IPC_CHANNELS.systemSessionChanged)).toBe(false);
    controller.activate(null); controller.open(window, page('nanshan-publicity'), null, { persistStorage: false });
    expect(mocks.views).toHaveLength(2);
    expect(mocks.views[0].webContents.loadURL).toHaveBeenCalledOnce();
    controller.close('nanshan-publicity');
    expect(mocks.views[1].webContents.close).not.toHaveBeenCalled();
    expect(controller.state().tabs.map(tab => tab.systemId)).toEqual(['guangdong-law-publicity']);
    controller.close();
  });
  it('automatically checks every open tab and pushes only status fields to the renderer', async () => {
    vi.useFakeTimers();
    const controller = new LoginTabController(); const window = windowMock();
    const a = plugin('a'); const b = plugin('b');
    a.getSessionState = vi.fn(async () => ({ status: 'authenticated' as const, systemId: 'a', token: 'must-not-leak' }));
    b.getSessionState = vi.fn(async () => ({ status: 'authenticated' as const, systemId: 'b' }));
    controller.open(window, a); controller.open(window, b); controller.activate('a');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.getSessionState).toHaveBeenCalledOnce(); expect(b.getSessionState).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.systemSessionChanged, expect.objectContaining({ systemId: 'b', status: 'authenticated' }));
    expect(JSON.stringify(vi.mocked(window.webContents.send).mock.calls)).not.toContain('must-not-leak');
    controller.close(); await vi.advanceTimersByTimeAsync(5_000);
    expect(a.getSessionState).toHaveBeenCalledOnce(); expect(b.getSessionState).toHaveBeenCalledOnce();
  });

  it('checks as soon as a page finishes loading and ignores late results after closing', async () => {
    vi.useFakeTimers();
    const controller = new LoginTabController(); const window = windowMock(); const source = plugin('a');
    let finish!: (state: { status: 'authenticated'; systemId: string }) => void;
    source.getSessionState = vi.fn(() => new Promise<{ status: 'authenticated'; systemId: string }>((resolve) => { finish = resolve; }));
    controller.open(window, source); mocks.views[0].webContents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.getSessionState).toHaveBeenCalledOnce();
    controller.close('a'); finish({ status: 'authenticated', systemId: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(window.webContents.send).mock.calls.some(([channel]) => channel === IPC_CHANNELS.systemSessionChanged)).toBe(false);
    controller.close();
  });
  it('reports sign-out on the configured top-level login page and ignores an in-flight authenticated result', async () => {
    vi.useFakeTimers();
    const controller = new LoginTabController(); const window = windowMock(); const source = plugin('a');
    const onLoginPageChange = vi.fn(), accept = vi.fn(), forget = vi.fn(async () => {}), save = vi.fn(async () => {});
    source.loginPage!.onLoginPageChange = onLoginPageChange;
    source.loginPage!.additionalAllowedOrigins = ['https://subsystem.example'];
    source.loginPage!.browserAuth = { localStorageKeys: ['token'], accept };
    let finish!: (state: { status: 'authenticated'; systemId: string }) => void;
    const authenticated = { status: 'authenticated' as const, systemId: 'a' };
    source.getSessionState = vi.fn(async () => authenticated)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    controller.configurePersistence({ load: () => ({}), save, forget });
    controller.open(window, source, null, { url: 'https://a.example/home' });
    const contents = mocks.views[0].webContents;
    contents.executeJavaScript.mockResolvedValue({ token: 'fixture-token' });
    contents.emit('did-navigate', {}, contents.url, 200);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.getSessionState).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledOnce();

    contents.emit('did-navigate-in-page', {}, 'https://a.example/login', false);
    contents.emit('did-navigate', {}, 'https://subsystem.example/login', 200);
    contents.emit('did-navigate', {}, 'https://a.example/login-history', 200);
    contents.emit('did-navigate', {}, 'https://a.example/login', 503);
    expect(forget).not.toHaveBeenCalled();

    contents.url = 'https://a.example/login/?next=home';
    contents.emit('did-navigate', {}, contents.url, 200);
    expect(onLoginPageChange.mock.calls).toEqual([[false], [true]]);
    expect(forget).toHaveBeenCalledExactlyOnceWith('a');
    expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.systemSessionChanged, expect.objectContaining({ systemId: 'a', status: 'logged-out' }));
    finish(authenticated);
    await vi.advanceTimersByTimeAsync(10_000);
    await controller.flushSessionStorage();
    expect(save).not.toHaveBeenCalled();
    expect(accept).toHaveBeenCalledOnce();
    expect(window.webContents.send).not.toHaveBeenCalledWith(IPC_CHANNELS.systemSessionChanged, expect.objectContaining(authenticated));

    contents.url = 'https://a.example/home';
    contents.emit('did-navigate-in-page', {}, contents.url, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onLoginPageChange).toHaveBeenLastCalledWith(false);
    expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.systemSessionChanged, expect.objectContaining(authenticated));
    controller.close();
  });
  it('opens only same-origin restored homepages in background without stealing the active tab', () => {
    const controller = new LoginTabController(); const window = windowMock();
    controller.open(window, plugin('a'));
    controller.open(window, plugin('b'), null, { url: 'https://b.example/home', background: true });
    expect(controller.currentSystemId()).toBe('a');
    expect(mocks.views[1].webContents.loadURL).toHaveBeenCalledWith('https://b.example/home');
    expect(() => controller.open(window, plugin('c'), null, { url: 'https://evil.example/home' })).toThrow('非原系统');
  });
  it('recognizes the exact SPA login route and restores homepage sessionStorage before checking credentials', async () => {
    vi.useFakeTimers();
    const controller = new LoginTabController(), source = plugin('a');
    source.loginPage!.url = 'https://a.example/iHome/#/login';
    const onLoginPageChange = vi.fn(), accept = vi.fn(), forget = vi.fn(async () => {});
    source.loginPage!.onLoginPageChange = onLoginPageChange;
    source.loginPage!.browserAuth = { localStorageKeys: [], sessionStorageKeys: ['Authorization'], accept };
    const saved = { Authorization: 'fixture-restored' };
    controller.configurePersistence({ load: () => saved, save: async () => {}, forget });
    const home = 'https://a.example/iHome/';
    controller.open(windowMock(), source, null, { url: home });
    const contents = mocks.views[0].webContents;
    let restored = false;
    contents.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('sessionStorage.setItem')) { restored = true; return true; }
      return restored ? saved : {};
    });
    contents.emit('did-navigate', {}, home, 200);
    await vi.advanceTimersByTimeAsync(0);
    expect(accept).not.toHaveBeenCalled();
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(0);
    expect(accept).toHaveBeenCalledExactlyOnceWith(saved);
    const navigate = (hash: string) => {
      contents.url = home + hash;
      contents.emit('did-navigate-in-page', {}, contents.url, true);
    };
    navigate('#/login-history');
    expect(forget).not.toHaveBeenCalled();
    navigate('#/login/?redirect=home');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(forget).toHaveBeenCalledOnce();
    expect(onLoginPageChange.mock.calls).toEqual([[false], [true]]);
    navigate('#/dashboard');
    await vi.advanceTimersByTimeAsync(0);
    expect(onLoginPageChange).toHaveBeenLastCalledWith(false);
    controller.close();
  });
  it('flushes page sessionStorage before shutdown and refuses foreign origins', async () => {
    const controller = new LoginTabController(); const save = vi.fn(async () => {});
    controller.configurePersistence({ load: () => ({}), save });
    controller.open(windowMock(), plugin('a'));
    mocks.views[0].webContents.executeJavaScript.mockResolvedValue({ pageToken: 'fixture' });
    await controller.flushSessionStorage();
    expect(save).toHaveBeenCalledWith('a', { pageToken: 'fixture' });
    mocks.views[0].webContents.url = 'https://evil.example/';
    await controller.flushSessionStorage(); expect(save).toHaveBeenCalledTimes(1);
    controller.close();
  });
  beforeEach(() => { mocks.views.length = 0; mocks.nextLoadError = null; });
  it('does not report an interrupted initial load as an error when SSO starts another navigation', async () => {
    const controller = new LoginTabController();
    mocks.nextLoadError = Object.assign(new Error('ERR_ABORTED'), { code: 'ERR_ABORTED', errno: -3 });
    controller.open(windowMock(), plugin('a'));
    await Promise.resolve(); await Promise.resolve();
    mocks.views[0].webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://a.example/login', true);
    expect(controller.state().tabs[0].error).toBeUndefined();
    controller.close();
  });
  it('keeps real load failures visible and logs only the system and network error code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new LoginTabController();
    try {
      mocks.nextLoadError = Object.assign(new Error('https://a.example/login?token=must-not-log'), { code: 'ERR_CERT_AUTHORITY_INVALID', errno: -202 });
      controller.open(windowMock(), plugin('a'));
      await Promise.resolve(); await Promise.resolve();
      expect(controller.state().tabs[0].error).toContain('页面加载失败');
      expect(warn).toHaveBeenCalledWith('原系统页面加载失败', { systemId: 'a', errorCode: -202, reason: 'ERR_CERT_AUTHORITY_INVALID' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('must-not-log');
    } finally { controller.close(); warn.mockRestore(); }
  });
  it('opens the authenticated home when an existing tab is still on its exact login entry', () => {
    const controller = new LoginTabController(); const window = windowMock(); const source = plugin('a');
    controller.open(window, source);
    mocks.views[0].webContents.emit('did-stop-loading');
    controller.open(window, source, null, { url: 'https://a.example/home' });
    expect(mocks.views).toHaveLength(1);
    expect(mocks.views[0].webContents.loadURL).toHaveBeenLastCalledWith('https://a.example/home');
    controller.close();
  });
  it('does not replace an existing business page when opening an authenticated source tab', () => {
    const controller = new LoginTabController(); const window = windowMock(); const source = plugin('a');
    controller.open(window, source);
    mocks.views[0].webContents.url = 'https://a.example/records?filter=retained';
    mocks.views[0].webContents.emit('did-stop-loading');
    controller.open(window, source, null, { url: 'https://a.example/home' });
    expect(mocks.views[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(mocks.views[0].webContents.getURL()).toBe('https://a.example/records?filter=retained');
    controller.close();
  });
  it('keeps both pages alive when switching, returning to workspace, and opening again', () => {
    const controller = new LoginTabController(); const window = windowMock();
    controller.open(window, plugin('a')); controller.open(window, plugin('b'));
    controller.activate('a'); controller.activate(null); controller.open(window, plugin('b'));
    expect(mocks.views).toHaveLength(2);
    for (const view of mocks.views) { expect(view.webContents.close).not.toHaveBeenCalled(); expect(view.webContents.loadURL).toHaveBeenCalledTimes(1); }
    expect(controller.state().tabs.map(tab => tab.systemId)).toEqual(['a', 'b']);
    expect(controller.currentSystemId()).toBe('b');
    expect(window.webContents.focus).toHaveBeenCalled();
    expect(mocks.views[1].setBounds).toHaveBeenLastCalledWith({ x: 260, y: 104, width: 1180, height: 796 });
  });
  it('closes only the requested tab; closing the active tab returns to workspace', () => {
    const controller = new LoginTabController(); const window = windowMock();
    controller.open(window, plugin('a')); controller.open(window, plugin('b'));
    controller.close('a');
    expect(controller.currentSystemId()).toBe('b'); expect(mocks.views[1].webContents.close).not.toHaveBeenCalled();
    controller.close('b');
    expect(controller.state()).toEqual({ tabs: [], activeSystemId: null });
    expect(mocks.views[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(mocks.views[1].webContents.close).toHaveBeenCalledTimes(1);
  });
  it('closes all pages and removes window listeners on shutdown', () => {
    const controller = new LoginTabController(); const window = windowMock();
    controller.open(window, plugin('a')); controller.open(window, plugin('b')); controller.close();
    expect(window.listenerCount('resize')).toBe(0);
    expect(mocks.views.every(view => view.webContents.close.mock.calls.length === 1)).toBe(true);
  });
  it('keeps renderer tab metadata credential-free and returns independent snapshots', () => {
    const controller = new LoginTabController(); controller.open(windowMock(), plugin('a'), { account: 'USER', password: 'PASSWORD' });
    const state = controller.state();
    expect(state.tabs[0].displayUrl).toBe('https://a.example/login');
    expect(JSON.stringify(state)).not.toMatch(/SECRET|USER|PASSWORD/);
    state.tabs[0].systemName = 'changed'; expect(controller.state().tabs[0].systemName).toBe('System a');
  });
  it('refills an existing login form using updated saved credentials without reloading', () => {
    const controller = new LoginTabController(); const window = windowMock();
    controller.open(window, plugin('a'));
    const contents = mocks.views[0].webContents;
    contents.emit('did-stop-loading');
    controller.open(window, plugin('a'), { account: 'new-user', password: 'new-password' });
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(contents.executeJavaScript.mock.calls[0][0]).toContain('new-user');
    expect(contents.loadURL).toHaveBeenCalledTimes(1);
    contents.url = 'https://untrusted.example/'; contents.emit('did-finish-load');
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1);
  });
  it('blocks navigation away from the original origin and tracks safe load errors', () => {
    const controller = new LoginTabController(); controller.open(windowMock(), plugin('a'));
    const contents = mocks.views[0].webContents; const event = { preventDefault: vi.fn() };
    contents.emit('will-navigate', event, 'https://untrusted.example/');
    contents.emit('will-redirect', event, 'file:///secret');
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    contents.emit('did-fail-load', {}, -105, 'sensitive', 'https://a.example/?sid=SECRET', true);
    expect(controller.state().tabs[0].error).toContain('加载失败');
    expect(JSON.stringify(controller.state())).not.toContain('sensitive');
    contents.emit('did-start-loading'); expect(controller.state().tabs[0].error).toBeUndefined();
  });
  it('accepts the reviewed Shenzhen IP certificate only in its own source tab and exact origin', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-27T00:00:00Z'));
    const controller = new LoginTabController(); const source = plugin('shenzhen-integrated-services');
    source.loginPage = { url: 'https://61.144.226.148:8001/cas/login', allowedOrigin: 'https://61.144.226.148:8001', partition: 'persist:shenzhen-integrated-services' };
    controller.open(windowMock(), source);
    const contents = mocks.views[0].webContents, event = { preventDefault: vi.fn() }, callback = vi.fn();
    const certificate = { data: REVIEWED_CERTIFICATE, fingerprint: 'untrusted-display-fingerprint' };
    contents.emit('certificate-error', event, 'https://61.144.226.148:8002/cas/login', 'net::ERR_CERT_COMMON_NAME_INVALID', certificate, callback);
    contents.emit('certificate-error', event, source.loginPage.url, 'net::ERR_CERT_REVOKED', certificate, callback);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled();
    contents.emit('certificate-error', event, source.loginPage.url, 'net::ERR_CERT_COMMON_NAME_INVALID', certificate, callback);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(callback).toHaveBeenCalledExactlyOnceWith(true);
    controller.open(windowMock(), plugin('a'));
    mocks.views[1].webContents.emit('certificate-error', event, source.loginPage.url, 'net::ERR_CERT_COMMON_NAME_INVALID', certificate, callback);
    expect(callback).toHaveBeenCalledOnce();
    controller.close();
  });
  it('targets history and reload actions without affecting another tab', () => {
    const controller = new LoginTabController(); const window = windowMock();
    controller.open(window, plugin('a')); controller.open(window, plugin('b'));
    controller.reload('a'); expect(controller.back('a')).toBe(true);
    expect(mocks.views[0].webContents.reload).toHaveBeenCalledTimes(1);
    expect(mocks.views[1].webContents.reload).not.toHaveBeenCalled();
    controller.close('a'); expect(() => controller.activate('a')).toThrow('已关闭');
    expect(controller.currentSystemId()).toBe('b');
  });
  it('allows only declared SSO origins without filling credentials into the destination', async () => {
    const controller = new LoginTabController(); const source = plugin('a');
    source.loginPage!.additionalAllowedOrigins = ['https://subsystem.example'];
    source.loginPage!.credentialPaths = ['/login'];
    controller.open(windowMock(), source, { account: 'fixture-account', password: 'fixture-password' });
    const contents = mocks.views[0].webContents;
    const event = { preventDefault: vi.fn() };
    contents.emit('will-navigate', event, 'https://subsystem.example/GDDJ/');
    contents.emit('will-redirect', event, 'https://subsystem.example/GDDJ/');
    expect(event.preventDefault).not.toHaveBeenCalled();
    contents.emit('will-navigate', event, 'https://subsystem.example.attacker.test/');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    contents.url = 'https://subsystem.example/GDDJ/';
    contents.emit('did-finish-load'); await Promise.resolve(); await Promise.resolve();
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
    contents.url = 'https://a.example/change-password'; contents.emit('did-finish-load');
    await Promise.resolve(); await Promise.resolve();
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
    controller.close();
  });
  it('reads only named main-process portal keys before validating login, including SPA navigation', async () => {
    const controller = new LoginTabController(); const source = plugin('a'); const accept = vi.fn();
    source.loginPage!.browserAuth = { localStorageKeys: ['pro__Access-Token'], sessionStorageKeys: ['Authorization', 'userId'], accept };
    source.getSessionState = vi.fn(async () => ({ status: 'authenticated' as const, systemId: 'a' }));
    const window = windowMock(); controller.open(window, source);
    const contents = mocks.views[0].webContents;
    contents.executeJavaScript.mockResolvedValue({ 'pro__Access-Token': 'fixture-secret', Authorization: 'fixture-secret', userId: 'fixture-user' });
    contents.emit('did-navigate-in-page', {}, 'https://a.example/home');
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith({ 'pro__Access-Token': 'fixture-secret', Authorization: 'fixture-secret', userId: 'fixture-user' }));
    expect(source.getSessionState).toHaveBeenCalledOnce();
    expect(contents.executeJavaScript.mock.calls[0][0]).toContain('pro__Access-Token');
    expect(contents.executeJavaScript.mock.calls[0][0]).toContain('sessionStorage.getItem');
    expect(JSON.stringify(vi.mocked(window.webContents.send).mock.calls)).not.toContain('fixture-secret');
    controller.close();
  });
  it('never restores portal sessionStorage into an allowed cross-origin destination', async () => {
    const controller = new LoginTabController(); const source = plugin('a');
    source.loginPage!.additionalAllowedOrigins = ['https://subsystem.example'];
    const load = vi.fn(() => ({ portalPrivateValue: 'fixture-secret' }));
    controller.configurePersistence({ load, save: async () => {} });
    controller.open(windowMock(), source, null, { url: 'https://subsystem.example/GDDJ/' });
    const contents = mocks.views[0].webContents;
    contents.emit('did-finish-load'); await Promise.resolve(); await Promise.resolve();
    await controller.flushSessionStorage();
    expect(load).not.toHaveBeenCalled(); expect(contents.executeJavaScript).not.toHaveBeenCalled();
    controller.close();
  });
});
