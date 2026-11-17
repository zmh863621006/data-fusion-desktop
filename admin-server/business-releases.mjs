import { createHash, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { businessOssStorageFromFile } from './business-oss.mjs';
import { BUSINESS_MAX_BYTES, BUSINESS_VERSION, businessTarget, businessLane, businessFileName, compareBusinessVersion, inspectBusinessAsar, validateBusinessMetadata } from './business-asar.mjs';

const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
export function createBusinessReleases(db, { directory, publicOrigin, privateKey, transaction, audit = () => {}, authorize,
  ossStorage, maxBytes = BUSINESS_MAX_BYTES, uploadTimeoutMs = 600_000, now = Date.now } = {}) {
  const root = directory ? resolve(directory) : null;
  const mirror = ossStorage ?? businessOssStorageFromFile(root ? join(dirname(root), 'update-oss.secure.json') : undefined);
  const publicKey = createPublicKey(privateKey);
  db.exec(`CREATE TABLE IF NOT EXISTS business_releases(
    id TEXT PRIMARY KEY,version TEXT NOT NULL,platform TEXT NOT NULL,arch TEXT NOT NULL,variant TEXT NOT NULL,electron_major INTEGER NOT NULL,
    storage_name TEXT NOT NULL UNIQUE,file_name TEXT NOT NULL,state TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,sha256 TEXT NOT NULL DEFAULT '',
    metadata_json TEXT,notes TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 0,published_once INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,published_at INTEGER NOT NULL DEFAULT 0,UNIQUE(platform,arch,variant,electron_major,version));
    CREATE TABLE IF NOT EXISTS business_release_channels(lane TEXT PRIMARY KEY,current_id TEXT,max_version TEXT,backend_origin TEXT,backend_revision INTEGER,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0);`);
  for (const [name, definition] of [['backend_origin', 'TEXT'], ['backend_revision', 'INTEGER']]) {
    if (!db.prepare('PRAGMA table_info(business_release_channels)').all().some(row => row.name === name)) db.exec(`ALTER TABLE business_release_channels ADD COLUMN ${name} ${definition}`);
  }
  const targetFor = row => ({ platform: row.platform, arch: row.arch, variant: row.variant, electronMajor: row.electron_major });
  const lookup = id => db.prepare('SELECT * FROM business_releases WHERE id=?').get(id);
  const pathFor = row => {
    if (!root || !/^[a-f0-9-]{36}\.asar$/.test(row.storage_name)) fail('业务包存储目录无效', 503);
    return join(root, row.storage_name);
  };
  const objectEntry = row => ({ path: pathFor(row), target: targetFor(row), version: row.version, bytes: row.bytes, sha256: row.sha256 });
  const proxyUrl = row => `${publicOrigin ?? ''}/api/business-releases/${row.id}/${encodeURIComponent(row.file_name)}`;
  const describe = row => ({ id: row.id, version: row.version, target: targetFor(row), fileName: row.file_name, bytes: row.bytes, sha256: row.sha256,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null, notes: row.notes, enabled: Boolean(row.enabled), publishedAt: row.published_at,
    createdAt: row.created_at, status: row.state === 'uploading' ? 'uploading' : row.enabled ? 'published' : row.published_once ? 'disabled' : 'draft',
    url: row.enabled && mirror ? mirror.payloadUrl(objectEntry(row)) : proxyUrl(row), feedUrl: mirror ? mirror.feedUrl(targetFor(row)) : null });
  const uploads = new Set(), publishing = new Set(), requests = new Set(), completions = new Set(); let closed = false;
  function reauthorize(request, user) {
    if (!authorize) return;
    const current = authorize(request);
    if (!current || current.id !== user.id || current.role !== 'admin' || current.passwordChangeRequired) fail('账号状态已变更，请重新登录', 403);
  }
  async function checkStored(row) {
    const path = pathFor(row), info = await lstat(path).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.size !== row.bytes) fail('业务包不存在或大小已改变', 409);
    const digest = createHash('sha256'); for await (const block of createReadStream(path)) digest.update(block);
    if (digest.digest('hex') !== row.sha256) fail('业务包摘要已改变，拒绝发布', 409);
    const inspected = await inspectBusinessAsar(path, { version: row.version, target: targetFor(row) });
    if (JSON.stringify(inspected.metadata) !== row.metadata_json) fail('业务包内部发布信息已改变', 409);
  }
  function decodeLatest(latest, target) {
    if (!latest) return null;
    const envelope = latest.envelope;
    if (!envelope || envelope.algorithm !== 'RSA-SHA256' || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') fail('OSS 现有清单格式无效', 409);
    const bytes = Buffer.from(envelope.payload, 'base64url');
    if (!verify('RSA-SHA256', bytes, publicKey, Buffer.from(envelope.signature, 'base64url'))) fail('OSS 现有清单签名无效，停止发布', 409);
    let payload; try { payload = JSON.parse(bytes); } catch { fail('OSS 现有清单无效', 409); }
    if (payload?.schema !== 1 || payload.product !== 'data-fusion-desktop' || !BUSINESS_VERSION.test(payload.version)
      || Object.keys(target).some(key => payload.target?.[key] !== target[key]) || !/^[a-f0-9]{64}$/.test(payload.sha256)) fail('OSS 现有清单目标无效', 409);
    try { validateBusinessMetadata({ schema: payload.schema, product: payload.product, version: payload.version, minShellVersion: payload.minShellVersion,
      target: payload.target, backend: payload.backend, entry: 'out/main/index.js' }); } catch { fail('OSS 现有清单后台配置无效', 409); }
    return payload;
  }
  async function upload(request, response, url, user) {
    if (!root || !privateKey) fail('业务更新存储尚未配置', 503);
    if (closed) fail('发布服务正在关闭', 503);
    if (uploads.size >= 2) fail('已有业务包正在上传，请稍后重试', 429);
    const version = url.searchParams.get('version') ?? '', name = url.searchParams.get('filename') ?? '';
    const target = businessTarget(Object.fromEntries(url.searchParams));
    if (!target || !BUSINESS_VERSION.test(version) || name !== businessFileName(version)) fail('业务版本、平台、架构或文件名无效');
    let notes = '';
    const encodedNotes = request.headers['x-release-notes-base64'];
    if (encodedNotes !== undefined) {
      if (typeof encodedNotes !== 'string' || encodedNotes.length > 6000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedNotes)) fail('业务更新说明编码无效');
      try { notes = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encodedNotes, 'base64')); } catch { fail('业务更新说明无效'); }
    }
    if (notes.length > 1000) fail('更新说明不能超过1000字');
    const expected = request.headers['x-content-sha256'];
    if (expected !== undefined && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))) fail('客户端摘要无效');
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) < 16 || Number(declared) > maxBytes)) fail('业务包大小无效', 413);
    const lane = businessLane(target), key = lane + ':' + version;
    const previous = db.prepare('SELECT * FROM business_releases WHERE platform=? AND arch=? AND variant=? AND electron_major=? AND version=?')
      .get(target.platform, target.arch, target.variant, target.electronMajor, version);
    const recoverable = previous?.state === 'uploading' && !previous.enabled && !previous.published_once && previous.created_at < now() - uploadTimeoutMs - 120_000;
    if (uploads.has(key) || previous && !recoverable) fail('该环境的业务版本已存在，不能替换；请使用新版本号', 409);
    const id = randomUUID(), path = pathFor({ storage_name: id + '.asar' }), temporary = path + '.upload';
    uploads.add(key); requests.add(request); let resolveCompletion;
    const completion = new Promise(resolveValue => { resolveCompletion = resolveValue; }); completions.add(completion);
    const timer = setTimeout(() => request.destroy(Object.assign(Error('业务包上传超时'), { status: 408 })), uploadTimeoutMs); timer.unref?.(); request.setTimeout(60_000);
    let file, reserved = false, moved = false, bytes = 0;
    try {
      await mkdir(root, { recursive: true, mode: 0o700 }); const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('业务存储目录不允许链接', 503);
      if (recoverable) { await unlink(pathFor(previous) + '.upload').catch(error => { if (error.code !== 'ENOENT') throw error; }); await unlink(pathFor(previous)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      transaction(() => {
        if (recoverable) {
          const stale = lookup(previous.id); if (!stale || stale.state !== 'uploading' || stale.enabled || stale.published_once) fail('原上传状态已变更', 409);
          db.prepare('DELETE FROM business_releases WHERE id=?').run(previous.id); audit(user, 'business_update.upload_recovered', 'business_update', previous.id, { version, target });
        }
        db.prepare('INSERT INTO business_releases(id,version,platform,arch,variant,electron_major,storage_name,file_name,state,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, version, target.platform, target.arch, target.variant, target.electronMajor, id + '.asar', name, 'uploading', notes, now());
      }); reserved = true;
      file = await open(temporary, 'wx', 0o600); const digest = createHash('sha256');
      for await (const block of request) { if (closed) fail('发布服务正在关闭', 503); bytes += block.length; if (bytes > maxBytes) fail('业务包超过256MB', 413); digest.update(block); await file.writeFile(block); }
      request.setTimeout(uploadTimeoutMs);
      if (declared !== undefined && Number(declared) !== bytes) fail('业务包上传不完整');
      const sha256 = digest.digest('hex'); if (expected && sha256 !== expected) fail('业务包摘要与声明不一致');
      const inspected = await inspectBusinessAsar(temporary, { version, target }); reauthorize(request, user);
      await file.sync(); await file.close(); file = null; await chmod(temporary, 0o400); await rename(temporary, path); moved = true;
      if (mirror) await mirror.ensurePrivate({ path, version, target, bytes, sha256 });
      if (closed) fail('发布服务正在关闭', 503); reauthorize(request, user);
      transaction(() => { db.prepare("UPDATE business_releases SET state='ready',bytes=?,sha256=?,metadata_json=? WHERE id=?").run(bytes, sha256, JSON.stringify(inspected.metadata), id);
        audit(user, 'business_update.uploaded', 'business_update', id, { version, target, bytes, sha256 }); });
      return describe(lookup(id));
    } catch (error) {
      if (file) await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); if (moved) await unlink(path).catch(() => {});
      if (reserved) transaction(() => { db.prepare('DELETE FROM business_releases WHERE id=? AND enabled=0 AND published_once=0').run(id); });
      throw error;
    } finally { clearTimeout(timer); uploads.delete(key); requests.delete(request); completions.delete(completion); resolveCompletion(); }
  }
  async function publish(id, enabled, request, user) {
    const row = lookup(id); if (!row) fail('业务版本不存在', 404);
    if (!mirror) fail('请先配置独立 OSS 业务更新存储', 503);
    if (row.state !== 'ready') fail('业务包尚未上传完成', 409);
    const target = targetFor(row), lane = businessLane(target), token = randomUUID(), metadata = JSON.parse(row.metadata_json);
    const checkBackendRevision = previous => {
      if (previous && (metadata.backend.revision < previous.revision || metadata.backend.revision === previous.revision && metadata.backend.origin !== previous.origin))
        fail('后台地址修订不能降低；更换后台地址必须提高修订号', 409);
    };
    if (publishing.has(lane)) fail('该环境已有发布操作正在进行', 409);
    transaction(() => {
      db.prepare('INSERT OR IGNORE INTO business_release_channels(lane) VALUES(?)').run(lane);
      const channel = db.prepare('SELECT * FROM business_release_channels WHERE lane=?').get(lane);
      if (channel.lease_token && channel.lease_until > now()) fail('该环境正由另一发布进程操作，请稍后重试', 409);
      if (enabled && channel.max_version && compareBusinessVersion(row.version, channel.max_version) < 0) fail('不能回退强制更新版本，请发布更高版本的修复包', 409);
      if (enabled && channel.backend_revision) checkBackendRevision({ origin: channel.backend_origin, revision: channel.backend_revision });
      db.prepare('UPDATE business_release_channels SET lease_token=?,lease_until=? WHERE lane=?').run(token, now() + 15 * 60_000, lane);
    }); publishing.add(lane);
    let finish; const completion = new Promise(resolveValue => { finish = resolveValue; }); completions.add(completion);
    const assertLease = () => { if (closed || db.prepare('SELECT lease_token FROM business_release_channels WHERE lane=?').get(lane)?.lease_token !== token) fail('发布状态已变更，请刷新后核对', 409); reauthorize(request, user); };
    try {
      assertLease(); const latest = await mirror.readLatest(target), current = decodeLatest(latest, target);
      if (!enabled) {
        if (current && current.version === row.version && current.sha256 === row.sha256) fail('当前强制更新版本不能直接下线，请先发布更高版本的修复或回退业务包', 409);
        await mirror.setPublic(objectEntry(row), false); assertLease();
        transaction(() => { db.prepare('UPDATE business_releases SET enabled=0 WHERE id=?').run(id); audit(user, 'business_update.disabled', 'business_update', id, { version: row.version, target }); });
        return describe(lookup(id));
      }
      if (current && (compareBusinessVersion(row.version, current.version) < 0 || row.version === current.version && row.sha256 !== current.sha256)) fail('OSS 已有更高版本或同版本不同内容，请刷新核对', 409);
      checkBackendRevision(current?.backend);
      await checkStored(row); await mirror.ensurePrivate(objectEntry(row)); assertLease();
      const payload = { schema: 1, product: 'data-fusion-desktop', version: row.version, minShellVersion: metadata.minShellVersion,
        target, url: mirror.payloadUrl(objectEntry(row)), bytes: row.bytes, sha256: row.sha256, backend: metadata.backend };
      const bytes = Buffer.from(JSON.stringify(payload)), envelope = { algorithm: 'RSA-SHA256', payload: bytes.toString('base64url'), signature: sign('RSA-SHA256', bytes, privateKey).toString('base64url') };
      await mirror.setPublic(objectEntry(row), true); assertLease(); await mirror.writeLatest(target, envelope, latest?.etag ?? null); assertLease();
      transaction(() => {
        db.prepare('UPDATE business_releases SET enabled=1,published_once=1,published_at=? WHERE id=?').run(now(), id);
        db.prepare('UPDATE business_release_channels SET current_id=?,max_version=?,backend_origin=?,backend_revision=? WHERE lane=? AND lease_token=?')
          .run(id, row.version, metadata.backend.origin, metadata.backend.revision, lane, token);
        audit(user, 'business_update.published', 'business_update', id, { version: row.version, target, sha256: row.sha256, feedUrl: mirror.feedUrl(target) });
      }); return describe(lookup(id));
    } catch (error) {
      // A failed new publication must not leave a discoverable draft payload.
      // If OSS accepted the new manifest before a transport error, retain its
      // referenced bytes and allow an idempotent retry to reconcile the DB.
      if (enabled && !row.published_once) {
        try { const current = decodeLatest(await mirror.readLatest(target), target);
          if (!current || current.version !== row.version || current.sha256 !== row.sha256) await mirror.setPublic(objectEntry(row), false); } catch {}
      }
      throw error;
    } finally {
      transaction(() => { db.prepare('UPDATE business_release_channels SET lease_token=NULL,lease_until=0 WHERE lane=? AND lease_token=?').run(lane, token); });
      publishing.delete(lane); completions.delete(completion); finish();
    }
  }
  async function serve(request, response, url) {
    const match = /^\/api\/business-releases\/([a-f0-9-]{36})\/(business-[0-9.]+\.asar)$/.exec(url.pathname);
    if (!match || !['GET', 'HEAD'].includes(request.method)) return false;
    const row = lookup(match[1]); if (!row || !row.enabled || row.state !== 'ready' || match[2] !== row.file_name || !mirror) fail('业务包不存在或尚未发布', 404);
    response.writeHead(302, { location: mirror.payloadUrl(objectEntry(row)), 'cache-control': 'no-store' }); response.end(); return true;
  }
  return { upload, publish, serve, list: () => ({ rows: db.prepare('SELECT * FROM business_releases ORDER BY created_at DESC,id DESC').all().map(describe), configured: Boolean(mirror), feedBase: mirror?.feedBase ?? null }),
    close() { closed = true; for (const request of requests) request.destroy(); if (completions.size) return Promise.allSettled([...completions]); } };
}
