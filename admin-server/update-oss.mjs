import { createHash, createHmac } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { isInstallerName, releaseTarget } from './update-filenames.mjs';

const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
const objectPath = key => key.split('/').map(encode).join('/');
const stamp = time => new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
export function updateOssSignature({ secret, region, timestamp, method, resource, query = '', headers = {} }) {
  const canonicalHeaders = Object.entries(headers).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, value]) => `${name.toLowerCase()}:${String(value).trim()}\n`).join('');
  const canonicalQuery = [...new URLSearchParams(query)].map(([key, value]) => [encode(key), encode(value)])
    .sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => value ? `${key}=${value}` : key).join('&');
  const canonical = `${method}\n${resource}\n${canonicalQuery}\n${canonicalHeaders}\n\nUNSIGNED-PAYLOAD`;
  const scope = `${timestamp.slice(0, 8)}/${region}/oss/aliyun_v4_request`;
  const toSign = `OSS4-HMAC-SHA256\n${timestamp}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
  const key = hmac(hmac(hmac(hmac('aliyun_v4' + secret, timestamp.slice(0, 8)), region), 'oss'), 'aliyun_v4_request');
  return hmac(key, toSign).toString('hex');
}

/** Server-only credentials. Desktop clients receive a bounded, signed download URL. */
export function createOssUpdateStorage(config, { fetcher = fetch, now = Date.now } = {}) {
  const endpoint = String(config.endpoint ?? '').replace(/^https:\/\//, '').replace(/\/$/, '');
  if (!/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(endpoint) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket ?? '')
    || !/^[A-Za-z0-9_/-]+\/$/.test(config.prefix ?? '') || config.prefix.includes('..') || config.prefix.startsWith('/')
    || !config.accessKeyId || !config.accessKeySecret) throw new Error('OSS 更新配置无效');
  const bucket = config.bucket, region = endpoint.slice(4, -'.aliyuncs.com'.length).replace(/-internal$/, '');
  const base = `https://${bucket}.${endpoint}/`;
  const validKey = key => {
    if (typeof key !== 'string' || !key.startsWith(config.prefix)) return false;
    const parts = key.slice(config.prefix.length).split('/');
    if (parts.length === 2) return isInstallerName(parts[1], parts[0]);
    return parts.length === 4 && releaseTarget(parts[0], parts[1]) && isInstallerName(parts[3], parts[2], parts[0], parts[1]);
  };
  function signedHeaders(method, key, extra = {}) {
    const timestamp = stamp(now());
    const headers = { 'x-oss-date': timestamp, 'x-oss-content-sha256': 'UNSIGNED-PAYLOAD', ...extra };
    if (config.securityToken) headers['x-oss-security-token'] = config.securityToken;
    const included = Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('x-oss-') || ['content-md5', 'content-type'].includes(name)));
    const signature = updateOssSignature({ secret: config.accessKeySecret, region, timestamp, method, resource: `/${bucket}/${objectPath(key)}`, headers: included });
    headers.authorization = `OSS4-HMAC-SHA256 Credential=${config.accessKeyId}/${timestamp.slice(0, 8)}/${region}/oss/aliyun_v4_request,Signature=${signature}`;
    return headers;
  }
  async function request(method, key, extra = {}, body) {
    try {
      return await fetcher(base + objectPath(key), { method, headers: signedHeaders(method, key, extra), redirect: 'error',
        signal: AbortSignal.timeout(body ? 10 * 60_000 : 30_000), ...(body ? { body, duplex: 'half' } : {}) });
    } catch { throw new Error('OSS 更新服务连接失败'); }
  }
  function verifyHead(response, entry, md5) {
    if (response.status !== 200 || Number(response.headers.get('content-length')) !== entry.bytes
      || response.headers.get('x-oss-meta-sha256') !== entry.sha256
      || response.headers.get('etag')?.replaceAll('"', '').toLowerCase() !== md5) throw new Error('OSS 安装包身份或摘要不一致，拒绝发布');
  }
  return {
    async ensureUploaded(entry) {
      const target = releaseTarget(entry.platform, entry.arch);
      if (!target) throw new Error('OSS 更新平台或架构无效');
      const key = entry.platform === undefined && entry.arch === undefined
        ? `${config.prefix}${entry.version}/${entry.fileName}`
        : `${config.prefix}${target.platform}/${target.arch}/${entry.version}/${entry.fileName}`;
      if (!validKey(key) || !isInstallerName(entry.fileName, entry.version, target.platform, target.arch)) throw new Error('OSS 更新对象路径无效');
      const md5 = createHash('md5'), sha = createHash('sha256'); let bytes = 0;
      for await (const part of createReadStream(entry.path)) { bytes += part.length; md5.update(part); sha.update(part); }
      const digest = md5.digest();
      if (bytes !== entry.bytes || sha.digest('hex') !== entry.sha256) throw new Error('本地安装包身份已改变，拒绝上传');
      const previous = await request('HEAD', key);
      if (previous.status === 200) { verifyHead(previous, entry, digest.toString('hex')); return key; }
      if (previous.status !== 404) throw new Error(`OSS 安装包检查失败（HTTP ${previous.status}）`);
      const stream = createReadStream(entry.path);
      try {
        const uploaded = await request('PUT', key, { 'content-type': 'application/octet-stream', 'content-length': String(entry.bytes),
          'content-md5': digest.toString('base64'), 'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true',
          'x-oss-meta-sha256': entry.sha256 }, stream);
        await uploaded.arrayBuffer();
        if (!uploaded.ok && uploaded.status !== 409) throw new Error(`OSS 安装包上传失败（HTTP ${uploaded.status}）`);
      } finally { stream.destroy(); }
      verifyHead(await request('HEAD', key), entry, digest.toString('hex'));
      return key;
    },
    downloadUrl(key, method = 'GET') {
      if (!validKey(key) || !['GET', 'HEAD'].includes(method)) throw new Error('OSS 更新对象路径无效');
      // Hour-aligned URLs remain valid for at least 23 hours; clients check every four hours.
      const timestamp = stamp(Math.floor(now() / 3_600_000) * 3_600_000);
      const query = new URLSearchParams({ 'x-oss-signature-version': 'OSS4-HMAC-SHA256',
        'x-oss-credential': `${config.accessKeyId}/${timestamp.slice(0, 8)}/${region}/oss/aliyun_v4_request`,
        'x-oss-date': timestamp, 'x-oss-expires': '86400' });
      if (config.securityToken) query.set('x-oss-security-token', config.securityToken);
      query.set('x-oss-signature', updateOssSignature({ secret: config.accessKeySecret, region, timestamp, method,
        resource: `/${bucket}/${objectPath(key)}`, query: query.toString() }));
      return base + objectPath(key) + '?' + query;
    },
  };
}

export function ossUpdateStorageFromFile(path) {
  if (!path || !existsSync(path)) return null;
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('OSS 更新配置文件无法读取'); }
  return createOssUpdateStorage(config);
}
