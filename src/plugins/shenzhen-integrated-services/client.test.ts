import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ fetch: vi.fn(), fromPartition: vi.fn() }));
vi.mock('electron', () => ({ session: { fromPartition: electron.fromPartition } }));
import { ShenzhenIntegratedClient } from './client';
import { SHENZHEN_ORIGIN, SHENZHEN_PARTITION } from './catalog';

const token = 'synthetic-qa-token-a';
const freshToken = 'synthetic-qa-token-b';
const identity = { userId: 'synthetic-qa-user', userName: '合成测试用户', functionId: [] };
const reply = (map: unknown, appcode: string | number = '0', status = 200) => new Response(JSON.stringify({ msg: '', appcode, map }), { status, headers: { 'Content-Type': 'application/json' } });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const ready = (fetcher = vi.fn(async () => reply([])), extra: ConstructorParameters<typeof ShenzhenIntegratedClient>[0] = {}) => {
  const client = new ShenzhenIntegratedClient({ fetcher, ...extra }); client.acceptToken(token); return { client, fetcher };
};

beforeEach(() => {
  vi.clearAllMocks();
  electron.fromPartition.mockReturnValue({ fetch: electron.fetch });
});
afterEach(() => vi.useRealTimers());

describe('Shenzhen read-only transport and credentials', () => {
  it('requires a captured token and never treats missing credentials as a session', async () => {
    const fetcher = vi.fn(); const client = new ShenzhenIntegratedClient({ fetcher });
    expect(client.apiCredentials()).toMatchObject({ status: 'missing' }); expect(client.snapshot()).toBeNull();
    await expect(client.list({})).rejects.toMatchObject({ code: 'SESSION_EXPIRED' }); expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps the same token revision and does not accept malformed header values', () => {
    const { client } = ready(); const revision = client.apiCredentials().revision;
    for (const value of [token, '', 'null', 'undefined', 'two words', 'x\r\ny', 'x'.repeat(16_385)]) client.acceptToken(value);
    expect(client.apiCredentials().revision).toBe(revision);
    expect(client.snapshot()).toMatchObject({ token });
  });

  it('uses only the fixed POST JSON read endpoints and raw Access-Token header', async () => {
    const { client, fetcher } = ready();
    await client.list({ jsqssj: '20261101000000', jszzsj: '20261127235959' });
    await client.handling({ ywlsh: 'synthetic-process' });
    await client.handling({ lsh: 'synthetic-application' });
    expect((fetcher.mock.calls as unknown as Array<[string, RequestInit]>).map(([url]) => url)).toEqual([
      SHENZHEN_ORIGIN + '/TRANSB/busiInstanceInfo/queryAllDealtBusiList',
      SHENZHEN_ORIGIN + '/TRANSB/busiInstanceInfo/queryBusiInstanceLog',
      SHENZHEN_ORIGIN + '/TRANSB/busiInstanceInfo/queryBusiInstanceLog',
    ]);
    for (const [, init] of fetcher.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'Access-Token': token, 'Content-Type': 'application/json' } });
      expect(init.headers).not.toHaveProperty('Authorization');
    }
    expect(JSON.parse((fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[1][1].body as string)).toEqual({ ywlsh: 'synthetic-process' });
    expect(JSON.parse((fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[2][1].body as string)).toEqual({ lsh: 'synthetic-application' });
  });

  it('uses the independent persistent Electron session by default', async () => {
    electron.fetch.mockResolvedValue(reply([])); const client = new ShenzhenIntegratedClient(); client.acceptToken(token);
    await client.list({}); expect(electron.fromPartition).toHaveBeenCalledWith(SHENZHEN_PARTITION); expect(electron.fetch).toHaveBeenCalledOnce();
  });

  it.each([{}, { lsh: '' }, { ywlsh: 'x\n' }, { ywlsh: 'x'.repeat(257) }])('rejects unusable handling linkage without calling the source: %j', async parameters => {
    const { client, fetcher } = ready();
    await expect(client.handling(parameters)).rejects.toMatchObject({ code: 'QUERY_INVALID' }); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403])('rejects HTTP %s once and will not revive the same rejected token', async status => {
    const { client, fetcher } = ready(vi.fn(async () => reply(null, '0', status)));
    await expect(client.list({})).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(client.apiCredentials().status).toBe('expired'); expect(client.snapshot()).toBeNull();
    client.acceptToken(token); expect(client.apiCredentials().status).toBe('expired');
    client.acceptToken(freshToken); expect(client.apiCredentials().status).toBe('present'); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('recognizes a business 401 but does not mistake another business failure for successful data', async () => {
    const { client, fetcher } = ready(vi.fn().mockResolvedValueOnce(reply(null, '1')).mockResolvedValueOnce(reply(null, '401')));
    await expect(client.list({})).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' }); expect(client.apiCredentials().status).toBe('present');
    await expect(client.list({})).rejects.toMatchObject({ code: 'SESSION_EXPIRED' }); expect(client.apiCredentials().status).toBe('expired');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes explicit source login redirects without following them', async () => {
    const { client, fetcher } = ready(vi.fn(async () => new Response(null, { status: 302, headers: { location: '/cas/login' } })));
    await expect(client.list({})).rejects.toMatchObject({ code: 'SESSION_EXPIRED' }); expect(fetcher).toHaveBeenCalledOnce();
    expect(client.apiCredentials().status).toBe('expired');
  });

  it.each([
    () => new Response('<html>synthetic</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(JSON.stringify({ map: [] }), { headers: { 'Content-Type': 'application/json' } }),
    () => reply({}, '0'), () => reply([null], '0'),
    () => reply(null, '0', 504),
  ])('does not retry malformed results, HTML or non-timeout failures', async makeResponse => {
    const { client, fetcher } = ready(vi.fn(async () => makeResponse()));
    await expect(client.list({})).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(client.apiCredentials().status).toBe('present');
  });

  it('does not leak raw network error messages into task errors', async () => {
    const { client, fetcher } = ready(vi.fn(async () => { throw Error('synthetic-private-network-detail'); }));
    const error = await client.list({}).catch(error => error);
    expect(error.code).toBe('REMOTE_REQUEST_FAILED'); expect(error.message).not.toContain('synthetic-private-network-detail'); expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('Shenzhen queue, bounded timeout retries and cancellation', () => {
  it('serializes the identity probe, lists and handling reads without a fixed interval', async () => {
    const pending: Array<ReturnType<typeof deferred<Response>>> = [];
    const fetcher = vi.fn(() => { const next = deferred<Response>(); pending.push(next); return next.promise; });
    const { client } = ready(fetcher); const first = client.validateSession(); const second = client.list({}); const third = client.handling({ lsh: 'synthetic-application' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); pending[0].resolve(reply(identity)); await first;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); pending[1].resolve(reply([])); await second;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3)); pending[2].resolve(reply([])); await third;
  });

  it('bounds a hanging fetch to exactly five timeout attempts', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise<Response>(() => {})); const { client } = ready(fetcher, { timeoutMs: 20 });
    const result = client.list({}).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ code: 'REMOTE_TIMEOUT', details: { attempts: 5, retryable: false } }); expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('also bounds a hanging response body and stops after five attempts', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), json: () => new Promise(() => {}) }) as Response);
    const { client } = ready(fetcher, { timeoutMs: 20 }); const result = client.handling({ lsh: 'synthetic-application' }).catch(error => error);
    await vi.advanceTimersByTimeAsync(100); expect((await result).code).toBe('REMOTE_TIMEOUT'); expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('permits the fifth attempt to succeed after explicit timeout errors', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new DOMException('synthetic', 'TimeoutError')).mockRejectedValueOnce(new DOMException('synthetic', 'TimeoutError'))
      .mockRejectedValueOnce(new DOMException('synthetic', 'TimeoutError')).mockRejectedValueOnce(new DOMException('synthetic', 'TimeoutError')).mockResolvedValueOnce(reply([]));
    const { client } = ready(fetcher); expect(await client.list({})).toEqual([]); expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('retries explicit response-body timeout errors instead of calling them malformed JSON', async () => {
    const timedBody = { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => { throw new DOMException('synthetic', 'TimeoutError'); } } as unknown as Response;
    const fetcher = vi.fn().mockResolvedValueOnce(timedBody).mockResolvedValueOnce(reply([])); const { client } = ready(fetcher);
    expect(await client.list({})).toEqual([]); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('cancels active reads without using the remaining timeout attempts', async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {})); const { client } = ready(fetcher); const controller = new AbortController();
    const result = client.list({}, controller.signal).catch(error => error);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); controller.abort();
    expect((await result).code).toBe('TASK_CANCELLED'); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('removes a canceled queued read without delaying later work or making its request', async () => {
    const pending = deferred<Response>(); const fetcher = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(reply([]));
    const { client } = ready(fetcher); const first = client.list({}); const controller = new AbortController();
    const second = client.handling({ lsh: 'synthetic-canceled' }, controller.signal).catch(error => error); controller.abort();
    expect((await second).code).toBe('TASK_CANCELLED'); expect(fetcher).toHaveBeenCalledTimes(1);
    const third = client.list({}); pending.resolve(reply([])); await first; await third; expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('Shenzhen verified login and safe restoration', () => {
  it('validates through the identity endpoint and combines concurrent probes with a short cache', async () => {
    const fetcher = vi.fn(async () => reply(identity)); let now = 1_000;
    const { client } = ready(fetcher, { now: () => now });
    const [one, two] = await Promise.all([client.validateSession(), client.validateSession()]); expect(one).toEqual(two);
    expect(fetcher).toHaveBeenCalledOnce(); expect((fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0][0]).toBe(SHENZHEN_ORIGIN + '/TRANSB/security/getUserInfoByToken');
    await client.validateSession(); expect(fetcher).toHaveBeenCalledOnce();
    now += 30_000; await client.validateSession(); expect(fetcher).toHaveBeenCalledTimes(2);
    await client.validateSession(undefined, true); expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(one)).not.toContain(token); expect(JSON.stringify(one)).not.toContain(identity.userId);
  });

  it('does not cache an unsuccessful identity probe even after an earlier valid probe', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply(identity)).mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply(identity));
    const { client } = ready(fetcher); await client.validateSession();
    await expect(client.validateSession(undefined, true)).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' });
    await client.validateSession(); expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('lets one canceled identity observer leave a shared probe available to another', async () => {
    const pending = deferred<Response>(), fetcher = vi.fn(() => pending.promise); const { client } = ready(fetcher);
    const controller = new AbortController(); const canceled = client.validateSession(controller.signal).catch(error => error); const active = client.validateSession();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); controller.abort(); expect((await canceled).code).toBe('TASK_CANCELLED');
    pending.resolve(reply(identity)); await expect(active).resolves.toHaveProperty('displayName'); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not let a late old-token authorization failure invalidate a newly captured token', async () => {
    const pending = deferred<Response>(); const fetcher = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(reply(identity));
    const { client } = ready(fetcher); const old = client.list({}).catch(error => error);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); client.acceptToken(freshToken); pending.resolve(reply(null, '0', 401));
    expect((await old).code).toBe('SESSION_EXPIRED'); expect(client.apiCredentials().status).toBe('present');
    await client.validateSession(); expect(client.snapshot()).toMatchObject({ token: freshToken }); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not cache a late old-token success as validation of a new token', async () => {
    const pending = deferred<Response>(); const fetcher = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(reply(identity));
    const { client } = ready(fetcher); const old = client.validateSession().catch(error => error);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); client.acceptToken(freshToken); pending.resolve(reply(identity));
    expect((await old).code).toBe('SESSION_EXPIRED'); await client.validateSession(); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('restores only named portal storage and always validates the restored token again', async () => {
    const fetcher = vi.fn(async () => reply(identity)); const { client } = ready(fetcher);
    client.acceptStorage({ 'access-token': token, empno: 'synthetic-qa-user', functionid: 'synthetic-permission', unexpectedSecret: 'synthetic-ignored' });
    await client.validateSession(); const saved = client.snapshot()!;
    expect(JSON.stringify(saved)).not.toContain('synthetic-ignored');
    const restored = new ShenzhenIntegratedClient({ fetcher }); restored.restore(saved);
    const clone = restored.snapshot()!; (clone.storage as Record<string, string>).empno = 'mutated';
    expect(restored.snapshot()).toMatchObject({ token, storage: { empno: 'synthetic-qa-user' } });
    await restored.validateSession(); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('invalidates both login routes and ignores foreign navigation without reading old storage as login', async () => {
    const { client } = ready(); client.noteNavigation('https://foreign.example/TRANS/login'); expect(client.apiCredentials().status).toBe('present');
    client.noteNavigation(SHENZHEN_ORIGIN + '/TRANS/login'); expect(client.apiCredentials().status).toBe('missing'); expect(client.browserAuthGeneration()).toBeNull();
    client.acceptStorage({ 'access-token': token }); expect(client.snapshot()).toBeNull();
    client.noteNavigation(SHENZHEN_ORIGIN + '/cas/systemList'); expect(client.apiCredentials().status).toBe('missing');
    client.acceptToken(freshToken); expect(client.apiCredentials().status).toBe('present');
    client.noteNavigation(SHENZHEN_ORIGIN + '/cas/login'); expect(client.snapshot()).toBeNull(); expect(client.apiCredentials().status).toBe('missing');
  });
});
