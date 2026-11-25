import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ossUpdateStorageFromFile } from './update-oss.mjs';
import { RELEASE_VERSION_PATTERN as VERSION, installerName, installerVersion, isInstallerName, installerDisposition, releaseTarget } from './update-filenames.mjs';

const MAX_BYTES = 500 * 1024 * 1024;
const NSIS_MARKER = Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
// Pinned to the reviewed process-local launcher and official upstream private
// libraries/notices in resources/kirin990-compat/sources.json. A manifest inside
// an uploaded archive is not itself a trusted source of allowed library bytes.
const KIRIN990_LAUNCHER_SHA256 = '1f7bad2121ccd2707d3d68f8c1696d0cae9e440b18168882bf0070b3a1d00d57';
const KIRIN990_FILES = {
  'libgbm.so.1': '0c40e83443b61bd1eb33367f02255ff289f07d22086ae6ea9d7f231f541473c7',
  'COPYRIGHT.libgbm1': '30c36421275bf40e318d5d3e8662db6e332f97f047fa963bdb44e28ef9112232',
  'libdrm.so.2': '3172504008446d5fad455e317c79c458eacf6e800a76e459ead72212bca0eb2d',
  'COPYRIGHT.libdrm2': '512c9a57fd8b449aa157351da9df07bf8e19f767e496a72205a4020268ddb2e0',
  'libexpat.so.1': 'ded87e196b89bbbb3194a022485348d3fd3195d091a3c326eea52ea5eac755df',
  'COPYRIGHT.libexpat1': '15721756f0bdfd8fb83d3ae9fd9f76ceb3285b0ecacb0532a547e9e2f324c35c',
  'libwayland-server.so.0': 'a2562454cef3d0fb4a3974a31663054420ff34016ce70f6c50c33a3b3563008a',
  'COPYRIGHT.libwayland-server0': '3a943debedeac62002ce65da7a9b647875612c3d45840f0b001ae27fb76522a6',
  'libffi.so.6': '4fca2d72d71008423fdc880c853ab4e8753946322960c265db199323aeb72e25',
  'COPYRIGHT.libffi6': '7258c8acc378030d8dbe1fcdf394e915769fa31dcbaf3d2991d9a79891f3bcdc',
};

// Read archive members as data only. tar never extracts files or runs package
// scripts, and both its elapsed time and output are bounded.
async function readTarMember(path, member, args, outputLimit, captureLimit = outputLimit, entryName, summarize = false) {
  return new Promise((resolveResult, reject) => {
    const compressionFlag = { gz: '-z', xz: '-J', bz2: '-j', zst: '--zstd' }[member.compression];
    const child = spawn('tar', [...args, ...(compressionFlag ? [compressionFlag] : []), '-f', '-', ...(entryName === undefined ? [] : ['--', entryName])],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const source = createReadStream(path, { start: member.offset, end: member.offset + member.size - 1 });
    let bytes = 0, captured = 0, parts = [], failed = false, spawnError, errorText = '';
    const digest = summarize ? createHash('sha256') : null;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 60_000);
    timer.unref?.();
    child.on('error', error => { spawnError = error; });
    source.on('error', () => { failed = true; child.kill(); });
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => { if (errorText.length < 8192) errorText += chunk.toString('utf8').slice(0, 8192 - errorText.length); });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > outputLimit) { failed = true; child.kill(); return; }
      digest?.update(chunk);
      if (captured < captureLimit) { const part = chunk.subarray(0, captureLimit - captured); parts.push(part); captured += part.length; }
    });
    child.on('close', code => {
      clearTimeout(timer); source.destroy();
      if (spawnError?.code === 'ENOENT') return reject(Object.assign(new Error('发布服务器缺少 tar，暂不能校验麒麟安装包'), { status: 503 }));
      if (code !== 0 && /(?:unable to run program|Cannot exec|cannot run).*\b(?:xz|zstd)\b/i.test(errorText))
        return reject(Object.assign(new Error('发布服务器缺少对应压缩支持，请配置 xz/zstd 或使用 gzip 压缩的 DEB'), { status: 503 }));
      if (code !== 0 || failed || spawnError) return reject(Object.assign(new Error('DEB 压缩内容无效、过大或无法校验'), { status: 400 }));
      const prefix = Buffer.concat(parts, captured);
      resolveResult(summarize ? { prefix, sha256: digest.digest('hex'), bytes } : prefix);
    });
    source.pipe(child.stdin);
  });
}

