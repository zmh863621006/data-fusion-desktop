import { afterEach, describe, expect, it, vi } from 'vitest';
const browserFetch = vi.hoisted(() => vi.fn());
const governmentSearch = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ session: { fromPartition: () => ({ fetch: browserFetch,
  cookies: { get: async () => [] }, webRequest: { onBeforeSendHeaders: vi.fn(), onCompleted: vi.fn() },
}) } }));
vi.mock('./government-info/approval-detail', () => ({ checkGovernmentSession: governmentSearch }));
import { MarketAccessClient } from './market-access/client';
import { GovernmentInfoClient } from './government-info/client';
import { PractitionerClient } from './transport-practitioner/client';
import { OversizeTransportClient } from './oversize-transport/client';
import { OnlineCarPermitClient } from './online-car-permit/client';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const signal = () => AbortSignal.timeout(2000);

describe('read-only session verification for each source system', () => {
  it('does not overwrite separately captured government LID with a stale browser snapshot', async () => {
    const client = new GovernmentInfoClient();
    client.configureSessionPersistence({ load: async () => 'latest-lid', save: async () => {}, clear: async () => {} });
    await client.initialize();
    client.restoreSession({ sid: 'saved-sid', lid: 'stale-lid' });
    governmentSearch.mockResolvedValueOnce({ result: [] });
    await client.validateSession(signal());
    expect(governmentSearch).toHaveBeenCalledWith(expect.any(Function), { sid: 'saved-sid', lid: 'latest-lid' }, expect.any(AbortSignal));
    expect(await client.exportSession()).toEqual({ sid: 'saved-sid', lid: 'latest-lid' });
    expect(client.homeUrl()).toContain('lid=latest-lid');
  });

  it('validates market access via the current-user endpoint, not just cookie presence', async () => {
    const client = new MarketAccessClient(); client.initialize();
    browserFetch.mockResolvedValueOnce(Response.json({ userinfo: { userid: 'id', loginname: 'name', username: 'user', orgcode: 'org' } }));
    expect(await client.validateSession(signal())).toEqual({ displayName: 'user' });
    expect(browserFetch.mock.calls[0][0]).toContain('/getCurrentUser.do');
    browserFetch.mockResolvedValueOnce(Response.json({}));
    await expect(client.validateSession(signal())).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    browserFetch.mockRejectedValueOnce(new Error('offline'));
    await expect(client.validateSession(signal())).rejects.toThrow('offline');
  });

  it('restores the government pair and verifies via a bounded list query, not export', async () => {
    const client = new GovernmentInfoClient(); await client.initialize();
    client.restoreSession({ sid: 'fixture-sid', lid: 'fixture-lid' });
    governmentSearch.mockResolvedValueOnce({ result: [] });
    expect(await client.validateSession(signal())).toHaveProperty('displayName');
    expect(governmentSearch).toHaveBeenCalledWith(expect.any(Function), { sid: 'fixture-sid', lid: 'fixture-lid' }, expect.any(AbortSignal));
    expect(client.homeUrl()).toContain('/Index.html?lid=fixture-lid');
    governmentSearch.mockResolvedValueOnce({ error: 'unconfirmed' });
    await expect(client.validateSession(signal())).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' });
    expect(await client.exportSession()).toEqual({ sid: 'fixture-sid', lid: 'fixture-lid' });
  });

  it('validates a restored practitioner token with one archive row and refreshes only after success', async () => {
    const client = new PractitionerClient(); client.restoreSession({ token: '12345678-1234-1234-1234-123456789abc' });
    expect(client.isAuthenticated()).toBe(false);
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ publicresponse: { statuscode: 0 }, body: { items: [], totalcount: 0 } }));
    vi.stubGlobal('fetch', fetcher);
    await client.validateSession(signal());
    const body = JSON.parse(decodeURIComponent(String(fetcher.mock.calls[0][1]!.body).slice(1)));
    expect(body).toMatchObject({ publicrequest: { servicecode: '007400100021' }, body: { Page: 1, Rows: 1 } });
    expect(client.isAuthenticated()).toBe(true);
  });

  it('validates restored oversize 3.0 tokens with a one-row list, not a full export', async () => {
    const client = new OversizeTransportClient(); client.restoreSession({ token: '12345678-1234-1234-1234-123456789abc' });
    expect(client.isAuthenticated()).toBe(false);
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ code: 0, data: { records: [], total: '0', current: '1' } }));
    vi.stubGlobal('fetch', fetcher); await client.validateSession(signal());
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe('/gddj/api/approve/permission/getCertificateList');
    expect(url.searchParams.get('reqNo')).toBe('4413');
    expect(url.searchParams.get('pageSize')).toBe('1');
    expect(client.isAuthenticated()).toBe(true);
  });

  it('validates the restored vehicle token with size 1 and retains it on HTTP 503', async () => {
    const client = new OnlineCarPermitClient(); client.restoreSession({ token: 'Bearer fixture-token' });
    expect(client.isAuthenticated()).toBe(false);
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ code: 200, data: { records: [] } }));
    vi.stubGlobal('fetch', fetcher); await client.validateSession(signal());
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('size')).toBe('1');
    expect(client.isAuthenticated()).toBe(true);
    fetcher.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(client.validateSession(signal())).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' });
    expect(client.exportSession()).toEqual({ token: 'Bearer fixture-token' });
  });

  it.each([401, 403])('does not accept HTTP %s as a successful vehicle session', async (status) => {
    const client = new OnlineCarPermitClient(); client.restoreSession({ token: 'Bearer fixture-token' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
    await expect(client.validateSession(signal())).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(client.isAuthenticated()).toBe(false);
  });
});
