import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/network/request-policy', () => ({ RequestGate: class {
  execute(operation: (signal: AbortSignal) => unknown, signal?: AbortSignal) { return operation(signal ?? new AbortController().signal); }
} }));
import { OversizeTransportClient, OVERSIZE_APPLICATION_PATH, OVERSIZE_PAGE_URL, OVERSIZE_PORTAL_TOKEN_KEY, portalTokenFromStorage } from './client';
const token = '12345678-1234-1234-1234-123456789abc';
const portalToken = '87654321-4321-4321-4321-cba987654321';
const signal = () => AbortSignal.timeout(3000);
const page = (records: unknown[] = [], total = records.length, current = 1) => Response.json({ code: 0, isSuccess: true, data: { records, total: String(total), current: String(current) } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function clientWith(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetcher);
  const client = new OversizeTransportClient(); client.restoreSession({ token }); return client;
}
describe('oversize 3.0 authentication and certificate pagination', () => {
  it('uses the portal entry and parses only a live Vue-ls portal token', () => {
    expect(OVERSIZE_PAGE_URL).toBe('https://td.gd.gov.cn/appLzxt/login');
    expect(portalTokenFromStorage({ [OVERSIZE_PORTAL_TOKEN_KEY]: JSON.stringify({ value: portalToken, expire: Date.now() + 10000 }) })).toBe(portalToken);
    expect(portalTokenFromStorage({ [OVERSIZE_PORTAL_TOKEN_KEY]: JSON.stringify({ value: portalToken, expire: Date.now() - 1 }) })).toBe('');
    expect(portalTokenFromStorage({ [OVERSIZE_PORTAL_TOKEN_KEY]: 'invalid' })).toBe('');
  });
  it('never treats the old bis cookie or a present token as verified', async () => {
    const client = new OversizeTransportClient(); client.restoreSession({ cookie: 'JSESSIONID=legacy' });
    expect(client.exportSession()).toBeNull();
    await expect(client.validateSession(signal())).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    client.acceptBrowserToken(token); expect(client.isAuthenticated()).toBe(false);
  });
  it('exchanges the platform token, then confirms a bounded business query', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ code: 0, data: { token }, isSuccess: true })).mockResolvedValueOnce(page());
    vi.stubGlobal('fetch', fetcher);
    const client = new OversizeTransportClient();
    client.acceptPortalStorage({ [OVERSIZE_PORTAL_TOKEN_KEY]: JSON.stringify({ value: portalToken }) });
    await client.validateSession(signal());
    const [url, init] = fetcher.mock.calls[0];
    expect(new URL(url).pathname).toBe('/gddj/api/oauth/anyTenant/lzxt/sso/login');
    expect(new URL(url).searchParams.get('token')).toBe(portalToken); expect(init.method).toBe('POST');
    const [queryUrl, queryInit] = fetcher.mock.calls[1];
    expect(new URL(queryUrl).searchParams.get('pageSize')).toBe('1');
    expect(queryInit.headers).toMatchObject({ Token: token, ApplicationId: '3' });
    expect(client.isAuthenticated()).toBe(true);
    expect(client.exportSession()).toEqual({ token, portalToken });
  });
  it('does not send configured account/password through the obsolete login API', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const client = new OversizeTransportClient(); client.configureCredentials({ account: 'fixture-account', password: 'fixture-password' });
    await expect(client.login()).rejects.toMatchObject({ code: 'SYSTEM_LOGIN_REQUIRED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('paginates every certificate, preserving invalid/expired certificates and using no unsupported date/status filters', async () => {
    const records = Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), reqNo: `B441300202610${String(i).padStart(7, '0')}`, status: i % 2 }));
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page(records.slice(0, 10), 12, 1)).mockResolvedValueOnce(page(records.slice(10), 12, 2));
    const client = clientWith(fetcher); await client.validateSession(signal());
    expect(await client.fetchIssuedList('2026-10-01', '2026-10-18', signal())).toEqual(records);
    for (const [url] of fetcher.mock.calls) {
      const query = new URL(url).searchParams;
      expect(query.get('reqNo')).toBe('4413'); expect(query.has('status')).toBe(false); expect(query.has('startTime')).toBe(false);
    }
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get('pageNo')).toBe('2');
  });
  it.each(['duplicate', 'changed-total', 'empty', 'wrong-page'])('rejects incomplete or unstable pagination: %s', async (kind) => {
    const first = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));
    const last = kind === 'duplicate' ? [{ id: '0' }] : kind === 'empty' ? [] : [{ id: '11' }];
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page(first, 11, 1))
      .mockResolvedValueOnce(page(last, kind === 'changed-total' ? 12 : 11, kind === 'wrong-page' ? 1 : 2));
    const client = clientWith(fetcher); await client.validateSession(signal());
    await expect(client.fetchIssuedList('2026-10-01', '2026-10-18', signal())).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' });
  });
  it('preserves saved credentials during network/server failures and never logs a token-bearing URL', async () => {
    const client = clientWith(vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(new Response('', { status: 503 })));
    await client.validateSession(signal());
    await expect(client.validateSession(signal())).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' });
    expect(client.exportSession()).toEqual({ token, portalToken: '' });
    const fetcher = vi.fn().mockRejectedValue(new Error(`fetch failed https://example.test/?token=${portalToken}`)); vi.stubGlobal('fetch', fetcher);
    client.restoreSession({ portalToken });
    await expect(client.validateSession(signal())).rejects.toThrow('连接失败');
    try { await client.validateSession(signal()); } catch (error) { expect(String(error)).not.toContain(portalToken); }
  });
  it.each([401, 403])('invalidates HTTP %s and does not confuse it with a valid login', async (status) => {
    const client = clientWith(vi.fn().mockResolvedValue(new Response('', { status })));
    await expect(client.validateSession(signal())).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(client.isAuthenticated()).toBe(false);
  });
  it('renews an expired subsystem token through the saved portal session', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ code: 0, data: { token } })).mockResolvedValueOnce(page());
    const client = clientWith(fetcher); client.restoreSession({ token, portalToken });
    await client.validateSession(signal()); expect(client.isAuthenticated()).toBe(true); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not resurrect a login from an SSO response arriving after logout', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const client = clientWith(fetcher); client.restoreSession({ portalToken });
    const checking = client.validateSession(signal()); client.clearSession();
    finish(Response.json({ code: 0, data: { token } }));
    await expect(checking).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' });
    expect(client.exportSession()).toBeNull(); expect(client.isAuthenticated()).toBe(false);
  });
  it('does not clear a new login when an older request later receives HTTP 401', async () => {
    let finish!: (response: Response) => void;
    const client = clientWith(vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const checking = client.validateSession(signal()); client.acceptBrowserToken(portalToken);
    finish(new Response('', { status: 401 }));
    await expect(checking).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' });
    expect(client.exportSession()).toEqual({ token: portalToken, portalToken: '' });
  });
  it.each([{ code: null, data: { records: [], total: 0, current: 1 } }, { code: 0, data: { records: [], total: null, current: 1 } }, { code: 0, data: {} }])('rejects inconclusive success-shaped JSON', async (body) => {
    const client = clientWith(vi.fn().mockResolvedValue(Response.json(body)));
    await expect(client.validateSession(signal())).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' });
    expect(client.isAuthenticated()).toBe(false);
  });
  it('POSTs the full application number and complete UI query shape, paginates and strips agent personal information', async () => {
    const reqNo = 'B4413002026101260031';
    const records = Array.from({ length: 11 }, (_, i) => ({ id: String(i + 1), reqNo: i ? `${reqNo}${i}` : reqNo,
      transportName: '测试公司', transportCreditCode: '91440300123456789Q', agentName: '不留存', agentId: '不留存', tel: '不留存' }));
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page(records.slice(0,10),11,1)).mockResolvedValueOnce(page(records.slice(10),11,2));
    const client = clientWith(fetcher); await client.validateSession(signal());
    const result = await client.fetchApplicationRecords(reqNo, signal());
    expect(result).toHaveLength(11); expect(Object.keys(result[0]).sort()).toEqual(['id','reqNo','transportCreditCode','transportName']);
    const [url, init] = fetcher.mock.calls[1];
    expect(new URL(url).pathname).toBe(OVERSIZE_APPLICATION_PATH); expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Token: token, ApplicationId: '3', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ agentName: '', endTime: '', pageNo: 1, pageSize: 10, reqNo, startTime: '', status: '', tractorNo: '', trailerNo: '', versionSource: '' });
    expect(JSON.parse(fetcher.mock.calls[2][1].body).pageNo).toBe(2);
    expect(JSON.stringify(result)).not.toContain('不留存');
  });
  it.each(['over-limit','changed-total','wrong-page','empty','duplicate'])('rejects unsafe application pagination: %s', async kind => {
    const first = Array.from({ length: 10 }, (_, i) => ({ id: String(i), reqNo: 'B4413002026101260031' }));
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page(first, kind === 'over-limit' ? 101 : 11, 1))
      .mockResolvedValueOnce(page(kind === 'empty' ? [] : [{ id: kind === 'duplicate' ? '0' : '11' }], kind === 'changed-total' ? 12 : 11, kind === 'wrong-page' ? 1 : 2));
    const client = clientWith(fetcher); await client.validateSession(signal());
    await expect(client.fetchApplicationRecords('B4413002026101260031', signal())).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' });
  });
  it('does not allow an in-flight application lookup to survive a changed login', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const client = clientWith(fetcher); await client.validateSession(signal());
    const request = client.fetchApplicationRecords('B4413002026101260031', signal());
    client.clearSession(); finish(page());
    await expect(request).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED', details: { sessionChanged: true } });
  });
  it('requires a verified session and complete Huizhou application number', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page());
    const client = clientWith(fetcher);
    await expect(client.fetchApplicationRecords('B4413002026101260031')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await client.validateSession(signal());
    await expect(client.fetchApplicationRecords('4413')).rejects.toMatchObject({ code: 'QUERY_INVALID' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('marks a failed in-flight request as a session change instead of permitting a name fallback', async () => {
    let fail!: (error: Error) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { fail = reject; }));
    const client = clientWith(fetcher); await client.validateSession(signal());
    const request = client.fetchApplicationRecords('B4413002026101260031', signal());
    client.clearSession(); fail(new Error('network error containing private URL'));
    await expect(request).rejects.toMatchObject({ details: { sessionChanged: true, retryable: false } });
  });
});
