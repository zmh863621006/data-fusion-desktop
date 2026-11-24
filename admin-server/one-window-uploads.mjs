import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { updateOssSignature } from './update-oss.mjs';

export const ONE_WINDOW_SYSTEM_ID = 'shenzhen-one-window';
export const ONE_WINDOW_MATTERS = ['outdoor-advertising-approval', 'storefront-signboard-filing'];
export const ONE_WINDOW_MAX_BYTES = 100 * 1024 * 1024;
const DATA_PREFIX = 'data-fusion/business/shenzhen-one-window/';
const WORKBOOK_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
const encodedPath = value => value.split('/').map(encode).join('/');
const timestamp = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

function uploadSignature({ config, region, time, key, query, headers }) {
  const canonicalHeaders = Object.entries(headers).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${String(value).trim()}\n`).join('');
  const canonicalQuery = [...query].map(([name, value]) => [encode(name), encode(value)])
    .sort(([left, leftValue], [right, rightValue]) => left < right ? -1 : left > right ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)
    .map(([name, value]) => value ? `${name}=${value}` : name).join('&');
  const canonical = `PUT\n/${config.bucket}/${encodedPath(key)}\n${canonicalQuery}\n${canonicalHeaders}\ncontent-length\nUNSIGNED-PAYLOAD`;
  const scope = `${time.slice(0, 8)}/${region}/oss/aliyun_v4_request`;
  const signingKey = hmac(hmac(hmac(hmac('aliyun_v4' + config.accessKeySecret, time.slice(0, 8)), region), 'oss'), 'aliyun_v4_request');
  return hmac(signingKey, `OSS4-HMAC-SHA256\n${time}\n${scope}\n${digest(canonical)}`).toString('hex');
}

/** Validate actual uploaded bytes, including every ZIP entry, before marking a batch complete. */
export function inspectOneWindowWorkbook(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 100 || bytes.length > ONE_WINDOW_MAX_BYTES || bytes.readUInt32LE(0) !== 0x04034b50) fail('上传文件不是有效的 Excel 工作簿', 415);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail('Excel 压缩目录无效', 415);
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (!count || count > 20_000 || count !== bytes.readUInt16LE(end + 8) || start + size !== end) fail('Excel 压缩目录无效', 415);
  const names = new Set(), xml = new Map();
  let offset = start, expanded = 0, previousEnd = 0;
  const ranges = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) fail('Excel 压缩条目无效', 415);
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const packed = bytes.readUInt32LE(offset + 20), unpacked = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42), nameBytes = bytes.subarray(offset + 46, offset + 46 + nameSize), name = nameBytes.toString('utf8');
    if (offset + 46 + nameSize + extra + comment > end || !name || !Buffer.from(name).equals(nameBytes)
      || names.has(name) || /[\\\x00-\x1f]/.test(name) || name.startsWith('/') || name.split('/').includes('..')
      || flags & 1 || ![0, 8].includes(method) || ((bytes.readUInt32LE(offset + 38) >>> 16) & 0xf000) === 0xa000
      || /vbaProject|\.bin$|^xl\/(?:activeX|embeddings)\//i.test(name)) fail('Excel 压缩条目无效', 415);
    names.add(name);
    expanded += unpacked;
    if (expanded > 512 * 1024 * 1024 || unpacked > 256 * 1024 * 1024 || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) fail('Excel 解压大小或条目位置无效', 415);
    const localNameSize = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), contentStart = local + 30 + localNameSize + localExtra;
    if (bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method
      || !bytes.subarray(local + 30, local + 30 + localNameSize).equals(nameBytes) || contentStart + packed > start) fail('Excel 压缩条目不一致', 415);
    ranges.push([local, contentStart + packed]);
    if (['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml'].includes(name)) {
      if (unpacked > 2 * 1024 * 1024) fail('Excel 工作簿结构超过限制', 415);
      let content;
      try { content = method === 8 ? inflateRawSync(bytes.subarray(contentStart, contentStart + packed), { maxOutputLength: 2 * 1024 * 1024 }) : bytes.subarray(contentStart, contentStart + packed); }
      catch { fail('Excel 工作簿结构损坏', 415); }
      if (content.length !== unpacked || /<!DOCTYPE|<!ENTITY/i.test(content.toString('utf8'))) fail('Excel 工作簿结构无效', 415);
      xml.set(name, content.toString('utf8'));
    }
    offset += 46 + nameSize + extra + comment;
  }
  for (const [begin, finish] of ranges.sort(([left], [right]) => left - right)) {
    if (begin < previousEnd) fail('Excel 压缩条目重叠', 415);
    previousEnd = finish;
  }
  if (offset !== end || !xml.get('[Content_Types].xml')?.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')
    || !/<(?:\w+:)?workbook[\s>]/.test(xml.get('xl/workbook.xml') ?? '') || !xml.get('_rels/.rels')?.includes('officeDocument')
    || ![...names].some(name => /^xl\/worksheets\/[^/]+\.xml$/.test(name))) fail('Excel 工作簿缺少必要结构', 415);
  return { bytes: bytes.length, files: names.size };
}

export function createOneWindowOssStorage(config, { fetcher = fetch, now = Date.now } = {}) {
  const endpoint = String(config.endpoint ?? '').replace(/^https:\/\//, '').replace(/\/$/, '');
  if (!/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(endpoint) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket ?? '')
    || typeof config.accessKeyId !== 'string' || !config.accessKeyId || typeof config.accessKeySecret !== 'string' || !config.accessKeySecret) throw Error('一窗回流 OSS 配置无效');
  const region = endpoint.slice(4, -'.aliyuncs.com'.length).replace(/-internal$/, '');
  const publicEndpoint = endpoint.replace('-internal.', '.'), base = `https://${config.bucket}.${publicEndpoint}/`;
  const checkedKey = key => {
    if (typeof key !== 'string' || !new RegExp(`^${DATA_PREFIX}[a-f0-9]{32}/[a-f0-9]{32}/[a-f0-9]{32}/(?:${ONE_WINDOW_MATTERS.join('|')})/[a-f0-9-]{36}\.xlsx$`).test(key)) throw Error('一窗回流 OSS 对象路径无效');
    return key;
  };
  function queryFor(method, key, expires = 600, headers = {}) {
    checkedKey(key);
    const time = timestamp(now()), query = new URLSearchParams({ 'x-oss-signature-version': 'OSS4-HMAC-SHA256',
      'x-oss-credential': `${config.accessKeyId}/${time.slice(0, 8)}/${region}/oss/aliyun_v4_request`, 'x-oss-date': time, 'x-oss-expires': String(expires) });
    if (config.securityToken) query.set('x-oss-security-token', config.securityToken);
    if (method === 'PUT') query.set('x-oss-additional-headers', 'content-length');
    const signature = method === 'PUT' ? uploadSignature({ config, region, time, key, query, headers })
      : updateOssSignature({ secret: config.accessKeySecret, region, timestamp: time, method, resource: `/${config.bucket}/${encodedPath(key)}`, query: query.toString() });
    query.set('x-oss-signature', signature);
    return base + encodedPath(key) + '?' + query;
  }
  async function request(method, key) {
    checkedKey(key);
    const time = timestamp(now()), headers = { 'x-oss-date': time, 'x-oss-content-sha256': 'UNSIGNED-PAYLOAD' };
    if (config.securityToken) headers['x-oss-security-token'] = config.securityToken;
    headers.authorization = `OSS4-HMAC-SHA256 Credential=${config.accessKeyId}/${time.slice(0, 8)}/${region}/oss/aliyun_v4_request,Signature=${updateOssSignature({ secret: config.accessKeySecret, region, timestamp: time, method, resource: `/${config.bucket}/${encodedPath(key)}`, headers })}`;
    try { return await fetcher(base + encodedPath(key), { method, headers, redirect: 'error', signal: AbortSignal.timeout(60_000) }); }
    catch { fail('一窗回流 OSS 连接失败，请稍后重试', 503); }
  }
  return {
    prepare(entry) {
      const headers = { 'content-type': WORKBOOK_TYPE, 'content-length': String(entry.bytes), 'content-md5': entry.md5,
        'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true', 'x-oss-meta-sha256': entry.sha256, 'x-oss-meta-upload-id': entry.id };
      return { url: queryFor('PUT', entry.object_key, 600, headers), method: 'PUT', headers, expiresAt: now() + 600_000 };
    },
    async verify(entry) {
      const head = await request('HEAD', entry.object_key);
      const etag = head.headers.get('etag')?.replaceAll('"', '').toLowerCase();
      if (head.status === 404) fail('Excel 尚未上传完成，请重新上传', 409);
      if (head.status !== 200) fail('Excel 上传结果暂时无法验证，请稍后重试', 503);
      if (Number(head.headers.get('content-length')) !== entry.bytes || head.headers.get('x-oss-meta-sha256') !== entry.sha256
        || head.headers.get('x-oss-meta-upload-id') !== entry.id || etag !== Buffer.from(entry.md5, 'base64').toString('hex')
        || head.headers.get('content-type')?.split(';')[0] !== WORKBOOK_TYPE) fail('Excel 上传结果与本批次文件不一致', 409);
      const response = await request('GET', entry.object_key);
      if (response.status !== 200 || Number(response.headers.get('content-length')) !== entry.bytes) fail('Excel 校验下载失败，请稍后重试', 503);
      let received = 0;
      const sha256 = createHash('sha256'), md5 = createHash('md5'), chunks = [];
      try {
        for await (const chunk of response.body ?? []) {
          received += chunk.length;
          if (received > entry.bytes || received > ONE_WINDOW_MAX_BYTES) fail('Excel 上传文件大小不一致', 409);
          sha256.update(chunk); md5.update(chunk); chunks.push(Buffer.from(chunk));
        }
      } catch (error) {
        if (error?.status) throw error;
        fail('Excel 校验下载中断，请稍后重试', 503);
      }
      if (received !== entry.bytes || sha256.digest('hex') !== entry.sha256 || md5.digest('base64') !== entry.md5) fail('Excel 上传文件摘要不一致', 409);
      inspectOneWindowWorkbook(Buffer.concat(chunks));
    },
    download(entry) { return { url: queryFor('GET', entry.object_key), expiresAt: now() + 600_000 }; },
  };
}

