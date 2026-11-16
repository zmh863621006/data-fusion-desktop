import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }));
import { HazardousClient, decodeHazardousReply } from './client';
import { HAZCHEM_MATTERS, HAZCHEM_SERVICES } from './catalog';
const envelope = (data: unknown[], total?: number) => ({ SYS_HEAD: { RET_STATUS: 'S', RET: [{ RET_CODE: '000000' }] }, BODY: { status: 'success', data, ...(total === undefined ? {} : { total }) } });
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function client(fetcher: (url: string, init: RequestInit) => Promise<Response>) {
  const c = new HazardousClient({ fetcher, minimumIntervalMs: 0 }); c.acceptStorage({ Authorization: 'fixture-secret', userId: 'fixture-user' }); return c;
}
describe('危化品只读列表客户端', () => {
  it('validates restored sessions with the real done-list success envelope, not HTTP status alone', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => response(envelope([], 0)));
    const c = client(fetcher); expect(c.verified()).toBe(false);
    await c.validateSession(); expect(c.verified()).toBe(true);
    const [url, init] = fetcher.mock.calls[0], body = JSON.parse(String(init.body));
    expect(url).toBe('https://szwh.yjgl.sz.gov.cn/DataBus/exchange');
    expect(body).toMatchObject({ CONSUMER_ID: 'fixture-secret', userId: 'fixture-user', SERVICE_CODE: HAZCHEM_SERVICES.done, pageNumber: 1, pageSize: 1 });
    const snapshot = c.exportSession()!; c.restoreSession(snapshot); expect(c.verified()).toBe(false); await c.validateSession(); expect(c.verified()).toBe(true);
  });
  it('recognizes HTTP200 gateway authorization rejection and clears credentials without exposing server messages', async () => {
    const c = client(async () => response({ SYS_HEAD: { RET_STATUS: 'F', RET: [{ RET_CODE: '008899', RET_MSG: 'fixture-secret' }] } }));
    await expect(c.validateSession()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' }); expect(c.exportSession()).toBeNull();
    expect(() => decodeHazardousReply({ SYS_HEAD: { RET_STATUS: 'F', RET: [{ RET_CODE: 'other', RET_MSG: 'fixture-secret' }] } })).toThrow('危化品系统未返回成功结果');
  });
  it('requires token AND userId, clears removed portal storage and rejects line breaks', () => {
    const c = client(async () => response(envelope([], 0)));
    c.acceptStorage({ Authorization: 'fixture-secret' }); expect(c.hasSession()).toBe(false);
    c.acceptStorage({ Authorization: 'fixture\nsecret', userId: 'fixture-user' }); expect(c.hasSession()).toBe(false);
    c.acceptStorage({}); expect(c.exportSession()).toBeNull();
  });
  it('paginates all done rows with the exact matter code and rejects incomplete pagination', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body)); expect(q.sxbmShort).toBe(HAZCHEM_MATTERS[0].sourceCode);
      return response(envelope(q.pageNumber === 1 ? [{ sblshShort: 'one' }] : [{ sblshShort: 'two' }], 2));
    });
    expect(await client(fetcher).done(HAZCHEM_MATTERS[0])).toHaveLength(2); expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(client(async () => response(envelope([], 2))).done(HAZCHEM_MATTERS[0])).rejects.toThrow('分页不完整');
  });
  it('reads report and matched certificate rows using only the two documented list services', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body));
      if (q.SERVICE_CODE === HAZCHEM_SERVICES.report) { expect(q.startTime).toBe(''); expect(q.endTime).toBe(''); return response(envelope([{ number: 1 }])); }
      expect(q.SERVICE_CODE).toBe(HAZCHEM_SERVICES.certificates); expect(q.bizNum).toBe('fixture-serial');
      return response(envelope([{ bizNum: 'fixture-serial' }, { bizNum: 'other-serial' }], 2));
    });
    const c = client(fetcher); expect(await c.report()).toHaveLength(1); expect(await c.certificates('fixture-serial')).toHaveLength(1);
  });
  it('cancels before sending requests and rejects changed list totals', async () => {
    const f = vi.fn(async () => response(envelope([], 0))), c = client(f); const controller = new AbortController(); controller.abort();
    await expect(c.done(HAZCHEM_MATTERS[0], controller.signal)).rejects.toMatchObject({ code: 'TASK_CANCELLED' }); expect(f).not.toHaveBeenCalled();
    let count = 0; const changing = client(async () => response(envelope([{ sblshShort: String(++count) }], count === 1 ? 3 : 4)));
    await expect(changing.done(HAZCHEM_MATTERS[0])).rejects.toThrow('数量发生变化');
  });
});
