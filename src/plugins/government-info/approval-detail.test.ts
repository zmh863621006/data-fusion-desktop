import { describe, expect, it, vi } from 'vitest';
import { buildAttachmentUrl, buildEntrySearchParameters, buildSessionCheckParameters, checkGovernmentSession, downloadApprovalAttachment, getRunningApprovalData, searchApprovalByPrimaryKey } from './approval-detail';
import type { GovernmentInfoFetch } from './approval-export';
import { decryptEcs14Request, decryptEcsRequest } from './codec';

const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-~';
function responsePayload(value: string): string {
  const base64 = Buffer.from(encodeURIComponent(value), 'utf8').toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '~');
  const padded = `ABCDE${base64}FGHIJ`;
  let hash = 1369;
  for (let index = padded.length - 1; index >= 0; index -= 1) hash = (hash + (hash << 5) + padded.charCodeAt(index)) | 0;
  let positive = hash & 0x7fffffff;
  let checksum = '';
  do { checksum += TABLE[positive & 63]; positive >>= 6; } while (positive !== 0);
  const first = Math.floor(padded.length * .25);
  const second = Math.floor(padded.length * .75);
  return `${padded.slice(0, first)}${checksum.padEnd(6, '_')}${padded.slice(first, second)}XYZ${padded.slice(second)}`;
}

const credentials = { sid: 'session', lid: 'lid' };

describe('government information detail protocol', () => {
  it('checks a session with the working list protocol bounded to one row', async () => {
    const query = JSON.parse(JSON.parse(buildSessionCheckParameters())[0]);
    expect(query).toMatchObject({ pageModule: 'ecs_queryAll', name: 'laam_ex_sb', pageNum: 1, pageSize: 1 });
    expect(query.parameters).toEqual([{ name: 'sbsj', value: '2025-01-15', flag: 16 }]);
    expect(query).not.toHaveProperty('fields');
    expect(query).not.toHaveProperty('toCount');
    expect(query.extendQuery).not.toMatch(/SESSION-CHECK|sblsh like/);
    const fetcher = vi.fn<GovernmentInfoFetch>(async () => new Response(responsePayload('{"result":[{"id":"fixture"}]}')));
    const signal = AbortSignal.timeout(2000);
    expect(await checkGovernmentSession(fetcher, credentials, signal)).toMatchObject({ result: [{ id: 'fixture' }] });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('http://10.200.96.11/ECS/LEAP/Service/RPC/RPC.DO');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', signal,
      headers: { LID: 'lid', QS: 'method=ecs_searchAll&sid=session&parlen=1', 'Data-Type': '16' } });
    expect(decryptEcsRequest(String(init.body))).toBe(buildSessionCheckParameters());
  });

  it.each(['', 'not-an-encoded-response'])('does not accept HTTP 200 with an unusable body (%j)', async (body) => {
    await expect(checkGovernmentSession(async () => new Response(body), credentials))
      .rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED', details: { reason: body ? 'INVALID_RPC_RESPONSE' : 'EMPTY_RESPONSE' } });
  });

  it.each([401, 403, 404])('rejects HTTP %s during session verification', async (status) => {
    await expect(checkGovernmentSession(async () => new Response('', { status }), credentials))
      .rejects.toMatchObject({ code: status === 404 ? 'REMOTE_REQUEST_FAILED' : 'SESSION_EXPIRED' });
  });

  it('rejects query control characters and attachment traversal', () => {
    expect(() => buildEntrySearchParameters("abc' or 1=1")).toThrow('流水号');
    expect(() => buildAttachmentUrl({ nameedPath: '../outside', name: 'a.docx' })).toThrow('路径');
    expect(() => buildAttachmentUrl({ nameedPath: 'folder', name: '../a.docx' })).toThrow('路径');
  });

  it('propagates attachment session expiry and does not retry permanent missing files', async () => {
    const url = buildAttachmentUrl({ nameedPath: 'folder', name: 'a.docx' });
    await expect(downloadApprovalAttachment(async () => new Response('', { status: 401 }), url))
      .rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(downloadApprovalAttachment(async () => new Response('', { status: 404 }), url))
      .rejects.toMatchObject({ details: { retryable: false } });
  });
  it('uses Data-Type 14 for WfGetRunningData', async () => {
    const fetcher = vi.fn<GovernmentInfoFetch>(async () => new Response(responsePayload('{"recordBean":{}}')));
    await getRunningApprovalData(fetcher, credentials, 'wf-1');
    const [, init] = fetcher.mock.calls[0];
    expect(init.headers).toMatchObject({ 'Data-Type': '14', QS: 'method=WfGetRunningData&sid=session&parlen=4', lrqvt: '3' });
    expect(decryptEcs14Request(String(init.body))).toBe('["wf-1",null,null,null]');
  });

  it('builds the original SearchByPK parameters', async () => {
    const fetcher = vi.fn<GovernmentInfoFetch>(async () => new Response(responsePayload('{"result":[]}')));
    await searchApprovalByPrimaryKey(fetcher, credentials, 'record-1');
    expect(decryptEcs14Request(String(fetcher.mock.calls[0][1].body))).toBe('["ecs_hscspsxkz","record-1"]');
  });

  it('builds the original attachment path', () => {
    expect(buildAttachmentUrl({ nameedPath: 'folder', name: 'a.b.docx' })).toContain('/folder/a/_v3_/a.b.docx');
    expect(buildAttachmentUrl({ nameedPath: 'folder/path', name: '决定书.docx' }))
      .toBe('http://10.200.96.11/ECS/LEAP/Download/folder/path/%E5%86%B3%E5%AE%9A%E4%B9%A6/_v3_/%E5%86%B3%E5%AE%9A%E4%B9%A6.docx');
  });
});