export function oneWindowOssStorageFromDirectory(directory, options) {
  if (!directory) return null;
  const path = ['one-window-oss.secure.json', 'update-oss.secure.json'].map(name => join(directory, name)).find(existsSync);
  if (!path) return null;
  let configuration;
  try { configuration = JSON.parse(readFileSync(path, 'utf8')); } catch { throw Error('一窗回流 OSS 配置文件无法读取'); }
  return createOneWindowOssStorage(configuration, options);
}

function checkedMetadata(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.systemId !== ONE_WINDOW_SYSTEM_ID || !ONE_WINDOW_MATTERS.includes(body.matterId)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.taskId ?? '')
    || typeof body.fileName !== 'string' || !body.fileName.endsWith('.xlsx') || body.fileName !== body.fileName.normalize('NFC')
    || /[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e]/.test(body.fileName) || Buffer.byteLength(body.fileName, 'utf8') > 240
    || !Number.isSafeInteger(body.bytes) || body.bytes < 100 || body.bytes > ONE_WINDOW_MAX_BYTES
    || typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha256) || typeof body.md5 !== 'string'
    || !/^[A-Za-z0-9+/]{22}==$/.test(body.md5) || Buffer.from(body.md5, 'base64').toString('base64') !== body.md5) fail('一窗回流文件信息无效');
  return { taskId: body.taskId, matterId: body.matterId, fileName: body.fileName, bytes: body.bytes, sha256: body.sha256, md5: body.md5 };
}

