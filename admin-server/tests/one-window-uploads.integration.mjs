import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { createOneWindowOssStorage, createOneWindowUploads, inspectOneWindowWorkbook, ONE_WINDOW_SYSTEM_ID } from '../one-window-uploads.mjs';

const config = { endpoint: 'oss-cn-shenzhen.aliyuncs.com', bucket: 'fixture-private-bucket', prefix: 'data-fusion/updates/',
  accessKeyId: 'fixture-access', accessKeySecret: 'fixture-secret' };
const owner = { customerId: 'fixture-customer', licenseId: 'fixture-license', deviceId: 'fixture-device' };
const matterId = 'outdoor-advertising-approval';
const now = Date.parse('2026-11-24T08:00:00Z');
const md5 = bytes => createHash('md5').update(bytes).digest('base64');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function workbook() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('办件信息');
  sheet.addRow(['流水号', '申请主体', '业务事项']);
  sheet.addRow(['SYNTHETIC-1', '虚构测试单位', '设置大型户外广告审批']);
  const detail = book.addWorksheet('业务详情');
  detail.addRow(['SYNTHETIC-1', '形式、材质及规格', '仅用于校验工作簿结构']);
  return Buffer.from(await book.xlsx.writeBuffer());
}

function fixture(t, options = {}) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const objects = new Map(), requests = [];
  let currentOwner = { ...owner }, allowed = true, verifyHook;
  const storage = createOneWindowOssStorage(config, { now: () => now, fetcher: async (url, request) => {
    assert.equal(request.redirect, 'error');
    assert(request.headers.authorization.startsWith('OSS4-HMAC-SHA256 Credential='));
    const key = decodeURIComponent(new URL(url).pathname).slice(1), object = objects.get(key);
    requests.push({ key, method: request.method });
    assert(key.startsWith('data-fusion/business/shenzhen-one-window/'));
    if (verifyHook) await verifyHook(request.method);
    if (!object) return new Response(null, { status: 404 });
    const headers = { 'content-length': String(object.bytes.length), 'content-type': object.headers['content-type'],
      'x-oss-meta-sha256': object.headers['x-oss-meta-sha256'], 'x-oss-meta-upload-id': object.headers['x-oss-meta-upload-id'],
      etag: '"' + createHash('md5').update(object.bytes).digest('hex') + '"' };
    if (request.method === 'HEAD') return new Response(null, { headers });
    assert.equal(request.method, 'GET');
    return new Response(object.bytes, { headers });
  } });
  const manager = createOneWindowUploads({ database, storage, now: () => now, authorize: async (_body, details) => {
    assert.deepEqual(details, { systemId: ONE_WINDOW_SYSTEM_ID, matterId, requireExport: true });
    if (!allowed) throw Object.assign(new Error('fixture revoked'), { status: 403 });
    return currentOwner;
  }, ...options });
  function directPut(upload, bytes) {
    const url = new URL(upload.url), query = new URLSearchParams(url.search);
    const signature = query.get('x-oss-signature');
    query.delete('x-oss-signature');
    assert.equal(url.origin, `https://${config.bucket}.${config.endpoint}`);
    assert.equal(upload.method, 'PUT');
    assert.equal(upload.headers['x-oss-object-acl'], 'private');
    assert.equal(upload.headers['x-oss-forbid-overwrite'], 'true');
    assert.equal(upload.headers['content-length'], String(bytes.length));
    assert.equal(upload.headers['content-md5'], md5(bytes));
    assert.equal(query.get('x-oss-additional-headers'), 'content-length');
    assert.equal(query.get('x-oss-expires'), '600');
    const time = query.get('x-oss-date'), scope = `${time.slice(0, 8)}/cn-shenzhen/oss/aliyun_v4_request`;
    const sortedQuery = [...query].map(([key, value]) => [encode(key), encode(value)]).sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
      .map(([key, value]) => value ? `${key}=${value}` : key).join('&');
    const headerNames = Object.keys(upload.headers).sort();
    const canonical = ['PUT', `/${config.bucket}${url.pathname}`, sortedQuery,
      headerNames.map(name => `${name}:${upload.headers[name]}\n`).join(''), 'content-length', 'UNSIGNED-PAYLOAD'].join('\n');
    let key = Buffer.from('aliyun_v4' + config.accessKeySecret);
    for (const component of [time.slice(0, 8), 'cn-shenzhen', 'oss', 'aliyun_v4_request']) key = createHmac('sha256', key).update(component).digest();
    assert.equal(signature, createHmac('sha256', key).update(`OSS4-HMAC-SHA256\n${time}\n${scope}\n${sha256(canonical)}`).digest('hex'));
    const objectKey = decodeURIComponent(url.pathname).slice(1);
    if (objects.has(objectKey)) return 409;
    objects.set(objectKey, { bytes: Buffer.from(bytes), headers: { ...upload.headers } });
    return 200;
  }
  const request = bytes => ({ systemId: ONE_WINDOW_SYSTEM_ID, matterId, taskId: randomUUID(), fileName: '一窗受理-广告审批-测试批次.xlsx', bytes: bytes.length, sha256: sha256(bytes), md5: md5(bytes) });
  return { database, manager, objects, requests, request, directPut,
    setOwner: value => { currentOwner = value; }, revoke: () => { allowed = false; }, hook: value => { verifyHook = value; } };
}

