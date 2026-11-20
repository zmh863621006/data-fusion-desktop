import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cookie, Session } from 'electron';
vi.mock('electron', () => ({ session: {} }));
import { AppError } from '../core/errors/app-error';
import type { BusinessSystemPlugin } from '../core/plugins/types';
import { restoredCookie, SessionRecoveryService, type SessionVault } from './session-recovery';

function vault() {
  const values = new Map<string, string>();
  return { values, get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    delete: vi.fn(async (key: string) => { values.delete(key); }), flush: vi.fn(async () => {}) } satisfies SessionVault & { values: Map<string, string> };
}
function browser(initial: Cookie[] = []) {
  const values = [...initial];
  const cookies = Object.assign(new EventEmitter(), {
    get: vi.fn(async () => values.map((value) => ({ ...value }))),
    set: vi.fn(async (value: any) => { values.push({ ...value, domain: value.domain ?? new URL(value.url).hostname, hostOnly: !value.domain }); }),
    flushStore: vi.fn(async () => {}),
  });
  return { cookies } as unknown as Session;
}
function fixture(id = 'a', token: string | null = 'fixture-token') {
  const state = { token };
  const validate = vi.fn(async () => ({ displayName: 'fixture-user' }));
  const plugin: BusinessSystemPlugin = { id, name: id, version: '1.0.0', matters: [], auth: {} as BusinessSystemPlugin['auth'],
    initialize: async () => {}, getSessionState: async () => ({ status: 'logged-out', systemId: id }),
    loginPage: { url: `https://${id}.example/login`, allowedOrigin: `https://${id}.example`, partition: `persist:${id}` },
    sessionRecovery: { snapshot: () => state.token ? { token: state.token } : null,
      restore: (value) => { state.token = String(value.token); }, validate, homeUrl: () => `https://${id}.example/home` },
  };
  return { plugin, state, validate };
}
const cookie = { name: 'sid', value: 'fixture-cookie', domain: 'a.example', path: '/app', hostOnly: true, httpOnly: true, secure: true, session: true } as Cookie;
const key = 'browser-session.v1.a';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('encrypted browser and API session recovery coordination', () => {
  it('saves a login and restores its API/session cookie/page storage without extending cookie expiry', async () => {
    const store = vault(); const first = fixture(); const firstBrowser = browser([cookie]);
    const service = new SessionRecoveryService(store, () => firstBrowser);
    await service.register(first.plugin);
    await first.plugin.getSessionState();
    await service.saveStorage('a', { token: 'page-fixture-token' });
    await service.flush();
    const reopened = fixture('a', null); const reopenedBrowser = browser();
    const next = new SessionRecoveryService(store, () => reopenedBrowser);
    await next.register(reopened.plugin);
    expect(reopened.state.token).toBe('fixture-token');
    expect(reopenedBrowser.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ value: 'fixture-cookie', httpOnly: true, secure: true, path: '/app' }));
    expect((reopenedBrowser.cookies.set as any).mock.calls[0][0]).not.toHaveProperty('expirationDate');
    expect(next.storage('a')).toEqual({ token: 'page-fixture-token' });
    expect(await next.recoverableSystems(['a'])).toEqual(['a']);
    expect(reopened.validate).toHaveBeenCalledOnce();
    expect(JSON.stringify(await reopened.plugin.getSessionState())).not.toMatch(/fixture-token|fixture-cookie|page-fixture-token/);
  });

  it('keeps saved bytes intact when offline and succeeds on a later retry', async () => {
    const store = vault(); const client = fixture(); const service = new SessionRecoveryService(store, () => browser([cookie]));
    await service.register(client.plugin); await client.plugin.getSessionState();
    const previous = store.values.get(key);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 61_000);
    client.validate.mockRejectedValueOnce(new Error('network unavailable'));
    expect(await client.plugin.getSessionState()).toMatchObject({ status: 'unverified' });
    await service.capture('a');
    expect(store.values.get(key)).toBe(previous);
    expect(store.delete).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 61_000);
    expect(await client.plugin.getSessionState()).toMatchObject({ status: 'authenticated' });
  });

  it('removes confirmed invalid sessions and does not save them again at shutdown', async () => {
    const store = vault(); const client = fixture(); const service = new SessionRecoveryService(store, () => browser([cookie]));
    await service.register(client.plugin); await client.plugin.getSessionState();
    client.state.token = 'expired-token';
    client.validate.mockRejectedValue(new AppError('SESSION_EXPIRED', 'expired'));
    expect(await client.plugin.getSessionState()).toMatchObject({ status: 'expired' });
    await service.flush(); expect(store.values.has(key)).toBe(false);
  });

  it('persists newly captured credentials while unverified and validates them after restart', async () => {
    const store = vault(); const first = fixture();
    const service = new SessionRecoveryService(store, () => browser([cookie]));
    await service.register(first.plugin); await first.plugin.getSessionState();
    first.state.token = 'new-login-token';
    first.validate.mockRejectedValue(new Error('temporary failure'));
    expect(await first.plugin.getSessionState()).toMatchObject({ status: 'unverified' });
    expect(service.canRestore('a')).toBe(false);
    expect(JSON.parse(store.values.get(key)!).api).toEqual({ token: 'new-login-token' });
    first.state.token = 'last-token-before-close';
    await service.flush();
    const second = fixture('a', null);
    const reopened = new SessionRecoveryService(store, () => browser());
    await reopened.register(second.plugin);
    expect(second.state.token).toBe('last-token-before-close');
    expect(reopened.canRestore('a')).toBe(false);
    expect(await reopened.recoverableSystems(['a'])).toEqual(['a']);
    expect(second.validate).toHaveBeenCalledOnce();
  });

  it('does not replace a complete saved API session with an incomplete unverified read', async () => {
    const store = vault(); const client = fixture();
    const service = new SessionRecoveryService(store, () => browser([cookie]));
    await service.register(client.plugin); await client.plugin.getSessionState();
    const previous = store.values.get(key);
    client.state.token = null;
    client.validate.mockRejectedValue(new Error('incomplete read'));
    expect(await client.plugin.getSessionState()).toMatchObject({ status: 'unverified' });
    await service.flush();
    expect(store.values.get(key)).toBe(previous);
  });

  it('never restores a session from a late validation after explicit logout', async () => {
    const store = vault(); const client = fixture(); const service = new SessionRecoveryService(store, () => browser());
    await service.register(client.plugin);
    let finish!: (value: { displayName: string }) => void;
    client.validate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const check = client.plugin.getSessionState();
    await vi.waitFor(() => expect(finish).toBeDefined());
    client.state.token = null; await service.forget('a');
    finish({ displayName: 'old user' });
    expect(await check).toMatchObject({ status: 'logged-out' });
    await service.flush(); expect(store.values.has(key)).toBe(false);
  });

  it('deduplicates concurrent verification and caches it without leaking credentials', async () => {
    const client = fixture(); const service = new SessionRecoveryService(vault(), () => browser());
    await service.register(client.plugin);
    const states = await Promise.all([client.plugin.getSessionState(), client.plugin.getSessionState(), client.plugin.getSessionState()]);
    expect(client.validate).toHaveBeenCalledOnce();
    expect(states.every((state) => state.status === 'authenticated')).toBe(true);
  });

  it('retries an inconclusive pre-login check within five seconds even when cookies stay unchanged', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = fixture(); const service = new SessionRecoveryService(vault(), () => browser([cookie]));
    await service.register(client.plugin);
    client.validate.mockRejectedValueOnce(new Error('temporarily unavailable'));
    expect(await client.plugin.getSessionState()).toMatchObject({ status: 'unverified' });
    vi.setSystemTime(Date.now() + 5_001);
    expect(await client.plugin.getSessionState()).toMatchObject({ status: 'authenticated' });
    expect(client.validate).toHaveBeenCalledTimes(2);
  });

  it('manual detection bypasses a stale failed check without waiting or changing the cookie', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = fixture(); const service = new SessionRecoveryService(vault(), () => browser([cookie]));
    await service.register(client.plugin);
    client.validate.mockRejectedValueOnce(new AppError('SESSION_EXPIRED', 'not yet logged in'));
    expect(await client.plugin.getSessionState()).toMatchObject({ status: 'expired' });
    expect(await client.plugin.getSessionState()).toMatchObject({ status: 'expired' });
    expect(await client.plugin.getSessionState({ force: true })).toMatchObject({ status: 'authenticated' });
    expect(client.validate).toHaveBeenCalledTimes(2);
  });

  it('logs only safe failure classifications and limits identical diagnostic noise', async () => {
    vi.useFakeTimers(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = fixture(); const service = new SessionRecoveryService(vault(), () => browser([cookie]));
    await service.register(client.plugin);
    client.validate.mockRejectedValue(new TypeError('fixture-secret raw response', { cause: { code: 'ECONNRESET', token: 'fixture-secret' } }));
    await client.plugin.getSessionState({ force: true }); await client.plugin.getSessionState({ force: true });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('原系统登录验证未通过', expect.objectContaining({ systemId: 'a', errorType: 'TypeError', causeCode: 'ECONNRESET' }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-secret');
    vi.setSystemTime(Date.now() + 60_001); await client.plugin.getSessionState({ force: true });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('limits automatic recovery to saved and licensed systems', async () => {
    const store = vault(); const a = fixture(); const b = fixture('b'); const service = new SessionRecoveryService(store, () => browser());
    await service.register(a.plugin); await service.register(b.plugin);
    await service.capture('a'); await service.capture('b');
    expect(await service.recoverableSystems(['a'])).toEqual(['a']);
    expect(b.validate).not.toHaveBeenCalled();
  });

  it('does not invent a saved login from an empty API snapshot with no cookies', async () => {
    const store = vault(); const client = fixture('a', null);
    client.plugin.sessionRecovery!.snapshot = () => ({});
    const service = new SessionRecoveryService(store, () => browser());
    await service.register(client.plugin); await service.capture('a');
    expect(await service.recoverableSystems(['a'])).toEqual([]);
    expect(store.values.size).toBe(0);
    expect(client.validate).not.toHaveBeenCalled();
  });

  it('excludes a previously verified system logged out while another system is still verifying', async () => {
    const store = vault(); const a = fixture(); const b = fixture('b');
    const service = new SessionRecoveryService(store, () => browser());
    await service.register(a.plugin); await service.register(b.plugin);
    await a.plugin.getSessionState(); await service.capture('b');
    let finish!: (value: { displayName: string }) => void;
    b.validate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const recovering = service.recoverableSystems(['a', 'b']);
    await vi.waitFor(() => expect(finish).toBeDefined());
    a.state.token = null; await service.forget('a');
    finish({ displayName: 'fixture-user' });
    expect(await recovering).toEqual(['b']);
    expect(service.canRestore('a')).toBe(false);
  });

  it('forgets only the selected system and accepts a fresh login later', async () => {
    const store = vault(); const a = fixture(); const b = fixture('b'); const service = new SessionRecoveryService(store, () => browser());
    await service.register(a.plugin); await service.register(b.plugin);
    await a.plugin.getSessionState(); await b.plugin.getSessionState();
    a.state.token = null; await service.forget('a');
    expect(store.values.has('browser-session.v1.b')).toBe(true);
    expect(await a.plugin.getSessionState()).toMatchObject({ status: 'logged-out' });
    a.state.token = 'fresh-token';
    expect(await a.plugin.getSessionState()).toMatchObject({ status: 'authenticated' });
    expect(store.values.has(key)).toBe(true);
  });

  it('stays logged out after returning to the portal login page even if browser cookies remain', async () => {
    const store = vault(); const client = fixture();
    const service = new SessionRecoveryService(store, () => browser([cookie]));
    await service.register(client.plugin);
    expect(await client.plugin.getSessionState()).toMatchObject({ status: 'authenticated' });
    client.state.token = null;
    await service.forget('a', { awaitApiLogin: true });
    expect(await client.plugin.getSessionState({ force: true })).toMatchObject({ status: 'logged-out' });
    expect(client.validate).toHaveBeenCalledOnce();
    await service.capture('a');
    expect(store.values.has(key)).toBe(false);

    client.state.token = 'fresh-token';
    expect(await client.plugin.getSessionState()).toMatchObject({ status: 'authenticated' });
    expect(JSON.parse(store.values.get(key)!).api).toEqual({ token: 'fresh-token' });
  });

  it('clears a snapshot whose authenticated write was already in progress when the user signed out', async () => {
    const store = vault(); const client = fixture();
    const service = new SessionRecoveryService(store, () => browser());
    await service.register(client.plugin);
    let finish!: () => void;
    store.set.mockImplementationOnce((id, value) => new Promise(resolve => {
      finish = () => { store.values.set(id, value); resolve(); };
    }));
    const checking = client.plugin.getSessionState();
    await vi.waitFor(() => expect(finish).toBeDefined());
    client.state.token = null;
    const forgetting = service.forget('a', { awaitApiLogin: true });
    finish();
    expect(await checking).toMatchObject({ status: 'logged-out' });
    await forgetting;
    expect(store.values.has(key)).toBe(false);
  });

  it('tolerates unavailable secure storage without claiming to persist plaintext', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = vault(); store.get.mockRejectedValue(new Error('vault unavailable')); store.set.mockRejectedValue(new Error('vault unavailable'));
    const client = fixture(); const service = new SessionRecoveryService(store, () => browser());
    await service.register(client.plugin);
    expect(await client.plugin.getSessionState()).toMatchObject({ status: 'authenticated' });
    expect(store.values.size).toBe(0);
  });

  it('rejects a saved snapshot for a different origin', async () => {
    const store = vault(); store.values.set(key, JSON.stringify({ version: 1, origin: 'https://evil.example', api: { token: 'wrong' }, cookies: [cookie] }));
    const client = fixture('a', null); const target = browser(); const service = new SessionRecoveryService(store, () => target);
    await service.register(client.plugin);
    expect(client.state.token).toBeNull(); expect(target.cookies.set).not.toHaveBeenCalled();
    expect(await client.plugin.getSessionState()).toMatchObject({ status: 'logged-out' });
  });

  it('preserves cookie attributes and rejects expired or foreign cookies and URL-shaped paths', () => {
    expect(restoredCookie({ ...cookie, expirationDate: 100 }, 'https://a.example', 100_001)).toBeNull();
    expect(restoredCookie({ ...cookie, domain: 'other.example' }, 'https://a.example')).toBeNull();
    expect(restoredCookie({ ...cookie, path: '//evil.example' }, 'https://a.example')).toBeNull();
    const result = restoredCookie({ ...cookie, expirationDate: 300, hostOnly: false, sameSite: 'strict' }, 'https://a.example', 100_000);
    expect(result).toMatchObject({ expirationDate: 300, domain: 'a.example', sameSite: 'strict', httpOnly: true, secure: true });
  });
  it('restores both explicitly declared portal/SSO cookie origins, never unrelated cookies', async () => {
    const store = vault(), first = fixture();
    first.plugin.loginPage!.additionalAllowedOrigins = ['https://subsystem.example'];
    const subsystem = { ...cookie, name: 'subsystem', domain: 'subsystem.example', path: '/GDDJ' };
    const foreign = { ...cookie, name: 'foreign', domain: 'evil.example' };
    const service = new SessionRecoveryService(store, () => browser([cookie, subsystem, foreign]));
    await service.register(first.plugin); await service.capture('a');
    const snapshot = JSON.parse(store.values.get(key)!);
    expect(snapshot.cookies.map((item: Cookie) => item.name)).toEqual(['sid', 'subsystem']);
    snapshot.cookies.push(foreign); store.values.set(key, JSON.stringify(snapshot));
    const reopened = fixture('a', null), target = browser();
    reopened.plugin.loginPage!.additionalAllowedOrigins = ['https://subsystem.example'];
    await new SessionRecoveryService(store, () => target).register(reopened.plugin);
    expect(target.cookies.set).toHaveBeenCalledTimes(2);
    expect(target.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://subsystem.example/GDDJ' }));
    expect((target.cookies.set as any).mock.calls.flat().some((item: any) => item.name === 'foreign')).toBe(false);
  });
});
