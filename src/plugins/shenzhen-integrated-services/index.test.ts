import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validatePluginContract } from '../../core/plugins/types';
import { validateFilters } from '../../core/query/validation';

const electron = vi.hoisted(() => ({
  fromPartition: vi.fn(), fetch: vi.fn(), clearStorageData: vi.fn(),
  onBeforeSendHeaders: vi.fn(), onCompleted: vi.fn(), onBeforeRedirect: vi.fn(), onErrorOccurred: vi.fn(),
}));
vi.mock('electron', () => ({ session: { fromPartition: electron.fromPartition } }));
vi.mock('./query', () => ({
  queryShenzhenCases: vi.fn(async () => ({ rows: [], total: 0, page: 1, pageSize: 1 })),
  mergeShenzhenRecord: (incoming: Record<string, unknown>, previous: Record<string, unknown>) => ({ ...previous, ...incoming }),
}));
import { createShenzhenIntegratedPlugin } from './index';
import { SHENZHEN_HOME_URL, SHENZHEN_LOGIN_URL, SHENZHEN_ORIGIN, SHENZHEN_PARTITION, SHENZHEN_SYSTEM_ID } from './catalog';
import { queryShenzhenCases } from './query';

const token = 'synthetic-browser-token';
const newToken = 'synthetic-browser-new-token';
const reply = (map: unknown, appcode = '0', status = 200) => new Response(JSON.stringify({ msg: '', appcode, map }), { status, headers: { 'Content-Type': 'application/json' } });
const identity = () => reply({ userId: 'synthetic-user', userName: '合成用户', functionId: [] });

beforeEach(() => {
  vi.clearAllMocks();
  electron.clearStorageData.mockResolvedValue(undefined);
  electron.fetch.mockImplementation(async () => identity());
  electron.fromPartition.mockReturnValue({
    fetch: electron.fetch, clearStorageData: electron.clearStorageData,
    webRequest: { onBeforeSendHeaders: electron.onBeforeSendHeaders, onCompleted: electron.onCompleted,
      onBeforeRedirect: electron.onBeforeRedirect, onErrorOccurred: electron.onErrorOccurred },
  });
});

function browserRequest(id: number, options: { url?: string; status?: number; type?: string; token?: string; complete?: boolean } = {}) {
  const url = options.url ?? SHENZHEN_ORIGIN + '/TRANSB/security/getUserInfoByToken';
  const before = electron.onBeforeSendHeaders.mock.calls[0][1];
  before({ id, url, requestHeaders: { 'Access-Token': options.token ?? token } }, () => {});
  if (options.complete !== false) browserCompleted(id, options);
}
function browserCompleted(id: number, options: { url?: string; status?: number; type?: string } = {}) {
  const completed = electron.onCompleted.mock.calls[0][1];
  completed({ id, url: options.url ?? SHENZHEN_ORIGIN + '/TRANSB/security/getUserInfoByToken', statusCode: options.status ?? 200,
    responseHeaders: { 'Content-Type': [options.type ?? 'application/json'] } });
}