test('one-window Excel uses an immutable private direct upload and idempotent verified completion', async t => {
  const f = fixture(t), bytes = await workbook(), request = f.request(bytes);
  assert(inspectOneWindowWorkbook(bytes).files > 4);
  const prepared = await f.manager.handle('/prepare', request);
  assert.equal(prepared.state, 'prepared');
  assert(!JSON.stringify(prepared).includes(config.accessKeySecret));
  assert.equal(f.directPut(prepared.upload, bytes), 200);
  const retried = await f.manager.handle('/prepare', request);
  assert.equal(retried.uploadId, prepared.uploadId);
  assert.equal(f.directPut(retried.upload, bytes), 409);
  const completed = await f.manager.handle('/complete', { uploadId: prepared.uploadId });
  assert.equal(completed.state, 'uploaded');
  assert.equal(completed.uploadedAt, now);
  assert.equal(completed.sha256, request.sha256);
  assert.deepEqual(await f.manager.handle('/complete', { uploadId: prepared.uploadId }), completed);
  assert.equal(f.requests.filter(request => request.method === 'GET').length, 1);
  const existing = await f.manager.handle('/prepare', request);
  assert.deepEqual(existing, completed);
  const downloadable = await f.manager.handle('/download', { uploadId: prepared.uploadId });
  assert.equal(new URL(downloadable.download.url).searchParams.get('x-oss-expires'), '600');
  assert(!downloadable.download.url.includes('fixture-secret'));
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM one_window_uploads').get().count, 1);
});

test('one-window upload identity cannot cross devices, change bytes, expand matters, or supply an object key', async t => {
  const f = fixture(t), bytes = await workbook(), request = f.request(bytes);
  const prepared = await f.manager.handle('/prepare', { ...request, objectKey: 'public/attacker.xlsx', url: 'https://example.invalid' });
  assert(!prepared.upload.url.includes('attacker'));
  await assert.rejects(f.manager.handle('/prepare', { ...request, sha256: 'f'.repeat(64) }), { status: 409 });
  await assert.rejects(f.manager.handle('/prepare', { ...request, matterId: 'unrelated-matter' }), { status: 400 });
  await assert.rejects(f.manager.handle('/prepare', { ...request, fileName: '../test.xlsx' }), { status: 400 });
  f.setOwner({ ...owner, deviceId: 'different-device' });
  await assert.rejects(f.manager.handle('/complete', { uploadId: prepared.uploadId }), { status: 404 });
  await assert.rejects(f.manager.handle('/download', { uploadId: prepared.uploadId }), { status: 404 });
  f.revoke();
  await assert.rejects(f.manager.handle('/prepare', { ...request, taskId: randomUUID() }), { status: 403 });
});

test('a valid ZIP with non-Excel content cannot become a completed upload and missing uploads remain retryable', async t => {
  const f = fixture(t), bytes = await workbook(), prepared = await f.manager.handle('/prepare', f.request(bytes));
  await assert.rejects(f.manager.handle('/complete', { uploadId: prepared.uploadId }), { status: 409 });
  assert.equal(f.database.prepare('SELECT state FROM one_window_uploads').get().state, 'prepared');
  const unrelated = new JSZip();
  unrelated.file('payload.txt', 'This archive has no workbook.');
  const changed = await unrelated.generateAsync({ type: 'nodebuffer' });
  const tampered = await f.manager.handle('/prepare', f.request(changed));
  f.directPut(tampered.upload, changed);
  await assert.rejects(f.manager.handle('/complete', { uploadId: tampered.uploadId }), { status: 415 });
  assert.equal(f.database.prepare('SELECT state FROM one_window_uploads WHERE id=?').get(tampered.uploadId).state, 'prepared');
});

test('completion rechecks authorization after the OSS verification finishes', async t => {
  const f = fixture(t), bytes = await workbook(), prepared = await f.manager.handle('/prepare', f.request(bytes));
  f.directPut(prepared.upload, bytes);
  f.hook(method => { if (method === 'GET') f.revoke(); });
  await assert.rejects(f.manager.handle('/complete', { uploadId: prepared.uploadId }), { status: 403 });
  assert.equal(f.database.prepare('SELECT state FROM one_window_uploads').get().state, 'prepared');
});

test('the OSS digest is verified from actual bytes even if metadata or a workbook filename is misleading', async t => {
  const f = fixture(t), bytes = await workbook(), prepared = await f.manager.handle('/prepare', f.request(bytes));
  f.directPut(prepared.upload, bytes);
  const object = [...f.objects.values()][0];
  object.headers['x-oss-meta-sha256'] = '0'.repeat(64);
  await assert.rejects(f.manager.handle('/complete', { uploadId: prepared.uploadId }), { status: 409 });
  const unavailable = createOneWindowUploads({ database: f.database, authorize: async () => owner });
  await assert.rejects(unavailable.handle('/prepare', f.request(bytes)), { status: 503 });
});
