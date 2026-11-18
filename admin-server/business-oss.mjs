import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { updateOssSignature } from './update-oss.mjs';
import { BUSINESS_VERSION, businessTarget, businessLane, businessFileName } from './business-asar.mjs';

const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encodedPath = key => key.split('/').map(encode).join('/');
const stamp = time => new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
export function createBusinessOssStorage(config, { fetcher = fetch, now = Date.now } = {}) {
  const endpoint = String(config.endpoint ?? '').replace(/^https:\/\//, '').replace(/\/$/, '');
  if (!/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(endpoint) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket ?? '')
    || !/^[A-Za-z0-9_/-]+\/$/.test(config.prefix ?? '') || config.prefix.includes('..') || config.prefix.startsWith('/')
    || !config.accessKeyId || !config.accessKeySecret) throw new Error('OSS 业务更新配置无效');
  const prefix = config.prefix + 'business/v1/', region = endpoint.slice(4, -'.aliyuncs.com'.length).replace(/-internal$/, '');
  const base = `https://${config.bucket}.${endpoint}/`;
  const publicBase = `https://${config.bucket}.${endpoint.replace('-internal.', '.')}/`;
  function lane(target) { const checked = businessTarget(target); if (!checked) throw Error('业务更新目标无效'); return prefix + businessLane(checked) + '/'; }
  function keyFor(entry) { if (!BUSINESS_VERSION.test(entry.version)) throw Error('业务版本无效'); return lane(entry.target) + entry.version + '/' + businessFileName(entry.version); }
  function validKey(key) {
    if (typeof key !== 'string' || !key.startsWith(prefix)) return false;
    const parts = key.slice(prefix.length).split('/'), target = businessTarget({ platform: parts[0], arch: parts[1], variant: parts[2], electronMajor: /^electron-(22|44)$/.exec(parts[3])?.[1] });
    return Boolean(target && (parts.length === 5 && parts[4] === 'latest.json' || parts.length === 6 && BUSINESS_VERSION.test(parts[4]) && parts[5] === businessFileName(parts[4])));
  }
  function publicUrl(key) { if (!validKey(key)) throw Error('OSS 业务对象路径无效'); return publicBase + encodedPath(key); }
  async function request(method, key, extra = {}, body, query = '') {
    if (!validKey(key)) throw Error('OSS 业务对象路径无效');
    const timestamp = stamp(now()), headers = { 'x-oss-date': timestamp, 'x-oss-content-sha256': 'UNSIGNED-PAYLOAD', ...extra };
    if (config.securityToken) headers['x-oss-security-token'] = config.securityToken;
    const included = Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('x-oss-') || ['content-md5', 'content-type'].includes(name)));
    const signature = updateOssSignature({ secret: config.accessKeySecret, region, timestamp, method, resource: `/${config.bucket}/${encodedPath(key)}`, query, headers: included });
    headers.authorization = `OSS4-HMAC-SHA256 Credential=${config.accessKeyId}/${timestamp.slice(0, 8)}/${region}/oss/aliyun_v4_request,Signature=${signature}`;
    try { return await fetcher(base + encodedPath(key) + (query ? '?' + query : ''), { method, headers, redirect: 'error', signal: AbortSignal.timeout(body && !Buffer.isBuffer(body) ? 600_000 : 30_000), ...(body ? { body, duplex: 'half' } : {}) }); }
    catch { throw Error('OSS 业务更新服务连接失败'); }
  }
  async function boundedJson(response) {
    if (Number(response.headers.get('content-length') ?? 0) > 64 * 1024) throw Error('OSS 业务清单超过限制');
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body ?? []) { bytes += chunk.length; if (bytes > 64 * 1024) throw Error('OSS 业务清单超过限制'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('OSS 业务清单无效'); }
  }
  function verifyHead(response, entry, md5) {
    if (response.status !== 200 || Number(response.headers.get('content-length')) !== entry.bytes || response.headers.get('x-oss-meta-sha256') !== entry.sha256
      || response.headers.get('etag')?.replaceAll('"', '').toLowerCase() !== md5) throw Error('OSS 业务包摘要或大小不一致');
  }
  async function readLatest(target) {
    const response = await request('GET', lane(target) + 'latest.json');
    if (response.status === 404) { await response.arrayBuffer(); return null; }
    if (response.status !== 200) throw Error(`OSS 业务清单读取失败（HTTP ${response.status}）`);
    const etag = response.headers.get('etag'); if (!etag) throw Error('OSS 业务清单缺少 ETag');
    return { envelope: await boundedJson(response), etag };
  }
  return {
    feedBase: publicBase + encodedPath(prefix),
    feedUrl: target => publicUrl(lane(target) + 'latest.json'),
    payloadUrl: entry => publicUrl(keyFor(entry)),
    async ensurePrivate(entry) {
      const key = keyFor(entry), md5 = createHash('md5'), sha = createHash('sha256'); let bytes = 0;
      for await (const part of createReadStream(entry.path)) { bytes += part.length; md5.update(part); sha.update(part); }
      const digest = md5.digest(); if (bytes !== entry.bytes || sha.digest('hex') !== entry.sha256) throw Error('本地业务包身份已改变');
      const previous = await request('HEAD', key);
      if (previous.status === 200) { verifyHead(previous, entry, digest.toString('hex')); return key; }
      if (previous.status !== 404) throw Error(`OSS 业务对象检查失败（HTTP ${previous.status}）`);
      const stream = createReadStream(entry.path);
      try {
        const result = await request('PUT', key, { 'content-type': 'application/octet-stream', 'content-length': String(bytes), 'content-md5': digest.toString('base64'),
          'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true', 'x-oss-meta-sha256': entry.sha256, 'cache-control': 'public, max-age=31536000, immutable' }, stream);
        await result.arrayBuffer(); if (!result.ok && result.status !== 409) throw Error(`OSS 业务包上传失败（HTTP ${result.status}）`);
      } finally { stream.destroy(); }
      verifyHead(await request('HEAD', key), entry, digest.toString('hex')); return key;
    },
    async setPublic(entry, enabled) {
      const result = await request('PUT', keyFor(entry), { 'x-oss-object-acl': enabled ? 'public-read' : 'private', 'content-length': '0' }, undefined, 'acl');
      await result.arrayBuffer(); if (!result.ok) throw Error(`OSS 业务包访问状态变更失败（HTTP ${result.status}）`);
    },
    readLatest,
    async writeLatest(target, envelope, previousEtag) {
      const body = Buffer.from(JSON.stringify(envelope) + '\n'); if (body.length > 64 * 1024) throw Error('业务清单超过限制');
      // OSS PutObject does not implement If-Match or If-None-Match. All
      // publishers use the same channel lease in the management database.
      const current = await readLatest(target);
      if ((current?.etag ?? null) !== (previousEtag ?? null)) throw Object.assign(Error('OSS 业务清单已被其他发布变更，请刷新后重试'), { status: 409 });
      const response = await request('PUT', lane(target) + 'latest.json', { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length),
        'content-md5': createHash('md5').update(body).digest('base64'), 'x-oss-object-acl': 'public-read', 'cache-control': 'no-cache, max-age=0, must-revalidate',
        ...(previousEtag ? {} : { 'x-oss-forbid-overwrite': 'true' }) }, body);
      await response.arrayBuffer(); if ([409, 412].includes(response.status)) throw Object.assign(Error('业务清单已被其他发布变更，请刷新后重试'), { status: 409 });
      if (!response.ok) throw Error(`OSS 业务清单发布失败（HTTP ${response.status}）`);
      const published = (await readLatest(target))?.envelope;
      if (published?.algorithm !== envelope.algorithm || published.payload !== envelope.payload || published.signature !== envelope.signature)
        throw Error('OSS 业务清单写入后的回读校验失败');
      return publicUrl(lane(target) + 'latest.json');
    },
  };
}
export function businessOssStorageFromFile(path) {
  if (!path || !existsSync(path)) return null;
  let configuration; try { configuration = JSON.parse(readFileSync(path, 'utf8')); } catch { throw Error('OSS 业务更新配置无法读取'); }
  return createBusinessOssStorage(configuration);
}
