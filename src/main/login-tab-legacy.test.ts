import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
const state = vi.hoisted(() => ({ views: [] as any[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { BrowserWindow: class {}, WebContentsView: undefined, BrowserView: class {
    webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => 'https://source.example/login',
      loadURL: vi.fn(async () => {}), setWindowOpenHandler: vi.fn(), destroy: vi.fn(),
      executeJavaScript: vi.fn(async () => null), focus: vi.fn(), reload: vi.fn(), canGoBack: () => true, goBack: vi.fn(),
      openDevTools: vi.fn(), isDevToolsOpened: vi.fn(() => false), devToolsWebContents: { isDestroyed: vi.fn(() => false), focus: vi.fn() } });
    setBounds = vi.fn();
    constructor(public options: unknown) { state.views.push(this); }
  } };
});
import { LoginTabController } from './login-tab';

describe('Electron 22 source tabs', () => {
  beforeEach(() => { state.views.length = 0; });
  it('preserves sandboxed independent pages using BrowserView and the legacy navigation API', () => {
    const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentSize: () => [1440, 900],
      contentView: { addChildView: () => { throw new Error('BrowserView is not a View'); }, removeChildView: () => { throw new Error('BrowserView is not a View'); } },
      addBrowserView: vi.fn(), removeBrowserView: vi.fn(), webContents: { isDestroyed: () => false, send: vi.fn(), focus: vi.fn() } });
    const controller = new LoginTabController();
    const page = (id: string) => ({ id, name: id, loginPage: { url: 'https://source.example/login', allowedOrigin: 'https://source.example', partition: `persist:${id}` } });
    controller.open(window as unknown as BrowserWindow, page('first'));
    controller.open(window as unknown as BrowserWindow, page('second'));
    expect(controller.state().tabs).toHaveLength(2);
    expect(state.views[0].options).toMatchObject({ webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    expect(window.removeBrowserView).toHaveBeenCalledWith(state.views[0]);
    expect(controller.back('first')).toBe(true); expect(state.views[0].webContents.goBack).toHaveBeenCalledOnce();
    controller.close('second'); expect(state.views[1].webContents.destroy).toHaveBeenCalledOnce();
    expect(state.views[0].webContents.destroy).not.toHaveBeenCalled(); controller.close();
  });
  it('routes F12 to the active BrowserView and ignores a late event after its tab closes', () => {
    const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentSize: () => [1440, 900],
      addBrowserView: vi.fn(), removeBrowserView: vi.fn(), webContents: { isDestroyed: () => false, send: vi.fn(), focus: vi.fn() } });
    const controller = new LoginTabController(), event = { preventDefault: vi.fn() };
    const page = (id: string) => ({ id, name: id, loginPage: { url: 'https://source.example/login', allowedOrigin: 'https://source.example', partition: `persist:${id}` } });
    controller.open(window as unknown as BrowserWindow, page('first')); controller.open(window as unknown as BrowserWindow, page('second'));
    const second = state.views[1].webContents;
    second.emit('before-input-event', event, { type: 'keyDown', key: 'F12' });
    second.emit('before-input-event', event, { type: 'keyDown', key: 'F12', isAutoRepeat: true });
    expect(second.openDevTools).toHaveBeenCalledExactlyOnceWith({ mode: 'detach', activate: true });
    second.isDevToolsOpened.mockReturnValue(true); second.emit('devtools-opened');
    controller.openDevToolsForActiveTab(); expect(second.devToolsWebContents.focus).toHaveBeenCalledOnce();
    controller.close('second');
    second.emit('before-input-event', event, { type: 'keyDown', key: 'F12' });
    expect(controller.openDevToolsForActiveTab()).toBe(false); expect(state.views[0].webContents.openDevTools).not.toHaveBeenCalled();
    controller.close();
  });
});
