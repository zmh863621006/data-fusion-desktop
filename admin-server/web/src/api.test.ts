import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi, ApiError, loadAdminSession } from './api';

afterEach(() => vi.unstubAllGlobals());
const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('ordinary admin session startup', () => {
  it('uses an existing session', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { user: { username: 'admin' } }));
    vi.stubGlobal('fetch', fetch);
    expect((await loadAdminSession()).user?.username).toBe('admin');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('deduplicates startup effects without an automatic-login request', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { user: { username: 'admin' } }));
    vi.stubGlobal('fetch', fetch);
    const first = loadAdminSession(), second = loadAdminSession();
    expect(first).toBe(second);
    expect((await first).user?.username).toBe('admin');
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/admin/bootstrap']);
  });
  it('returns to login immediately when the session is expired, even in a browser with old device cookies', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(401, {}));
    vi.stubGlobal('fetch', fetch);
    await expect(loadAdminSession()).rejects.toMatchObject({ status: 401 });
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/admin/bootstrap']);
  });
  it('can check a new password-authenticated session after an expired-session check', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply(401, {})).mockResolvedValueOnce(reply(200, { user: { username: 'admin' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(loadAdminSession()).rejects.toMatchObject({ status: 401 });
    expect((await loadAdminSession()).user?.username).toBe('admin');
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/admin/bootstrap', '/api/admin/bootstrap']);
  });
  it('does not retry service outages or bypass a login lock', async () => {
    let fetch = vi.fn().mockResolvedValue(reply(503, { error: '暂不可用' }));
    vi.stubGlobal('fetch', fetch);
    await expect(loadAdminSession()).rejects.toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch = vi.fn().mockResolvedValue(reply(429, { code: 'LOGIN_LOCKED', retryAfterSeconds: 60 }));
    vi.stubGlobal('fetch', fetch);
    await expect(loadAdminSession()).rejects.toMatchObject({ status: 429, retryAfterSeconds: 60 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('license scope API', () => {
  it('posts only the explicit scope and its opened snapshot to the encoded license route', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { ok: true, changed: true, requiresOfflineReissue: false }));
    vi.stubGlobal('fetch', fetch);
    const body = { allowedSystems: ['system-a', 'system-b'], allowedTools: [], allowedMatters: { 'system-a': ['matter-a'], 'system-b': ['matter-b'] }, expectedScope: { allowedSystems: ['system-a'], allowedTools: [], allowedMatters: null } };
    await expect(adminApi.updateLicenseScope('license/a', body)).resolves.toEqual({ ok: true, changed: true, requiresOfflineReissue: false });
    expect(fetch.mock.calls[0][0]).toBe('/api/admin/licenses/license%2Fa/scope');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify(body) });
  });

  it('preserves a scope concurrency conflict for refresh feedback', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(409, { code: 'LICENSE_SCOPE_CONFLICT', error: '授权已更新，请刷新后重试' })));
    await expect(adminApi.updateLicenseScope('license-a', { allowedSystems: [], allowedTools: ['tool-a'], allowedMatters: {}, expectedScope: { allowedSystems: [], allowedTools: [], allowedMatters: null } })).rejects.toMatchObject({ status: 409, code: 'LICENSE_SCOPE_CONFLICT' });
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });
});