export async function validateDebPackage(path, version, arch, length, variant = 'standard') {
  if (!VERSION.test(version) || !releaseTarget('linux', arch, variant)) fail('DEB 发布版本或架构无效');
  length ??= (await lstat(path)).size;
  if (!Number.isSafeInteger(length) || length > MAX_BYTES) fail('DEB 大小无效');
  const file = await open(path, 'r'), members = new Map();
  async function bytes(offset, size) {
    const result = Buffer.alloc(size), read = await file.read(result, 0, size, offset);
    if (read.bytesRead !== size) fail('DEB 内容不完整');
    return result;
  }
  try {
    if (length < 72 || !(await bytes(0, 8)).equals(Buffer.from('!<arch>\n'))) fail('只允许麒麟 DEB 安装包');
    let offset = 8;
    for (let count = 0; offset < length && count < 16; count++) {
      if (offset + 60 > length) fail('DEB 归档头不完整');
      const header = await bytes(offset, 60), name = header.toString('ascii', 0, 16).trim().replace(/\/$/, '');
      const sizeText = header.toString('ascii', 48, 58).trim();
      if (header.toString('ascii', 58) !== '`\n' || !/^\d+$/.test(sizeText) || members.has(name)) fail('DEB 归档头无效');
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size <= 0 || offset + 60 + size > length) fail('DEB 归档大小无效');
      members.set(name, { offset: offset + 60, size }); offset += 60 + size + (size % 2);
    }
    if (offset !== length) fail('DEB 归档结构无效');
    const binary = members.get('debian-binary');
    if (!binary || binary.size !== 4 || !(await bytes(binary.offset, 4)).equals(Buffer.from('2.0\n'))) fail('不支持的 DEB 格式');
  } finally { await file.close(); }
  const pick = prefix => {
    const found = [...members].filter(([name]) => new RegExp(`^${prefix}\\.tar(?:\\.(?:gz|xz|zst|bz2))?$`).test(name));
    if (found.length !== 1) fail('DEB 缺少或重复控制信息、程序载荷');
    return { ...found[0][1], compression: /\.tar\.(gz|xz|zst|bz2)$/.exec(found[0][0])?.[1] };
  };
  const controlArchive = pick('control'), dataArchive = pick('data');
  const controlNames = (await readTarMember(path, controlArchive, ['-t'], 128 * 1024)).toString('utf8').trim().split(/\r?\n/);
  const control = controlNames.filter(name => name.replace(/^\.\//, '') === 'control');
  if (control.length !== 1) fail('DEB 缺少唯一 control 文件');
  const controlBytes = await readTarMember(path, controlArchive, ['-xO'], 64 * 1024, 64 * 1024, control[0]);
  const pairs = controlBytes.toString('utf8').split(/\r?\n/).filter(line => /^[A-Za-z][A-Za-z-]*:/.test(line))
    .map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon), line.slice(colon + 1).trim()]; });
  if (new Set(pairs.map(([key]) => key.toLowerCase())).size !== pairs.length) fail('DEB 控制字段重复');
  const fields = Object.fromEntries(pairs);
  if (fields.Package !== 'data-fusion-desktop' || fields.Version !== version || fields.Architecture !== (arch === 'x64' ? 'amd64' : 'arm64'))
    fail('DEB 包名、内部版本或芯片架构与发布目标不一致');
  const names = (await readTarMember(path, dataArchive, ['-t'], 8 * 1024 * 1024)).toString('utf8').trim().split(/\r?\n/);
  const executables = names.filter(name => /^opt\/(?:data-fusion|数据融合助手)\/data-fusion$/.test(name.replace(/^\.\//, '')));
  if (executables.length !== 1) fail('DEB 缺少唯一数据融合助手程序');
  const isElf = elf => elf.length >= 20 && elf.toString('hex', 0, 4) === '7f454c46' && elf[4] === 2 && elf[5] === 1
    && elf.readUInt16LE(18) === (arch === 'x64' ? 62 : 183);
  if (variant === 'kirin990') {
    if (controlNames.some(name => !['', '.', 'control', 'md5sums'].includes(name.replace(/^\.\//, '').replace(/\/$/, ''))))
      fail('海思990专用包不允许安装维护脚本');
    const launcher = await readTarMember(path, dataArchive, ['-xO'], 64 * 1024, 64 * 1024, executables[0]);
    if (createHash('sha256').update(launcher).digest('hex') !== KIRIN990_LAUNCHER_SHA256) fail('海思990启动器与已审阅版本不一致');
    const base = executables[0].slice(0, -'data-fusion'.length);
    const one = relative => {
      const exact = base + relative;
      if (names.filter(name => name.replace(/^\.\//, '') === exact.replace(/^\.\//, '')).length !== 1) fail('海思990专用载荷缺少唯一文件：' + relative);
      return exact;
    };
    let provenance;
    try { provenance = JSON.parse((await readTarMember(path, dataArchive, ['-xO'], 64 * 1024, 64 * 1024,
      one('resources/compat/kirin990/provenance.json'))).toString('utf8')); }
    catch (error) { if (error.status) throw error; fail('海思990兼容来源信息无效'); }
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)
      || provenance.schema !== 1 || provenance.variant !== 'kirin990-arm64' || provenance.architecture !== 'arm64'
      || provenance.nativeExecutable !== 'data-fusion.bin' || provenance.launcherSha256 !== KIRIN990_LAUNCHER_SHA256
      || provenance.rendererSandbox !== true || provenance.systemLibrariesModified !== false || provenance.graphicsMode !== 'software-x11'
      || !/^[a-f0-9]{64}$/.test(provenance.nativeSha256) || !Array.isArray(provenance.files)
      || provenance.files.length !== Object.keys(KIRIN990_FILES).length) fail('海思990兼容元数据与专用渠道不一致');
    const native = await readTarMember(path, dataArchive, ['-xO'], 512 * 1024 * 1024, 64, one('data-fusion.bin'), true);
    if (!isElf(native.prefix) || native.sha256 !== provenance.nativeSha256) fail('海思990原生程序架构或摘要不符');
    const seen = new Set();
    for (const entry of provenance.files) {
      const expected = KIRIN990_FILES[entry?.path];
      if (!expected || seen.has(entry.path) || entry.sha256 !== expected
        || entry.kind !== (entry.path.startsWith('COPYRIGHT.') ? 'license' : 'library')) fail('海思990私有组件清单不符');
      seen.add(entry.path);
      const contents = await readTarMember(path, dataArchive, ['-xO'], 2 * 1024 * 1024, 2 * 1024 * 1024, one('resources/compat/kirin990/' + entry.path));
      if (contents.length !== entry.bytes || createHash('sha256').update(contents).digest('hex') !== expected
        || entry.kind === 'library' && !isElf(contents)) fail('海思990私有组件字节或架构不符');
    }
    return;
  }
  const elf = await readTarMember(path, dataArchive, ['-xO'], 512 * 1024 * 1024, 64, executables[0]);
  if (!isElf(elf)) fail('DEB 程序不是对应架构的64位 ELF 文件');
}
export function updatePublicOrigin(value) {
  if (!value) return null;
  let url; try { url = new URL(value); } catch { fail('更新公开地址必须为完整 HTTP/HTTPS 源地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password || url.search || url.hash) fail('更新公开地址必须为完整 HTTP/HTTPS 源地址，不含路径或凭据');
  return url.origin;
}

/** Administrative uploads are deliberately distinct from the public web/readonly code tree. */
export function createUpdateReleases(db, { directory, publicOrigin, transaction, audit, authorize,
  maxBytes = MAX_BYTES, uploadTimeoutMs = 10 * 60_000, now = Date.now, ossStorage, storageMode = 'oss' } = {}) {
  if (!['oss', 'local'].includes(storageMode)) fail('安装包存储模式无效', 503);
  const origin = updatePublicOrigin(publicOrigin);
  const root = directory ? resolve(directory) : null;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_BYTES) throw new Error('Invalid installer size limit');
  const artifactSchema = `CREATE TABLE IF NOT EXISTS update_artifacts(
    update_id TEXT PRIMARY KEY REFERENCES updates(id) ON DELETE RESTRICT,
    version TEXT NOT NULL,platform TEXT NOT NULL DEFAULT 'win32',arch TEXT NOT NULL DEFAULT 'x64',variant TEXT NOT NULL DEFAULT 'standard',storage_name TEXT NOT NULL UNIQUE,file_name TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,sha256 TEXT NOT NULL DEFAULT '',state TEXT NOT NULL,
    created_at INTEGER NOT NULL,published_once INTEGER NOT NULL DEFAULT 0,oss_key TEXT,
    UNIQUE(platform,arch,variant,version)
  )`;
  // Migrate all release-channel columns and uniqueness together. Legacy records
  // stay in the standard channel; their artifact paths, hashes and IDs survive.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['updates', 'update_artifacts']) {
      if (table === 'update_artifacts') db.exec(artifactSchema);
      for (const [name, value] of [['platform', 'win32'], ['arch', 'x64'], ['variant', 'standard']]) {
        if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name))
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT NOT NULL DEFAULT '${value}'`);
      }
    }
    if (!db.prepare('PRAGMA table_info(update_artifacts)').all().some(column => column.name === 'oss_key')) db.exec('ALTER TABLE update_artifacts ADD COLUMN oss_key TEXT');
    const oldUniqueVersion = db.prepare('PRAGMA index_list(update_artifacts)').all().some(index => {
      const columns = JSON.stringify(db.prepare(`PRAGMA index_info("${index.name.replaceAll('"', '""')}")`).all().map(column => column.name));
      return index.unique && ['["version"]', '["platform","arch","version"]'].includes(columns);
    });
    if (oldUniqueVersion) {
      db.exec('ALTER TABLE update_artifacts RENAME TO update_artifacts_v2');
      db.exec(artifactSchema);
      db.exec(`INSERT INTO update_artifacts(update_id,version,platform,arch,variant,storage_name,file_name,bytes,sha256,state,created_at,published_once,oss_key)
        SELECT update_id,version,platform,arch,variant,storage_name,file_name,bytes,sha256,state,created_at,published_once,oss_key FROM update_artifacts_v2`);
      db.exec('DROP TABLE update_artifacts_v2');
    }
    db.exec("DROP INDEX IF EXISTS updates_app_target_version; CREATE UNIQUE INDEX IF NOT EXISTS updates_app_target_variant_version ON updates(platform,arch,variant,version) WHERE target_type='app'; COMMIT");
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const mirror = storageMode === 'local' ? null : ossStorage ?? ossUpdateStorageFromFile(root ? join(dirname(root), 'update-oss.secure.json') : undefined);
  const uploading = new Set();
  const publishing = new Set(), uploadCompletions = new Set();
  let closed = false;
  const active = new Set();
  const artifact = id => db.prepare('SELECT * FROM update_artifacts WHERE update_id=?').get(id);
  const update = id => db.prepare('SELECT * FROM updates WHERE id=?').get(id);
  const filePath = entry => {
    if (!root || !/^[a-f0-9-]{36}\.(?:exe|deb)$/.test(entry.storage_name)) fail('安装包存储配置无效', 503);
    const path = resolve(root, entry.storage_name);
    if (path !== join(root, entry.storage_name)) fail('安装包存储路径无效', 503);
    return path;
  };
  const urlFor = (entry, version = entry.version) => mirror && entry.oss_key ? mirror.downloadUrl(entry.oss_key)
    : origin ? `${origin}/api/releases/${entry.update_id}/${encodeURIComponent(entry.file_name ?? installerName(version))}` : null;
  const describe = row => {
    const entry = artifact(row.id);
    const target = releaseTarget(row.platform ?? 'win32', row.arch ?? 'x64', row.variant);
    return entry ? { ...row, ...target, url: row.enabled ? urlFor(entry) ?? row.url : row.url, bytes: entry.bytes, fileName: entry.file_name, managed: true,
      status: entry.state === 'uploading' ? 'uploading' : row.enabled ? 'published' : entry.published_once ? 'disabled' : 'draft' }
      : { ...row, ...target, managed: false, status: row.enabled ? 'published' : 'disabled' };
  };
  async function regularFile(entry) {
    const path = filePath(entry), info = await lstat(path).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes) fail('安装包不存在或尺寸已改变，请重新上传新版本', 409);
    return path;
  }
  async function verifyStored(entry) {
    const path = await regularFile(entry), file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const hash = createHash('sha256');
    try { for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk); }
    finally { await file.close(); }
    if (hash.digest('hex') !== entry.sha256) fail('安装包SHA256与已上传文件不一致，拒绝发布', 409);
  }
  function validatePE(prefix, hasNsis) {
    if (prefix.length < 64 || prefix.toString('ascii', 0, 2) !== 'MZ') fail('只允许 Windows NSIS 安装程序（EXE）');
    const position = prefix.readUInt32LE(0x3c);
    if (position < 64 || position + 26 > prefix.length || !prefix.subarray(position, position + 4).equals(Buffer.from([80,69,0,0]))
      || ![0x14c, 0x8664].includes(prefix.readUInt16LE(position + 4)) || ![0x10b,0x20b].includes(prefix.readUInt16LE(position + 24)) || !hasNsis) {
      fail('安装包不是受支持的 Windows NSIS EXE，请上传正式构建产物');
    }
  }
  async function upload(request, response, url, user) {
    if (!root || !origin) fail('请配置 ADMIN_UPDATE_PUBLIC_ORIGIN（或ADMIN_PUBLIC_ORIGIN）及安装包存储目录', 503);
    if (closed) fail('发布服务正在关闭，请稍后重试', 503);
    if (uploading.size >= 2) fail('已有安装包正在上传，请稍后重试', 429);
    const version = url.searchParams.get('version') ?? '', name = url.searchParams.get('filename') ?? '';
    const target = releaseTarget(url.searchParams.get('platform') ?? undefined, url.searchParams.get('arch') ?? undefined, url.searchParams.get('variant') ?? undefined);
    if (!target) fail('发布平台或芯片架构无效');
    const uploadKey = `${target.platform}:${target.arch}:${target.variant ?? 'standard'}:${version}`;
    let notes = url.searchParams.get('notes') ?? '';
    const encodedNotes = request.headers['x-release-notes-base64'];
    if (encodedNotes !== undefined) {
      if (typeof encodedNotes !== 'string' || encodedNotes.length > 6000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedNotes)) fail('更新说明编码无效');
      try { notes = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encodedNotes, 'base64')); }
      catch { fail('更新说明必须为有效UTF-8'); }
    }
    if (!VERSION.test(version) || !isInstallerName(name, version, target.platform, target.arch, target.variant) || notes.length > 1000) fail('版本号、安装包名称或更新说明无效');
    const expected = request.headers['x-content-sha256'];
    if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) fail('客户端SHA256格式无效');
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) < 64)) fail('安装包长度无效');
    if (Number(declared) > maxBytes) fail('安装包超过500MB安全限制', 413);
    const existing = db.prepare("SELECT * FROM updates WHERE target_type='app' AND platform=? AND arch=? AND variant=? AND version=?").get(target.platform, target.arch, target.variant ?? 'standard', version);
    const interrupted = existing && artifact(existing.id);
    // A process crash can leave an uncommitted upload reservation. Only a later authenticated retry
    // may recover it, after the full upload deadline + 2min; ready/ever-published files are never replaced.
    const recoverable = interrupted?.state === 'uploading' && !existing.enabled && !interrupted.published_once
      && interrupted.created_at < now() - uploadTimeoutMs - 120_000;
    if (uploading.has(uploadKey) || existing && !recoverable) fail('该平台及架构的版本已存在，请使用新的版本号，不能替换已发布文件', 409);
    const id = randomUUID(), entry = { update_id: id, storage_name: `${id}.${target.platform === 'linux' ? 'deb' : 'exe'}`, file_name: name, version, ...target };
    const path = filePath(entry), temporary = `${path}.upload`;
    let reserved = false, moved = false, file, length = 0, prefix = Buffer.alloc(0), tail = Buffer.alloc(0), hasNsis = false;
    const hash = createHash('sha256');
    uploading.add(uploadKey); active.add(request);
    let finish;
    const completion = new Promise(resolve => { finish = resolve; }); uploadCompletions.add(completion);
    const timeout = setTimeout(() => request.destroy(Object.assign(new Error('安装包上传超时，请重试'), { status: 408 })), uploadTimeoutMs);
    timeout.unref?.(); request.setTimeout(60_000);
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('安装包存储目录不能为符号链接', 503);
      if (recoverable) {
        const stalePath = filePath(interrupted);
        await unlink(`${stalePath}.upload`).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await unlink(stalePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      transaction(() => {
        if (recoverable) {
          const stale = artifact(existing.id), prior = update(existing.id);
          if (!stale || stale.state !== 'uploading' || stale.published_once || prior?.enabled) fail('原上传状态已变化，请刷新后重试', 409);
          db.prepare('DELETE FROM update_artifacts WHERE update_id=?').run(existing.id);
          db.prepare('DELETE FROM updates WHERE id=?').run(existing.id);
          audit(user, 'update.interrupted_upload_recovered', 'update', existing.id, { version, ...target });
        }
        if (db.prepare("SELECT id FROM updates WHERE target_type='app' AND platform=? AND arch=? AND variant=? AND version=?").get(target.platform, target.arch, target.variant ?? 'standard', version)) fail('该平台及架构的版本已存在，请使用新的版本号', 409);
        db.prepare('INSERT INTO updates(id,target_type,system_id,version,url,sha256,notes,published_at,enabled,platform,arch,variant) VALUES(?,?,?,?,?,?,?,?,0,?,?,?)')
          .run(id, 'app', null, version, urlFor(entry), '', notes, now(), target.platform, target.arch, target.variant ?? 'standard');
        db.prepare('INSERT INTO update_artifacts(update_id,version,storage_name,file_name,state,created_at,platform,arch,variant) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(id, version, entry.storage_name, name, 'uploading', now(), target.platform, target.arch, target.variant ?? 'standard');
      }); reserved = true;
      file = await open(temporary, 'wx', 0o600);
      for await (const chunk of request) {
        if (closed) fail('发布服务正在关闭，上传已取消', 503);
        length += chunk.length;
        if (length > maxBytes) fail('安装包超过500MB安全限制', 413);
        hash.update(chunk);
        if (prefix.length < 1024 * 1024) prefix = Buffer.concat([prefix, chunk.subarray(0, 1024 * 1024 - prefix.length)]);
        if (!hasNsis) {
          const scan = Buffer.concat([tail, chunk]);
          hasNsis = scan.includes(NSIS_MARKER); tail = scan.subarray(Math.max(0, scan.length - NSIS_MARKER.length + 1));
        }
        await file.writeFile(chunk);
      }
      // The 60s idle limit protects an incomplete HTTP upload. Once its body is
      // complete, DEB validation (including repeated XZ scans) and OSS mirroring
      // may run without socket traffic. Keep the original total deadline above.
      request.setTimeout(uploadTimeoutMs);
      if (declared !== undefined && Number(declared) !== length) fail('安装包上传不完整，请重试');
      if (target.platform === 'win32') validatePE(prefix, hasNsis);
      else await validateDebPackage(temporary, version, target.arch, length, target.variant);
      const sha256 = hash.digest('hex');
      if (expected && expected !== sha256) fail('安装包SHA256校验失败，未保留上传文件');
      const current = authorize(request);
      if (!current || current.id !== user.id || current.role !== 'admin' || current.passwordChangeRequired) fail('账号状态已变更，请重新登录后上传', 403);
      await file.sync(); await file.close(); file = null;
      await chmod(temporary, 0o400); await rename(temporary, path); moved = true;
      const ossKey = mirror ? await mirror.ensureUploaded({ path, version, fileName: name, bytes: length, sha256, ...target }) : null;
      if (closed) fail('发布服务正在关闭，上传已取消', 503);
      const latest = authorize(request);
      if (!latest || latest.id !== user.id || latest.role !== 'admin' || latest.passwordChangeRequired) fail('账号状态已变更，请重新登录后上传', 403);
      transaction(() => {
        db.prepare("UPDATE update_artifacts SET bytes=?,sha256=?,state='ready',oss_key=? WHERE update_id=?").run(length, sha256, ossKey, id);
        db.prepare('UPDATE updates SET sha256=? WHERE id=?').run(sha256, id);
        audit(user, 'update.uploaded', 'update', id, { version, ...target, bytes: length, sha256 });
      });
      return describe(update(id));
    } catch (error) {
      if (file) await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      if (moved) await unlink(path).catch(() => {});
      if (reserved) transaction(() => { db.prepare('DELETE FROM update_artifacts WHERE update_id=?').run(id); db.prepare('DELETE FROM updates WHERE id=? AND enabled=0').run(id); });
      if (request.aborted && !error.status) throw Object.assign(new Error('安装包上传已取消，未发布'), { status: 400 });
      throw error;
    } finally { clearTimeout(timeout); uploading.delete(uploadKey); active.delete(request); uploadCompletions.delete(completion); finish(); }
  }
  async function publish(id, enabled, request, user) {
    const entry = artifact(id);
    if (!entry) return false;
    if (entry.state !== 'ready') fail('安装包尚未上传完成，不能发布', 409);
    if (publishing.has(id)) fail('该版本正在校验发布，请等待完成后操作', 409);
    publishing.add(id);
    try {
      let ossKey = entry.oss_key;
      if (enabled) {
        if (!origin) fail('更新公开地址尚未配置', 503);
        await verifyStored(entry);
        if (mirror) ossKey = await mirror.ensureUploaded({ path: await regularFile(entry), version: entry.version,
          fileName: entry.file_name, bytes: entry.bytes, sha256: entry.sha256, platform: entry.platform, arch: entry.arch, variant: entry.variant });
      }
      if (closed) fail('发布服务正在关闭，请稍后重试', 503);
      if (request && user) {
        const current = authorize(request);
        if (!current || current.id !== user.id || current.role !== 'admin' || current.passwordChangeRequired) fail('账号状态已变更，请重新登录', 403);
      }
      transaction(() => {
        if (enabled && ossKey) db.prepare('UPDATE update_artifacts SET oss_key=? WHERE update_id=?').run(ossKey, id);
        db.prepare('UPDATE updates SET enabled=?,url=?,published_at=CASE WHEN ? THEN ? ELSE published_at END WHERE id=?')
          .run(Number(enabled), `${origin}/api/releases/${entry.update_id}/${encodeURIComponent(entry.file_name)}`, Number(enabled), now(), id);
        if (enabled) db.prepare('UPDATE update_artifacts SET published_once=1 WHERE update_id=?').run(id);
      });
      return true;
    } finally { publishing.delete(id); }
  }
  async function serve(request, response, url) {
    const match = url.pathname.match(/^\/api\/releases\/([a-f0-9-]{36})\/([^/]+)$/);
    if (!match || !['GET', 'HEAD'].includes(request.method)) return false;
    let name;
    try { name = decodeURIComponent(match[2]); } catch { return false; }
    if (!installerVersion(name)) return false;
    const entry = artifact(match[1]), row = update(match[1]);
    if (!entry || entry.state !== 'ready' || !row?.enabled || entry.file_name !== name) fail('更新包不存在或尚未发布', 404);
    if (url.searchParams.get('download') === 'oss' && mirror && entry.oss_key) {
      response.writeHead(302, { location: mirror.downloadUrl(entry.oss_key, request.method), 'cache-control': 'no-store' });
      response.end(); return true;
    }
    const path = await regularFile(entry), size = entry.bytes, etag = `"${entry.sha256}"`;
    response.setHeader('content-type', 'application/octet-stream');
    response.setHeader('content-disposition', installerDisposition(entry.file_name, entry.version));
    response.setHeader('cache-control', 'public, max-age=0, must-revalidate');
    response.setHeader('etag', etag); response.setHeader('accept-ranges', 'bytes');
    if (request.headers['if-none-match'] === etag) { response.writeHead(304); response.end(); return true; }
    let start = 0, end = size - 1, status = 200;
    const range = request.headers.range;
    if (range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
      const parts = range.match(/^bytes=(\d*)-(\d*)$/);
      let invalid = !parts || !parts[1] && !parts[2];
      if (!invalid) {
        if (!parts[1]) { const suffix = Number(parts[2]); start = Math.max(0, size - suffix); invalid = !Number.isSafeInteger(suffix) || suffix < 1; }
        else { start = Number(parts[1]); end = parts[2] ? Math.min(Number(parts[2]), size - 1) : size - 1; }
        invalid ||= !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start;
      }
      if (invalid) { response.writeHead(416, { 'content-range': `bytes */${size}` }); response.end(); return true; }
      status = 206; response.setHeader('content-range', `bytes ${start}-${end}/${size}`);
    }
    response.setHeader('content-length', end - start + 1);
    if (request.method === 'HEAD') { response.writeHead(status); response.end(); return true; }
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stream = file.createReadStream({ start, end });
    response.on('close', () => stream.destroy());
    stream.on('error', () => response.destroy()); response.writeHead(status); stream.pipe(response);
    return true;
  }
  return {
    upload, publish, describe, serve,
    manifest(row) {
      const entry = artifact(row.id);
      const target = releaseTarget(row.platform ?? 'win32', row.arch ?? 'x64', row.variant);
      if (!target) return null;
      if (!entry) {
        // An intranet instance must never hand legacy external URLs to a
        // desktop merely because an old release row was imported with its DB.
        if (storageMode === 'local') return null;
        if (target.platform === 'linux') return null;
        // Preserve the legacy Windows external-link response, including its
        // optional MSI/manual-update behavior. Linux requires managed bytes.
        const { id, version, url, sha256, notes } = row; return { id, version, url, sha256, notes };
      }
      if (entry.platform !== target.platform || entry.arch !== target.arch || entry.variant !== (target.variant ?? 'standard')) return null;
      if (entry.state !== 'ready' || !origin) return null;
      return { id: row.id, version: row.version, url: urlFor(entry), sha256: entry.sha256, notes: row.notes, bytes: entry.bytes, fileName: entry.file_name,
        ...target };
    },
    close() {
      closed = true; for (const request of active) request.destroy();
      if (uploadCompletions.size) return Promise.all([...uploadCompletions]);
    },
  };
}
