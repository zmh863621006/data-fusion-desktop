import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { OneWindowUploader } from './uploader';

const taskId = '1096d1f4-93e5-4e48-acad-121c49c1adcb';
const uploadId = '2096d1f4-93e5-4e48-acad-121c49c1adcb';
const matterId = 'outdoor-advertising-approval';
const systemId = 'shenzhen-one-window';
const origin = 'https://backend.example.invalid';
const objectUrl = `https://fixture-private.oss-cn-shenzhen.aliyuncs.com/data-fusion/business/shenzhen-one-window/${'1'.repeat(32)}/${'2'.repeat(32)}/${'3'.repeat(32)}/${matterId}/${uploadId}.xlsx`;
const signedUrl = objectUrl + '?x-oss-signature-version=OSS4-HMAC-SHA256&x-oss-additional-headers=content-length&x-oss-signature=' + 'a'.repeat(64);
const proof = { algorithm: 'RSA-SHA256' as const, payload: 'isolated-test-proof', signature: 'isolated-test-signature' };

async function fixture() {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('办件信息').addRow(['仅供上传测试的虚构业务']);
  const file = { taskId, matterId, fileName: '一窗受理-广告审批-测试.xlsx', bytes: Buffer.from(await book.xlsx.writeBuffer()) };
  const sha256 = createHash('sha256').update(file.bytes).digest('hex'), md5 = createHash('md5').update(file.bytes).digest('base64');
  const receipt = { uploadId, taskId, systemId, matterId, state: 'prepared', fileName: file.fileName, bytes: file.bytes.length, sha256 };
  const prepared = { ...receipt, upload: { url: signedUrl, method: 'PUT', expiresAt: Date.now() + 600_000,
    headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-length': String(file.bytes.length),
      'content-md5': md5, 'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true', 'x-oss-meta-sha256': sha256, 'x-oss-meta-upload-id': uploadId } } };
  const authorization = vi.fn(async () => ({ proof, deviceId: 'isolated-test-device' }));
  const calls: { url: string; options: RequestInit }[] = [];
  let preparedReply: unknown = prepared, putStatus = 200;
  const fetcher = vi.fn(async (value: URL | RequestInfo, options: RequestInit = {}) => {
    const url = String(value);
    calls.push({ url, options });
    expect(options.redirect).toBe('error');
    if (url === origin + '/api/one-window/uploads/prepare') return Response.json(preparedReply);
    if (url.startsWith(objectUrl)) {
      expect(options.method).toBe('PUT');
      expect(options.body).toEqual(file.bytes);
      expect(options.headers).toEqual(prepared.upload.headers);
      return new Response(null, { status: putStatus });
    }
    if (url === origin + '/api/one-window/uploads/complete') return Response.json({ ...receipt, state: 'uploaded', uploadedAt: Date.now() });
    if (url === origin + '/api/one-window/uploads/download') return Response.json({ ...receipt, state: 'uploaded', uploadedAt: Date.now(), download: { url: signedUrl, expiresAt: Date.now() + 600_000 } });
    throw new Error('Unexpected request carrying a secret URL');
  });
  const uploader = new OneWindowUploader(origin, authorization, fetcher as typeof fetch);
  return { file, prepared, receipt, uploader, authorization, calls, fetcher,
    reply: (value: unknown) => { preparedReply = value; }, put: (status: number) => { putStatus = status; } };
}

describe('one-window direct Excel uploads', () => {
  it('sends bytes directly to private OSS and confirms the same immutable batch with the signed backend proof', async () => {
    const f = await fixture();
    const result = await f.uploader.upload(f.file);
    expect(result).toMatchObject({ uploadId, taskId, matterId, state: 'uploaded', bytes: f.file.bytes.length });
    expect(JSON.stringify(result)).not.toContain('x-oss-signature');
    expect(f.calls).toHaveLength(3);
    const prepare = JSON.parse(String(f.calls[0].options.body));
    expect(prepare).toMatchObject({ proof, taskId, systemId, matterId, bytes: f.file.bytes.length });
    expect(prepare.bytes).toBeTypeOf('number');
    const complete = JSON.parse(String(f.calls[2].options.body));
    expect(complete).toMatchObject({ proof, uploadId });
    expect(await f.uploader.download(uploadId)).toMatchObject({ url: signedUrl });
  });

  it('reconciles a lost completion response without overwriting the uploaded object', async () => {
    const f = await fixture();
    f.put(409);
    expect(await f.uploader.upload(f.file)).toMatchObject({ state: 'uploaded', uploadId });
    f.calls.length = 0;
    f.reply({ ...f.receipt, state: 'uploaded', uploadedAt: Date.now() });
    expect(await f.uploader.upload(f.file)).toMatchObject({ state: 'uploaded' });
    expect(f.calls).toHaveLength(1);
  });

  it('refuses mismatched signed addresses, public ACL and changed content metadata before any OSS call', async () => {
    const cases = [
      (value: Awaited<ReturnType<typeof fixture>>['prepared']) => { value.upload.url = value.upload.url.replace('fixture-private.oss-cn-shenzhen.aliyuncs.com', 'attacker.invalid'); },
      (value: Awaited<ReturnType<typeof fixture>>['prepared']) => { value.upload.headers['x-oss-object-acl'] = 'public-read'; },
      (value: Awaited<ReturnType<typeof fixture>>['prepared']) => { value.upload.headers['content-md5'] = 'changed'; },
      (value: Awaited<ReturnType<typeof fixture>>['prepared']) => { value.upload.url = value.upload.url.replace(uploadId, taskId); },
    ];
    for (const change of cases) {
      const f = await fixture(), value = structuredClone(f.prepared);
      change(value); f.reply(value);
      await expect(f.uploader.upload(f.file)).rejects.toThrow(/后台推送地址|后台推送授权/);
      expect(f.calls).toHaveLength(1);
    }
  });

  it('preserves a local batch on missing authorization, cancellation and transient network failures', async () => {
    const f = await fixture();
    const noLicense = new OneWindowUploader(origin, async () => null, f.fetcher as typeof fetch);
    await expect(noLicense.upload(f.file)).rejects.toThrow('有效设备授权');
    expect(f.calls).toHaveLength(0);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(f.uploader.upload(f.file, cancelled.signal)).rejects.toThrow('推送后台已取消');
    expect(f.calls).toHaveLength(0);
    const disconnected = new OneWindowUploader(origin, f.authorization, vi.fn(async () => { throw new Error(signedUrl); }) as typeof fetch);
    await expect(disconnected.upload(f.file)).rejects.toThrow('连接失败');
    await disconnected.upload(f.file).catch(error => expect(error.message).not.toContain('x-oss-signature'));
    expect(f.file.bytes.readUInt32LE(0)).toBe(0x04034b50);
  });

  it('rejects unrelated matters and malformed file metadata before requesting upload authorization', async () => {
    const f = await fixture();
    await expect(f.uploader.upload({ ...f.file, matterId: 'another-system' })).rejects.toThrow('文件无效');
    await expect(f.uploader.upload({ ...f.file, fileName: '../unsafe.xlsx' })).rejects.toThrow('文件无效');
    await expect(f.uploader.upload({ ...f.file, bytes: Buffer.alloc(150) })).rejects.toThrow('文件无效');
    expect(f.calls).toHaveLength(0);
  });
});
