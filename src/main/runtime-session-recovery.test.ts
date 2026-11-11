import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));

import { AppRuntime } from './runtime';
import { loginTabController } from './login-tab';
import { marketAccessPlugin } from '../plugins/market-access';
import type { BusinessSystemPlugin } from '../core/plugins/types';
import type { LicenseGrant } from '../core/license/types';
import type { SourceTabsState } from '../core/session/source-tabs';

function plugin(id: string): BusinessSystemPlugin {
  return { id, name: id, version: '1.0.0', matters: [], auth: {} as BusinessSystemPlugin['auth'],
    initialize: async () => {}, getSessionState: async () => ({ status: 'authenticated', systemId: id }),
    loginPage: { url: `https://${id}.example/login`, partition: `persist:${id}`, allowedOrigin: `https://${id}.example` },
    sessionRecovery: { snapshot: () => ({}), restore: () => {}, validate: async () => ({}), homeUrl: () => `https://${id}.example/home` },
  };
}

describe('automatic source-tab recovery lifecycle', () => {
  let runtime: AppRuntime;
  let state: SourceTabsState;
  let activity: number;
  const window = { isDestroyed: vi.fn(() => false) } as unknown as BrowserWindow;
  const grant: LicenseGrant = { licenseId: 'fixture', expiresAt: Date.now() + 60_000, allowedSystems: ['a', 'b'] };
  const recovery = { recoverableSystems: vi.fn(async (_allowed: string[]) => ['a', 'b']), canRestore: vi.fn((_id: string) => true),
    flush: vi.fn(async () => {}) };

  beforeEach(() => {
    vi.restoreAllMocks(); vi.clearAllMocks();
    runtime = new AppRuntime(); runtime.plugins.register(plugin('a')); runtime.plugins.register(plugin('b'));
    Object.assign(runtime, { sessionRecovery: recovery });
    vi.spyOn(runtime, 'currentGrant').mockResolvedValue(grant);
    recovery.recoverableSystems.mockImplementation(async () => ['a', 'b']); recovery.canRestore.mockReturnValue(true);
    state = { tabs: [], activeSystemId: null }; activity = 0;
    vi.spyOn(loginTabController, 'state').mockImplementation(() => state);
    vi.spyOn(loginTabController, 'activityVersion').mockImplementation(() => activity);
    vi.spyOn(loginTabController, 'flushSessionStorage').mockResolvedValue();
    vi.spyOn(loginTabController, 'open').mockImplementation((_window, source) => {
      state.tabs.push({ systemId: source.id, systemName: source.name, displayUrl: '', loading: false });
    });
    vi.spyOn(loginTabController, 'activate').mockImplementation((id) => { state.activeSystemId = id; activity++; });
  });

  it('opens verified homes in the background and selects the first restored tab', async () => {
    await runtime.restoreSourceTabs(window);
    expect(recovery.recoverableSystems).toHaveBeenCalledWith(['a', 'b']);
    expect(loginTabController.open).toHaveBeenCalledTimes(2);
    expect(loginTabController.open).toHaveBeenCalledWith(window, runtime.plugins.get('a'), null,
      { url: 'https://a.example/home', background: true });
    expect(loginTabController.activate).toHaveBeenCalledWith('a');
  });

  it('restores market access directly to its confirmed authenticated frame page', async () => {
    runtime.plugins.register(marketAccessPlugin);
    vi.mocked(runtime.currentGrant).mockResolvedValue({ ...grant, allowedSystems: ['market-access'] });
    recovery.recoverableSystems.mockResolvedValueOnce(['market-access']);
    await runtime.restoreSourceTabs(window);
    expect(loginTabController.open).toHaveBeenCalledExactlyOnceWith(window, marketAccessPlugin, null,
      { url: 'http://19.88.234.125/app/page/frame.html', background: true });
  });

  it('does not duplicate existing tabs or steal focus after user interaction', async () => {
    state.tabs.push({ systemId: 'a', systemName: 'a', displayUrl: '', loading: false });
    recovery.recoverableSystems.mockImplementationOnce(async () => { activity++; return ['a', 'b']; });
    await runtime.restoreSourceTabs(window);
    expect(loginTabController.open).toHaveBeenCalledOnce();
    expect(loginTabController.open).toHaveBeenCalledWith(window, runtime.plugins.get('b'), null, expect.anything());
    expect(loginTabController.activate).not.toHaveBeenCalled();
  });

  it('does not reopen a system closed or logged out while validation was running', async () => {
    recovery.recoverableSystems.mockImplementationOnce(async () => { loginTabController.close('a'); return ['a', 'b']; });
    await runtime.restoreSourceTabs(window);
    expect(loginTabController.open).toHaveBeenCalledOnce();
    expect(state.tabs.map((tab) => tab.systemId)).toEqual(['b']);
  });

  it('rechecks session validity immediately before opening a recovered system', async () => {
    recovery.canRestore.mockImplementation((id) => id === 'b');
    await runtime.restoreSourceTabs(window);
    expect(state.tabs.map((tab) => tab.systemId)).toEqual(['b']);
  });

  it('does not open tabs once application shutdown has started', async () => {
    recovery.recoverableSystems.mockImplementationOnce(async () => { await runtime.shutdown(); return ['a', 'b']; });
    await runtime.restoreSourceTabs(window);
    expect(recovery.flush).toHaveBeenCalledOnce();
    expect(loginTabController.open).not.toHaveBeenCalled();
  });

  it('rechecks the current license after asynchronous validation', async () => {
    vi.mocked(runtime.currentGrant).mockResolvedValueOnce(grant).mockResolvedValueOnce({ ...grant, allowedSystems: ['b'] });
    await runtime.restoreSourceTabs(window);
    expect(state.tabs.map((tab) => tab.systemId)).toEqual(['b']);
  });

  it('does not verify or restore systems without an active license', async () => {
    vi.mocked(runtime.currentGrant).mockResolvedValueOnce(null);
    await runtime.restoreSourceTabs(window);
    expect(recovery.recoverableSystems).not.toHaveBeenCalled();
    expect(loginTabController.open).not.toHaveBeenCalled();
  });
});