/** Authorization is supplied by the existing signed-license/device boundary in app.mjs. */
export function createOneWindowUploads({ database, storage, configDirectory, authorize, now = Date.now } = {}) {
  if (!database || typeof authorize !== 'function') throw Error('一窗回流上传服务缺少数据库或授权校验');
  const oss = storage ?? oneWindowOssStorageFromDirectory(configDirectory);
  const verifications = new Map();
  database.exec(`CREATE TABLE IF NOT EXISTS one_window_uploads(
    id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,license_id TEXT NOT NULL,device_id TEXT NOT NULL,
    task_id TEXT NOT NULL,matter_id TEXT NOT NULL,file_name TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,
    md5 TEXT NOT NULL,object_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'prepared',created_at INTEGER NOT NULL,uploaded_at INTEGER,
    UNIQUE(license_id,device_id,task_id));
    CREATE INDEX IF NOT EXISTS one_window_upload_owner ON one_window_uploads(license_id,device_id,created_at DESC);`);
  function describe(row) {
    return { uploadId: row.id, taskId: row.task_id, systemId: ONE_WINDOW_SYSTEM_ID, matterId: row.matter_id, state: row.state,
      fileName: row.file_name, bytes: row.bytes, sha256: row.sha256, ...(row.uploaded_at ? { uploadedAt: row.uploaded_at } : {}) };
  }
  async function owner(body, matterId) {
    const value = await authorize(body, { systemId: ONE_WINDOW_SYSTEM_ID, matterId, requireExport: true });
    if (!value || ['customerId', 'licenseId', 'deviceId'].some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 200)) fail('一窗回流上传需要有效设备授权', 403);
    return value;
  }
  async function authorizedRow(body) {
    if (!body || !/^[a-f0-9-]{36}$/.test(body.uploadId ?? '')) fail('一窗回流上传编号无效');
    const row = database.prepare('SELECT * FROM one_window_uploads WHERE id=?').get(body.uploadId);
    if (!row) fail('一窗回流上传批次不存在', 404);
    const authorization = await owner(body, row.matter_id);
    if (row.customer_id !== authorization.customerId || row.license_id !== authorization.licenseId || row.device_id !== authorization.deviceId) fail('一窗回流上传批次不存在', 404);
    return row;
  }
  return {
    configured: Boolean(oss),
    async handle(path, body) {
      const action = path.replace(/^\/api\/one-window\/uploads/, '');
      if (!['/prepare', '/complete', '/download'].includes(action)) fail('一窗回流上传接口不存在', 404);
      if (!oss) fail('后台尚未配置一窗回流 OSS 上传', 503);
      if (action === '/prepare') {
        const metadata = checkedMetadata(body), authorization = await owner(body, metadata.matterId);
        let row = database.prepare('SELECT * FROM one_window_uploads WHERE license_id=? AND device_id=? AND task_id=?')
          .get(authorization.licenseId, authorization.deviceId, metadata.taskId);
        if (!row) {
          const id = randomUUID(), objectKey = DATA_PREFIX + [authorization.customerId, authorization.licenseId, authorization.deviceId]
            .map(value => digest(value).slice(0, 32)).join('/') + `/${metadata.matterId}/${id}.xlsx`;
          database.prepare(`INSERT OR IGNORE INTO one_window_uploads(id,customer_id,license_id,device_id,task_id,matter_id,file_name,bytes,sha256,md5,object_key,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, authorization.customerId, authorization.licenseId, authorization.deviceId,
            metadata.taskId, metadata.matterId, metadata.fileName, metadata.bytes, metadata.sha256, metadata.md5, objectKey, now());
          row = database.prepare('SELECT * FROM one_window_uploads WHERE license_id=? AND device_id=? AND task_id=?')
            .get(authorization.licenseId, authorization.deviceId, metadata.taskId);
        }
        if (row.customer_id !== authorization.customerId || row.matter_id !== metadata.matterId || row.file_name !== metadata.fileName
          || row.bytes !== metadata.bytes || row.sha256 !== metadata.sha256 || row.md5 !== metadata.md5) fail('这个回流批次已绑定其他文件，请保留原文件重试', 409);
        return { ...describe(row), ...(row.state === 'prepared' ? { upload: oss.prepare(row) } : {}) };
      }
      const row = await authorizedRow(body);
      if (action === '/download') {
        if (row.state !== 'uploaded') fail('这个批次的 Excel 尚未完成上传', 409);
        return { ...describe(row), download: oss.download(row) };
      }
      if (row.state !== 'uploaded') {
        if (!verifications.has(row.id)) {
          if (verifications.size >= 2) fail('Excel 上传结果校验繁忙，请稍后重试', 503);
          const pending = Promise.resolve().then(() => oss.verify(row)).finally(() => verifications.delete(row.id));
          verifications.set(row.id, pending);
        }
        await verifications.get(row.id);
        await authorizedRow(body);
        database.prepare("UPDATE one_window_uploads SET state='uploaded',uploaded_at=? WHERE id=? AND state='prepared'").run(now(), row.id);
      }
      return describe(database.prepare('SELECT * FROM one_window_uploads WHERE id=?').get(row.id));
    },
  };
}
