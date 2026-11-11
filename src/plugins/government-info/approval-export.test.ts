import { describe, expect, it, vi } from 'vitest';
import {
  buildRpcHeaders,
  downloadApprovalWorkbook,
  GOVERNMENT_INFO_RPC_URL,
  normalizeDownloadPath,
  requestApprovalExportPath,
  type GovernmentInfoFetch,
} from './approval-export';
import { decryptEcsRequest } from './codec';
import { buildExportParameters } from './export-request';
import { RequestGate } from '../../core/network/request-policy';

const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-~';

function checksum(value: string): string {
  let hash = 1369;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    hash = (hash + (hash << 5) + value.charCodeAt(index)) | 0;
  }
  let positive = hash & 0x7fffffff;
  let result = '';
  do {
    result += TABLE[positive & 63];
    positive >>= 6;
  } while (positive !== 0);
  return result;
}

function responsePayload(value: string): string {
  const base64 = Buffer.from(encodeURIComponent(value), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '~');
  const padded = `ABCDE${base64}FGHIJ`;
  const first = Math.floor(padded.length * 0.25);
  const second = Math.floor(padded.length * 0.75);
  const hash = checksum(padded).padEnd(6, '_');
  return `${padded.slice(0, first)}${hash}${padded.slice(first, second)}XYZ${padded.slice(second)}`;
}

const credentials = { sid: 'valid-session-id', lid: 'valid-lid' };

describe('government information approval export protocol', () => {
  it('builds the original RPC headers', () => {
    expect(buildRpcHeaders(credentials, 'laam_exportApprovalData', 4, '16')).toMatchObject({
      LID: 'valid-lid',
      QS: 'method=laam_exportApprovalData&sid=valid-session-id&parlen=4',
      'Data-Type': '16',
      lrqvt: '1',
      'Post-Type': '1',
      RESPTYPE: '1',
      Origin: 'http://10.200.96.11',
      Referer: 'http://10.200.96.11/ECS/LEAP/Resource/JavaScript/Base/networker.js',
    });
  });

  it('requests and decrypts the exported workbook path', async () => {
    const exportPath = '2026-09-22/10/综合业务窗口材料交接登记表20260922100000.xlsx';
    const fetcher = vi.fn<GovernmentInfoFetch>(async () => new Response(responsePayload(exportPath)));

    const controller = new AbortController();
    await expect(requestApprovalExportPath(fetcher, credentials, '2026-09-21', '2026-09-30', controller.signal)).resolves.toBe(exportPath);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(GOVERNMENT_INFO_RPC_URL);
    expect(init.method).toBe('POST');
    expect(init.signal).toBe(controller.signal);
    expect(decryptEcsRequest(String(init.body))).toBe(buildExportParameters('2026-09-21', '2026-09-30'));
    const parameters = JSON.parse(JSON.parse(decryptEcsRequest(String(init.body)))[0]).parameters;
    expect(parameters).toEqual([
      { name: 'bj_bjsj', value: '2026-09-21', flag: 16, sqlType: 93 },
      { name: 'bj_bjsj', value: '2026-09-30', flag: 17, sqlType: 93 },
    ]);
  });

  it('downloads an XLSX from the returned path', async () => {
    const fetcher = vi.fn<GovernmentInfoFetch>(async () => new Response(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])));
    const result = await downloadApprovalWorkbook(
      fetcher,
      credentials,
      '2026-09-22/10/综合业务窗口材料交接登记表.xlsx',
    );

    expect(result.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(fetcher.mock.calls[0][0]).toContain('/ECS/LEAP/Download/excelReport/2026-09-22/10/');
  });

  it('rejects unsafe paths and non-XLSX responses without retry hints', async () => {
    expect(() => normalizeDownloadPath('../outside.xlsx')).toThrow('不安全');
    const fetcher = vi.fn<GovernmentInfoFetch>(async () => new Response('not a workbook'));
    await expect(downloadApprovalWorkbook(fetcher, credentials, 'safe.xlsx')).rejects.toMatchObject({
      code: 'REMOTE_REQUEST_FAILED',
      details: { retryable: false },
    });
  });

  it('marks a 404 export response as non-retryable', async () => {
    const fetcher = vi.fn<GovernmentInfoFetch>(async () => new Response('', { status: 404 }));
    await expect(requestApprovalExportPath(fetcher, credentials, '2026-09-21', '2026-09-30')).rejects.toMatchObject({
      code: 'REMOTE_REQUEST_FAILED',
      details: { status: 404, retryable: false },
    });
  });

  it.each(['', '   ', 'invalid-short-response'])('reports unusable HTTP 200 export responses without retrying or leaking their body (%j)', async payload => {
    const fetcher = vi.fn<GovernmentInfoFetch>(async () => new Response(payload));
    const gate = new RequestGate({ timeoutMs: 1000, maxAttempts: 3, retryDelayMs: 1, minimumIntervalMs: 0 });
    await expect(gate.execute(signal => requestApprovalExportPath(fetcher, credentials, '2026-10-01', '2026-11-03', signal)))
      .rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED', details: {
        reason: payload.trim() ? 'INVALID_EXPORT_RESPONSE' : 'EMPTY_EXPORT_RESPONSE', retryable: false, status: 200,
      } });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
