import { createHash } from 'node:crypto';
import type { SignedLicenseEnvelope } from '../license/signed-license';

const SYSTEM_ID = 'shenzhen-one-window';
const MATTERS = ['outdoor-advertising-approval', 'storefront-signboard-filing'];
const MAX_BYTES = 100 * 1024 * 1024;
const WORKBOOK_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export interface OneWindowUploadReceipt {
  uploadId: string;
  taskId: string;
  systemId: string;
  matterId: string;
  state: 'prepared' | 'uploaded';
  fileName: string;
  bytes: number;
  sha256: string;
  uploadedAt?: number;
}

export interface OneWindowUploadFile {
  taskId: string;
  matterId: string;
  fileName: string;
  bytes: Buffer;
}

type Authorization = { proof: SignedLicenseEnvelope; deviceId: string };
interface PreparedUpload extends OneWindowUploadReceipt {
  upload?: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: number };
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('推送后台已取消，本地文件已保留');
}

async function timed<T>(milliseconds: number, parent: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  cancelled(parent);
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, milliseconds);
  try { return await operation(controller.signal); }
  finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > 64 * 1024) throw new Error('后台推送服务返回格式无效');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('后台推送服务返回格式无效');
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 64 * 1024) throw new Error('后台推送服务返回格式无效');
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('后台推送服务返回格式无效');
  } finally { await reader.cancel().catch(() => {}); }
}

function checkReceipt(value: unknown, file?: OneWindowUploadFile, sha256?: string): OneWindowUploadReceipt {
  if (!value || typeof value !== 'object') throw new Error('后台返回批次信息无效');
  const row = value as OneWindowUploadReceipt;
  if (!ID.test(row.uploadId) || !ID.test(row.taskId) || row.systemId !== SYSTEM_ID || !MATTERS.includes(row.matterId)
    || !['prepared', 'uploaded'].includes(row.state) || typeof row.fileName !== 'string' || !row.fileName.endsWith('.xlsx')
    || !Number.isSafeInteger(row.bytes) || row.bytes < 100 || row.bytes > MAX_BYTES || !/^[a-f0-9]{64}$/.test(row.sha256)
    || (row.state === 'uploaded' && (!Number.isSafeInteger(row.uploadedAt) || row.uploadedAt! < 1))
    || (file && (row.taskId !== file.taskId || row.matterId !== file.matterId || row.fileName !== file.fileName || row.bytes !== file.bytes.length || row.sha256 !== sha256))) {
    throw new Error('后台返回批次信息不一致');
  }
  return { uploadId: row.uploadId, taskId: row.taskId, systemId: row.systemId, matterId: row.matterId, state: row.state,
    fileName: row.fileName, bytes: row.bytes, sha256: row.sha256, ...(row.uploadedAt ? { uploadedAt: row.uploadedAt } : {}) };
}

function checkedOssUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('后台推送地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !/^[a-z0-9][a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname)
    || !/^\/data-fusion\/business\/shenzhen-one-window\/[a-f0-9]{32}\/[a-f0-9]{32}\/[a-f0-9]{32}\/(?:outdoor-advertising-approval|storefront-signboard-filing)\/[a-f0-9-]{36}\.xlsx$/.test(url.pathname)
    || url.searchParams.get('x-oss-signature-version') !== 'OSS4-HMAC-SHA256'
    || !/^[a-f0-9]{64}$/.test(url.searchParams.get('x-oss-signature') ?? '')) throw new Error('后台推送地址无效');
  return url;
}

/** Main-process only. The desktop receives bounded upload signatures, never an OSS secret. */
export class OneWindowUploader {
  private readonly base: URL;

  constructor(endpointBase: string, private readonly authorization: () => Promise<Authorization | null>,
    private readonly fetcher: typeof fetch = fetch, insecureHttpOrigin?: string) {
    const candidate = new URL(endpointBase);
    if (candidate.username || candidate.password || candidate.hash || candidate.search
      || (candidate.protocol !== 'https:' && !(candidate.protocol === 'http:'
        && (['127.0.0.1', 'localhost', '[::1]'].includes(candidate.hostname) || candidate.origin === insecureHttpOrigin)))) throw new Error('一窗回流后台服务地址无效');
    this.base = new URL('/api/one-window/uploads/', candidate.origin);
  }

