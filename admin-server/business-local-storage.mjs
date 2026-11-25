import { createHash, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { BUSINESS_VERSION, businessTarget, businessLane, businessFileName, validateBusinessMetadata } from './business-asar.mjs';

const fail = (message, status = 409) => { throw Object.assign(Error(message), { status }); };
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

/** Local discovery is committed with the release/channel rows in one SQLite transaction.
 * There is deliberately no separately renamed latest.json that could get ahead of the DB. */
export function createBusinessLocalStorage({ database, directory, feedBase, publicOrigin, publicKey } = {}) {
  let base, origin;
  try { base = new URL(feedBase); origin = new URL(publicOrigin); } catch { fail('内网业务更新地址无效', 503); }
  if (!directory || base.protocol !== 'https:' || origin.protocol !== 'https:' || origin.origin !== publicOrigin
    || base.href !== feedBase || base.origin !== origin.origin || base.username || base.password || base.search || base.hash
    || base.pathname === '/' || base.pathname.startsWith('/api/')
    || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base.pathname)) fail('内网业务更新必须使用固定的同源 HTTPS 目录', 503);
  const root = resolve(directory), basePath = base.pathname;
  database.exec(`CREATE TABLE IF NOT EXISTS business_local_feeds(
    lane TEXT PRIMARY KEY,envelope_json TEXT NOT NULL,etag TEXT NOT NULL);`);
  const checkedTarget = value => { const target = businessTarget(value); if (!target) fail('业务更新目标无效', 400); return target; };
  const lane = target => businessLane(checkedTarget(target));
  const payloadUrl = entry => {
    if (!BUSINESS_VERSION.test(entry.version)) fail('业务版本无效', 400);
    return base.href + lane(entry.target) + '/' + entry.version + '/' + businessFileName(entry.version);
  };
  function validateEnvelope(envelope, target) {
    if (!envelope || envelope.algorithm !== 'RSA-SHA256' || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') fail('内网业务清单格式无效');
    const bytes = Buffer.from(envelope.payload, 'base64url');
    if (!verify('RSA-SHA256', bytes, publicKey, Buffer.from(envelope.signature, 'base64url'))) fail('内网业务清单签名无效');
    let payload; try { payload = JSON.parse(bytes); } catch { fail('内网业务清单格式无效'); }
    try { validateBusinessMetadata({ schema: payload.schema, product: payload.product, version: payload.version, minShellVersion: payload.minShellVersion,
      target: payload.target, backend: payload.backend, entry: 'out/main/index.js' }, { version: payload.version, target: checkedTarget(target) }); }
    catch { fail('内网业务清单目标或版本无效'); }
    if (!Number.isSafeInteger(payload.bytes) || payload.bytes < 16 || !/^[a-f0-9]{64}$/.test(payload.sha256)
      || payload.url !== payloadUrl({ version: payload.version, target })) fail('内网业务清单载荷无效');
    return payload;
  }
  function readLatest(target) {
    const row = database.prepare('SELECT envelope_json,etag FROM business_local_feeds WHERE lane=?').get(lane(target));
    if (!row) return null;
    let envelope; try { envelope = JSON.parse(row.envelope_json); } catch { fail('内网业务清单已损坏'); }
    if ('"' + createHash('sha256').update(row.envelope_json).digest('hex') + '"' !== row.etag) fail('内网业务清单摘要已改变');
    validateEnvelope(envelope, target);
    return { envelope, etag: row.etag };
  }
  async function assertRoot() {
    // Walk ancestors rather than comparing realpath strings: Windows short
    // names (e.g. the system TEMP directory) are aliases, not symlinks.
    for (let path = root;; path = dirname(path)) {
      const info = await lstat(path).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) fail('业务存储目录不允许链接', 503);
      if (dirname(path) === path) break;
    }
  }
  async function checkedFile(entry) {
    const path = resolve(entry.path);
    if (!samePath(dirname(path), root) || !/^[a-f0-9-]{36}\.asar$/.test(path.slice(root.length + 1))) fail('业务包路径无效');
    await assertRoot();
    const before = await lstat(path).catch(() => null);
    if (!before?.isFile() || before.isSymbolicLink() || before.size !== entry.bytes) fail('业务包不存在或大小已改变');
    let file;
    try {
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size !== entry.bytes) fail('业务包文件身份已改变');
      const digest = createHash('sha256'), buffer = Buffer.alloc(128 * 1024); let position = 0;
      for (;;) { const { bytesRead } = await file.read(buffer, 0, buffer.length, position); if (!bytesRead) break; position += bytesRead; digest.update(buffer.subarray(0, bytesRead)); }
      const after = await file.stat();
      if (position !== entry.bytes || digest.digest('hex') !== entry.sha256 || after.size !== info.size || after.mtimeMs !== info.mtimeMs) fail('业务包摘要已改变');
      return file;
    } catch (error) { await file?.close().catch(() => {}); throw error; }
  }
  function commitLatest(target, envelope, previousEtag) {
    // The caller owns BEGIN IMMEDIATE, the channel lease, and its final state writes.
    // CAS and all those writes roll back together if any later statement/audit fails.
    if (!database.isTransaction) fail('内网业务清单必须随发布事务提交', 500);
    const key = lane(target), current = readLatest(target);
    if ((current?.etag ?? null) !== (previousEtag ?? null)) fail('内网业务清单已被其他发布变更，请刷新后重试');
    validateEnvelope(envelope, target);
    const body = JSON.stringify(envelope) + '\n';
    if (Buffer.byteLength(body) > 64 * 1024) fail('业务清单超过限制', 400);
    const etag = '"' + createHash('sha256').update(body).digest('hex') + '"';
    database.prepare('INSERT INTO business_local_feeds(lane,envelope_json,etag) VALUES(?,?,?) ON CONFLICT(lane) DO UPDATE SET envelope_json=excluded.envelope_json,etag=excluded.etag').run(key, body, etag);
  }
  async function sendPayload(request, response, entry) {
    const file = await checkedFile(entry), etag = '"' + entry.sha256 + '"';
    const headers = { 'content-type': 'application/octet-stream', 'content-length': String(entry.bytes),
      'content-disposition': `attachment; filename="${businessFileName(entry.version)}"`, etag,
      'cache-control': 'public, max-age=31536000, immutable', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' };
    if (request.headers['if-none-match'] === etag) { await file.close(); response.writeHead(304, { etag, 'cache-control': headers['cache-control'] }); response.end(); return true; }
    let start = 0, end = entry.bytes - 1, status = 200;
    const range = request.headers.range;
    if (range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, entry.bytes - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      }
      if (!match || !match[1] && !match[2] || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= entry.bytes) {
        await file.close(); response.writeHead(416, { 'content-range': `bytes */${entry.bytes}`, 'content-length': '0' }); response.end(); return true;
      }
      status = 206; headers['content-range'] = `bytes ${start}-${end}/${entry.bytes}`; headers['content-length'] = String(end - start + 1);
    }
    response.writeHead(status, headers);
    if (request.method === 'HEAD') { await file.close(); response.end(); return true; }
    const stream = file.createReadStream({ start, end, autoClose: true });
    stream.on('error', error => response.destroy(error)); response.on('close', () => stream.destroy()); stream.pipe(response); return true;
  }
  return {
    mode: 'local', feedBase: base.href, feedUrl: target => base.href + lane(target) + '/latest.json', payloadUrl,
    readLatest, commitLatest, assertRoot,
    async ensurePrivate(entry) { const file = await checkedFile(entry); await file.close(); },
    async setPublic() { /* Visibility is controlled exclusively by committed release rows. */ },
    sendPayload,
    async serve(request, response, url, lookupPublished) {
      if (!url.pathname.startsWith(basePath)) return false;
      if (!['GET', 'HEAD'].includes(request.method)) fail('业务更新仅支持 GET/HEAD', 405);
      const match = /^(win32|linux)\/(x64|arm64)\/(standard|kirin990)\/electron-(22|44)\/(latest\.json|([^/]+)\/(business-[0-9.]+\.asar))$/.exec(url.pathname.slice(basePath.length));
      if (!match) fail('业务更新文件不存在', 404);
      const target = checkedTarget({ platform: match[1], arch: match[2], variant: match[3], electronMajor: Number(match[4]) });
      if (match[5] === 'latest.json') {
        const row = database.prepare('SELECT envelope_json,etag FROM business_local_feeds WHERE lane=?').get(lane(target));
        if (!row) fail('这个业务通道尚未发布', 404);
        const latest = readLatest(target), payload = JSON.parse(Buffer.from(latest.envelope.payload, 'base64url'));
        const entry = lookupPublished(target, payload.version, true);
        if (!entry || entry.bytes !== payload.bytes || entry.sha256 !== payload.sha256) fail('内网业务清单与已发布记录不一致');
        const headers = { 'content-type': 'application/json; charset=utf-8', etag: row.etag,
          'cache-control': 'no-cache, max-age=0, must-revalidate', 'x-content-type-options': 'nosniff' };
        if (request.headers['if-none-match'] === row.etag) { response.writeHead(304, headers); response.end(); return true; }
        response.writeHead(200, { ...headers, 'content-length': String(Buffer.byteLength(row.envelope_json)) });
        response.end(request.method === 'HEAD' ? undefined : row.envelope_json); return true;
      }
      if (!BUSINESS_VERSION.test(match[6]) || match[7] !== businessFileName(match[6])) fail('业务更新文件不存在', 404);
      const entry = lookupPublished(target, match[6]); if (!entry) fail('业务包不存在或尚未发布', 404);
      return sendPayload(request, response, entry);
    },
  };
}