describe('Shenzhen integrated plugin', () => {
  it('keeps the ten existing matter IDs, independent CAS entry and list-ledger contract', () => {
    const plugin = createShenzhenIntegratedPlugin({ now: () => Date.parse('2026-11-27T08:00:00Z') });
    expect(() => validatePluginContract(plugin)).not.toThrow(); expect(plugin.id).toBe(SHENZHEN_SYSTEM_ID); expect(plugin.matters).toHaveLength(10);
    expect(plugin.workspaceMode).toBe('list-ledger'); expect(plugin.loginPage).toMatchObject({ url: SHENZHEN_LOGIN_URL, allowedOrigin: SHENZHEN_ORIGIN, partition: SHENZHEN_PARTITION });
    expect(plugin.sessionRecovery?.homeUrl()).toBe(SHENZHEN_HOME_URL);
    expect(plugin.loginPage?.browserAuth?.sessionStorageKeys).toContain('access-token'); expect(plugin.loginPage?.browserAuth?.localStorageKeys).toEqual([]);
    for (const matter of plugin.matters) {
      expect(matter.queryAvailable).not.toBe(false); expect(matter.uniqueKey).toEqual(['recordKey']);
      expect(matter.querySchema.map(field => field.type)).toEqual(['select', 'date', 'date']);
      expect(matter.createDefaultContext!().filters).toMatchObject({ dateType: 'received', startDate: '2026-11-01', endDate: '2026-11-27' });
      expect(() => validateFilters(matter.querySchema, matter.createDefaultContext!().filters)).not.toThrow();
    }
    expect(plugin.matters.find(m => m.id === 'poverty-alleviation-post-subsidy')?.description).toContain('共用');
  });

  it('requires a successful source identity probe after capturing portal storage', async () => {
    const plugin = createShenzhenIntegratedPlugin();
    expect((await plugin.getSessionState()).status).toBe('logged-out'); expect(electron.fetch).not.toHaveBeenCalled();
    plugin.loginPage!.browserAuth!.accept({ 'access-token': token, empno: 'synthetic-user', functionid: 'synthetic-permission' });
    const state = await plugin.getSessionState(); expect(state.status).toBe('authenticated');
    expect(electron.fetch).toHaveBeenCalledExactlyOnceWith(SHENZHEN_ORIGIN + '/TRANSB/security/getUserInfoByToken', expect.objectContaining({ method: 'POST', body: '{}', headers: expect.objectContaining({ 'Access-Token': token }) }));
    expect(JSON.stringify(state)).not.toMatch(/synthetic-browser-token|synthetic-user|synthetic-permission/);
    expect(await plugin.auth.getSessionForRequest()).toEqual({ metadata: { partition: SHENZHEN_PARTITION } }); expect(electron.fetch).toHaveBeenCalledOnce();
  });

  it('keeps network or malformed identity results unverified and does not infer login from storage', async () => {
    const plugin = createShenzhenIntegratedPlugin(); plugin.loginPage!.browserAuth!.accept({ 'access-token': token });
    electron.fetch.mockResolvedValueOnce(reply({}, '0')).mockResolvedValueOnce(reply(null, '0', 504));
    expect((await plugin.getSessionState()).status).toBe('unverified');
    expect((await plugin.getSessionState()).status).toBe('unverified');
    expect(plugin.sessionRecovery?.apiCredentials?.().status).toBe('present');
  });

  it('forces an explicit detection instead of returning a cached success after logout', async () => {
    const plugin = createShenzhenIntegratedPlugin(); plugin.loginPage!.browserAuth!.accept({ 'access-token': token });
    expect((await plugin.getSessionState()).status).toBe('authenticated');
    electron.fetch.mockResolvedValueOnce(reply(null, '401'));
    expect((await plugin.getSessionState({ force: true })).status).toBe('expired');
    expect(plugin.sessionRecovery?.snapshot()).toBeNull();
    plugin.loginPage!.browserAuth!.accept({ 'access-token': token }); expect((await plugin.getSessionState()).status).toBe('expired');
  });

  it('installs source observation once and captures headers only for successful same-origin JSON API responses', async () => {
    const plugin = createShenzhenIntegratedPlugin(); await plugin.initialize(); await plugin.initialize();
    expect(electron.onBeforeSendHeaders).toHaveBeenCalledOnce(); expect(electron.onBeforeSendHeaders.mock.calls[0][0]).toEqual({ urls: [SHENZHEN_ORIGIN + '/TRANSB/*'] });
    browserRequest(1, { url: 'https://foreign.example/TRANSB/list' });
    browserRequest(2, { url: SHENZHEN_ORIGIN + '/other/list' });
    browserRequest(3, { status: 401 }); browserRequest(4, { type: 'text/html' });
    expect((await plugin.getSessionState()).status).toBe('logged-out'); expect(electron.fetch).not.toHaveBeenCalled();
    browserRequest(5); expect((await plugin.getSessionState()).status).toBe('authenticated');
    expect(plugin.sessionRecovery?.snapshot()).toMatchObject({ token });
  });

  it('ignores stale header observations after a new token or login navigation', async () => {
    const plugin = createShenzhenIntegratedPlugin(); await plugin.initialize();
    browserRequest(1, { complete: false });
    plugin.loginPage!.browserAuth!.accept({ 'access-token': newToken }); browserCompleted(1);
    expect(plugin.sessionRecovery?.snapshot()).toMatchObject({ token: newToken });
    plugin.loginPage!.onLoginPageChange!(true); browserRequest(2);
    expect((await plugin.getSessionState()).status).toBe('logged-out');
    plugin.loginPage!.onNavigate!(SHENZHEN_ORIGIN + '/cas/systemList'); expect((await plugin.getSessionState()).status).toBe('logged-out');
    browserRequest(3, { token: newToken }); expect((await plugin.getSessionState()).status).toBe('authenticated');
    plugin.loginPage!.onNavigate!(SHENZHEN_ORIGIN + '/TRANS/login'); expect((await plugin.getSessionState()).status).toBe('logged-out');
  });

  it('restores a snapshot without claiming authentication until the identity request succeeds', async () => {
    const first = createShenzhenIntegratedPlugin(); first.loginPage!.browserAuth!.accept({ 'access-token': token, empno: 'synthetic-user' });
    await first.getSessionState(); const saved = await first.sessionRecovery!.snapshot();
    const restored = createShenzhenIntegratedPlugin(); await restored.sessionRecovery!.restore(saved!);
    electron.fetch.mockResolvedValueOnce(reply({}, '0')); expect((await restored.getSessionState()).status).toBe('unverified');
    electron.fetch.mockResolvedValueOnce(identity()); expect((await restored.getSessionState()).status).toBe('authenticated');
    await restored.auth.logout(); expect(electron.clearStorageData).toHaveBeenCalledOnce(); expect((await restored.getSessionState()).status).toBe('logged-out');
    expect(restored.sessionRecovery?.snapshot()).toBeNull();
  });

  it('passes each matter and its selected date context into the shared query implementation', async () => {
    const plugin = createShenzhenIntegratedPlugin(); const matter = plugin.matters[0], context = matter.createDefaultContext!();
    await matter.query(context);
    expect(queryShenzhenCases).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: matter.id }), context);
  });
});