  private async api(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    cancelled(signal);
    const authorization = await this.authorization();
    if (!authorization) throw new Error('推送后台需要有效设备授权，本地数据和 Excel 已保留');
    return timed(120_000, signal, async requestSignal => {
      let response: Response;
      try {
        response = await this.fetcher(new URL(action, this.base), { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, ...authorization }), redirect: 'error', signal: requestSignal });
      } catch {
        cancelled(signal);
        throw new Error('后台推送服务连接失败，本地 Excel 已保留，可重新推送');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if ([401, 403].includes(response.status)) throw new Error('当前设备授权不允许推送此业务，请刷新授权后重试');
        if (response.status === 404 || response.status === 503) throw new Error('后台一窗回流接收服务暂不可用，本地 Excel 已保留');
        if (response.status === 409) throw new Error('这个批次的推送文件或状态有冲突，请保留原文件重试');
        if (response.status === 415) throw new Error('后台校验 Excel 失败，请检查本地导出文件');
        throw new Error(`一窗回流后台推送失败（HTTP ${response.status}），本地 Excel 已保留`);
      }
      return boundedJson(response);
    });
  }

  async upload(file: OneWindowUploadFile, signal?: AbortSignal): Promise<OneWindowUploadReceipt> {
    cancelled(signal);
    if (!ID.test(file.taskId) || !MATTERS.includes(file.matterId) || typeof file.fileName !== 'string' || !file.fileName.endsWith('.xlsx')
      || /[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e]/.test(file.fileName) || file.fileName !== file.fileName.normalize('NFC')
      || Buffer.byteLength(file.fileName, 'utf8') > 240 || !Buffer.isBuffer(file.bytes) || file.bytes.length < 100
      || file.bytes.length > MAX_BYTES || file.bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('一窗回流 Excel 文件无效');
    const sha256 = createHash('sha256').update(file.bytes).digest('hex'), md5 = createHash('md5').update(file.bytes).digest('base64');
    const prepared = await this.api('prepare', { systemId: SYSTEM_ID, matterId: file.matterId, taskId: file.taskId,
      fileName: file.fileName, bytes: file.bytes.length, sha256, md5 }, signal) as PreparedUpload;
    const receipt = checkReceipt(prepared, file, sha256);
    if (receipt.state === 'uploaded') return receipt;
    const upload = prepared.upload;
    if (!upload || upload.method !== 'PUT' || !Number.isSafeInteger(upload.expiresAt) || upload.expiresAt <= Date.now()
      || upload.expiresAt > Date.now() + 15 * 60_000) throw new Error('后台推送授权已失效，请重新推送');
    const url = checkedOssUrl(upload.url);
    if (!url.pathname.endsWith(`/${receipt.matterId}/${receipt.uploadId}.xlsx`)) throw new Error('后台推送地址与批次不一致');
    const requiredHeaders = { 'content-type': WORKBOOK_TYPE, 'content-length': String(file.bytes.length), 'content-md5': md5,
      'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true', 'x-oss-meta-sha256': sha256, 'x-oss-meta-upload-id': receipt.uploadId };
    if (!upload.headers || Object.keys(upload.headers).length !== Object.keys(requiredHeaders).length
      || Object.entries(requiredHeaders).some(([name, value]) => upload.headers[name] !== value)
      || url.searchParams.get('x-oss-additional-headers') !== 'content-length') throw new Error('后台推送授权与本地文件不一致');
    cancelled(signal);
    let response: Response;
    try {
      response = await timed(600_000, signal, async requestSignal => {
        const result = await this.fetcher(url, { method: 'PUT', headers: requiredHeaders, body: file.bytes as unknown as BodyInit,
          redirect: 'error', signal: requestSignal });
        await result.body?.cancel().catch(() => {});
        return result;
      });
    } catch {
      cancelled(signal);
      throw new Error('Excel 推送后台中断，本地文件已保留，可重新推送');
    }
    // An earlier attempt can have uploaded successfully before its completion response was lost.
    if (!response.ok && response.status !== 409) throw new Error(`Excel 推送后台失败（HTTP ${response.status}），本地文件已保留`);
    const completed = checkReceipt(await this.api('complete', { uploadId: receipt.uploadId }, signal), file, sha256);
    if (completed.uploadId !== receipt.uploadId || completed.state !== 'uploaded') throw new Error('后台接收结果尚未验证完成，可重新推送');
    return completed;
  }

  async download(uploadId: string, signal?: AbortSignal): Promise<{ url: string; expiresAt: number }> {
    if (!ID.test(uploadId)) throw new Error('后台批次编号无效');
    const result = await this.api('download', { uploadId }, signal) as OneWindowUploadReceipt & { download?: { url: string; expiresAt: number } };
    const receipt = checkReceipt(result);
    if (receipt.uploadId !== uploadId || receipt.state !== 'uploaded' || !result.download || result.download.expiresAt <= Date.now()
      || result.download.expiresAt > Date.now() + 15 * 60_000) throw new Error('Excel 下载授权无效');
    const url = checkedOssUrl(result.download.url);
    if (!url.pathname.endsWith(`/${receipt.matterId}/${uploadId}.xlsx`)) throw new Error('Excel 下载地址与批次不一致');
    return { url: url.href, expiresAt: result.download.expiresAt };
  }
}
