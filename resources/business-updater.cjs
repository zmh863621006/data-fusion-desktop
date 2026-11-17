'use strict';

// This module belongs to the immutable shell, never to a downloaded business
// payload. Use raw filesystem bytes even inside Electron's ASAR-patched runtime.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto');
const http = require('node:http'), https = require('node:https');
const { TextDecoder } = require('node:util');
const DEFAULT_FEED_BASE = 'https://shenzhen-sjrh.oss-cn-shenzhen.aliyuncs.com/data-fusion/updates/windows-x64/business/v1/';
const MAX_ASAR_BYTES = 256 * 1024 * 1024, MAX_HEADER_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024, MAX_FILES = 20000, MAX_EXTRACT_BYTES = 512 * 1024 * 1024;
const PRODUCT = 'data-fusion-desktop', ENTRY = 'out/main/index.js';
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const fail = code => Object.assign(new Error(code), { code });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function validVersion(value) { if (typeof value !== 'string' || !SEMVER.test(value)) throw fail('INVALID_VERSION'); return value; }
function compareVersions(a, b) {
  const x = validVersion(a).split('.').map(Number), y = validVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sameManifestContent(left, right) {
  const { url: _left, ...a } = left, { url: _right, ...b } = right;
  return canonical(a) === canonical(b);
}
function strictJson(bytes, max = MAX_MANIFEST_BYTES) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > max) throw fail('JSON_TOO_LARGE');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('INVALID_JSON'); }
  let at = 0, nodes = 0;
  const white = () => { while (/[ \t\r\n]/.test(text[at] || '') && at < text.length) at++; };
  function string() {
    const begin = at++;
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at++] === '"') { try { return JSON.parse(text.slice(begin, at)); } catch { throw fail('INVALID_JSON'); } }
    }
    throw fail('INVALID_JSON');
  }
  function value(depth) {
    if (depth > 128 || ++nodes > 250000) throw fail('INVALID_JSON');
    white(); const c = text[at];
    if (c === '"') return string();
    if (c === '{') {
      at++; white(); const result = {}, keys = new Set();
      if (text[at] === '}') { at++; return result; }
      for (;;) {
        white(); if (text[at] !== '"') throw fail('INVALID_JSON');
        const key = string(); if (keys.has(key)) throw fail('DUPLICATE_JSON_KEY'); keys.add(key);
        white(); if (text[at++] !== ':') throw fail('INVALID_JSON');
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        white(); const next = text[at++]; if (next === '}') return result; if (next !== ',') throw fail('INVALID_JSON');
      }
    }
    if (c === '[') {
      at++; white(); const result = []; if (text[at] === ']') { at++; return result; }
      for (;;) { result.push(value(depth + 1)); white(); const next = text[at++]; if (next === ']') return result; if (next !== ',') throw fail('INVALID_JSON'); }
    }
    for (const [word, result] of [['true', true], ['false', false], ['null', null]]) if (text.slice(at, at + word.length) === word) { at += word.length; return result; }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at));
    if (!number || !Number.isFinite(Number(number[0]))) throw fail('INVALID_JSON');
    at += number[0].length; return Number(number[0]);
  }
  const result = value(0); white(); if (at !== text.length) throw fail('INVALID_JSON'); return result;
}
function validateTarget(target) {
  if (!exact(target, ['platform', 'arch', 'variant', 'electronMajor']) || !['win32', 'linux'].includes(target.platform)
    || !['x64', 'arm64'].includes(target.arch) || !['standard', 'kirin990'].includes(target.variant)
    || ![22, 44].includes(target.electronMajor) || target.platform === 'win32' && target.arch !== 'x64'
    || target.variant === 'kirin990' && (target.platform !== 'linux' || target.arch !== 'arm64')
    || target.electronMajor === 22 && target.platform !== 'win32') throw fail('INVALID_TARGET');
  return target;
}
function sameTarget(a, b) { return ['platform', 'arch', 'variant', 'electronMajor'].every(key => a[key] === b[key]); }
function checkedUrl(value, options, originOnly = false) {
  let url; try { url = new URL(value); } catch { throw fail('INVALID_UPDATE_URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (typeof value !== 'string' || url.username || url.password || url.hash
    || !(url.protocol === 'https:' || options.allowLoopbackHttp === true && local && url.protocol === 'http:')
    || originOnly && (url.origin !== value || url.search)) throw fail('INVALID_UPDATE_URL');
  return url;
}
function feedBase(options) {
  const base = checkedUrl(options.feedBase || DEFAULT_FEED_BASE, options);
  if (base.search || !base.pathname.endsWith('/')) throw fail('INVALID_FEED_BASE'); return base;
}
function manifestUrl(options) {
  const t = validateTarget(options.target); return new URL(`${t.platform}/${t.arch}/${t.variant}/electron-${t.electronMajor}/latest.json`, feedBase(options)).href;
}
function allowedPayloadUrl(value, options) {
  const url = checkedUrl(value, options), base = feedBase(options);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || !url.pathname.endsWith('.asar')) throw fail('PAYLOAD_ORIGIN_MISMATCH');
  return url;
}
function validateBackend(backend, options) {
  if (!exact(backend, ['origin', 'revision']) || !Number.isSafeInteger(backend.revision) || backend.revision < 1) throw fail('INVALID_BACKEND');
  checkedUrl(backend.origin, options, true); return backend;
}
function selectBackend(values, options = {}) {
  let selected;
  for (const value of values.filter(Boolean)) {
    validateBackend(value, options);
    if (!selected || value.revision > selected.revision) selected = value;
    else if (value.revision === selected.revision && value.origin !== selected.origin) throw fail('BACKEND_REVISION_CONFLICT');
  }
  return selected;
}
function notAborted(options) { if (options.signal?.aborted) throw fail('UPDATE_CANCELLED'); }
function payloadIdentity(value, options) {
  if (value.schema !== 1 || value.product !== PRODUCT || !Number.isSafeInteger(value.bytes) || value.bytes < 16 || value.bytes > MAX_ASAR_BYTES
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw fail('INVALID_PAYLOAD');
  validVersion(value.version); validVersion(value.minShellVersion); validateTarget(value.target); validateBackend(value.backend, options);
  if (options.target && !sameTarget(value.target, validateTarget(options.target))) throw fail('TARGET_MISMATCH');
  return value;
}
function validateManifest(envelope, options = {}) {
  if (!exact(envelope, ['algorithm', 'payload', 'signature']) || envelope.algorithm !== 'RSA-SHA256'
    || typeof envelope.payload !== 'string' || !/^[A-Za-z0-9_-]+$/.test(envelope.payload)
    || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]+$/.test(envelope.signature)
    || envelope.payload.length > Math.ceil(MAX_MANIFEST_BYTES * 4 / 3) || envelope.signature.length > 4096) throw fail('INVALID_MANIFEST');
  const bytes = Buffer.from(envelope.payload, 'base64url'), signature = Buffer.from(envelope.signature, 'base64url');
  if (bytes.toString('base64url') !== envelope.payload || signature.toString('base64url') !== envelope.signature) throw fail('INVALID_MANIFEST');
  let key; try { key = crypto.createPublicKey(options.publicKey); } catch { throw fail('INVALID_TRUST_KEY'); }
  if (key.asymmetricKeyType !== 'rsa' || !crypto.verify('RSA-SHA256', bytes, key, signature)) throw fail('INVALID_SIGNATURE');
  const value = strictJson(bytes);
  if (!exact(value, ['schema', 'product', 'version', 'minShellVersion', 'target', 'url', 'bytes', 'sha256', 'backend'])) throw fail('INVALID_MANIFEST');
  payloadIdentity(value, options); allowedPayloadUrl(value.url, options); return value;
}
function normalize(options) {
  if (!options || typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) throw fail('INVALID_UPDATE_DIRECTORY');
  validateTarget(options.target); validVersion(options.baseVersion); validVersion(options.shellVersion); feedBase(options);
  if (options.baseBackend) validateBackend(options.baseBackend, options);
  if (options.signal && (typeof options.signal.aborted !== 'boolean' || typeof options.signal.addEventListener !== 'function')) throw fail('INVALID_ABORT_SIGNAL');
  return { ...options, directory: path.resolve(options.directory) };
}
async function regular(file, maximum = MAX_ASAR_BYTES) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || stat.size < 0) throw fail('INVALID_LOCAL_FILE'); return stat;
}
async function safeDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('INVALID_UPDATE_DIRECTORY');
}
async function prepareDirectory(directory) { await safeDirectory(directory); await safeDirectory(path.join(directory, 'payloads')); }
async function readExact(handle, length, offset) {
  const result = Buffer.alloc(length); let done = 0;
  while (done < length) { const read = await handle.read(result, done, length - done, offset + done); if (!read.bytesRead) throw fail('TRUNCATED_ASAR'); done += read.bytesRead; }
  return result;
}
function component(name) {
  if (!name || name === '.' || name === '..' || name.length > 240 || name !== name.normalize('NFC') || Buffer.from(name, 'utf8').toString('utf8') !== name
    || /[\x00-\x1f\x7f\\/:*?"<>|]/.test(name) || /[. ]$/.test(name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw fail('UNSAFE_ASAR_PATH');
}
async function hashFile(file, options = {}) {
  const hash = crypto.createHash('sha256'); for await (const block of fs.createReadStream(file)) { notAborted(options); hash.update(block); } return hash.digest('hex');
}
async function hashRange(handle, start, size, options = {}) {
  const hash = crypto.createHash('sha256'); let done = 0;
  while (done < size) { notAborted(options); const bytes = await readExact(handle, Math.min(size - done, 128 * 1024), start + done); hash.update(bytes); done += bytes.length; }
  return hash.digest('hex');
}
async function inspectAsar(file, options = {}) {
  notAborted(options);
  const stat = await regular(file); if (stat.size < 16) throw fail('INVALID_ASAR');
  const handle = await fsp.open(file, 'r');
  try {
    const prefix = await readExact(handle, 8, 0), headerBytes = prefix.readUInt32LE(4);
    if (prefix.readUInt32LE(0) !== 4 || headerBytes < 8 || headerBytes > MAX_HEADER_BYTES || headerBytes % 4 || headerBytes + 8 > stat.size) throw fail('INVALID_ASAR_HEADER');
    const raw = await readExact(handle, headerBytes, 8), stringBytes = raw.readUInt32LE(4);
    if (raw.readUInt32LE(0) !== headerBytes - 4 || stringBytes < 2 || 8 + ((stringBytes + 3) & ~3) !== headerBytes
      || raw.subarray(8 + stringBytes).some(value => value !== 0)) throw fail('INVALID_ASAR_HEADER');
    const header = strictJson(raw.subarray(8, 8 + stringBytes), MAX_HEADER_BYTES);
    if (!exact(header, ['files']) || !plain(header.files)) throw fail('INVALID_ASAR_HEADER');
    const files = [], directories = [], names = new Set(); let total = 0, count = 0;
    function visit(entries, parent, depth) {
      if (depth > 64) throw fail('ASAR_LIMIT_EXCEEDED');
      for (const [name, value] of Object.entries(entries)) {
        component(name); const relative = parent ? parent + '/' + name : name, key = relative.toLowerCase();
        if (++count > MAX_FILES || relative.length > 1500 || names.has(key)) throw fail('DUPLICATE_ASAR_PATH'); names.add(key);
        if (!plain(value) || value.link !== undefined || value.unpacked !== undefined && value.unpacked !== false) throw fail('UNSUPPORTED_ASAR_ENTRY');
        if (value.files !== undefined) {
          if (!exact(value, ['files']) || !plain(value.files)) throw fail('INVALID_ASAR_DIRECTORY');
          directories.push(relative); visit(value.files, relative, depth + 1); continue;
        }
        if (Object.keys(value).some(key => !['size', 'offset', 'integrity', 'executable', 'unpacked'].includes(key))
          || !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.offset !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value.offset)
          || !Number.isSafeInteger(Number(value.offset))) throw fail('INVALID_ASAR_ENTRY');
        const offset = Number(value.offset); total += value.size;
        if (total > MAX_EXTRACT_BYTES || offset + value.size > stat.size - 8 - headerBytes || !Number.isSafeInteger(offset + value.size)) throw fail('ASAR_LIMIT_EXCEEDED');
        files.push({ path: relative, size: value.size, offset });
      }
    }
    visit(header.files, '', 0);
    let end = 0;
    for (const entry of files.filter(item => item.size > 0).sort((a, b) => a.offset - b.offset)) {
      if (entry.offset !== end) throw fail('ASAR_OFFSET_OVERLAP_OR_GAP'); end += entry.size;
    }
    if (end !== stat.size - 8 - headerBytes) throw fail('ASAR_TRAILING_DATA');
    const metadataEntry = files.find(item => item.path === 'business.json');
    if (!metadataEntry || metadataEntry.size > MAX_MANIFEST_BYTES || !files.some(item => item.path === ENTRY)) throw fail('MISSING_BUSINESS_METADATA');
    const dataOffset = 8 + headerBytes;
    const metadata = strictJson(await readExact(handle, metadataEntry.size, dataOffset + metadataEntry.offset));
    for (const entry of files) entry.sha256 = await hashRange(handle, dataOffset + entry.offset, entry.size, options);
    return { bytes: stat.size, sha256: await hashFile(file, options), metadata, files, directories, dataOffset };
  } finally { await handle.close(); }
}
function validateBusinessMetadata(metadata, manifest, options) {
  if (!exact(metadata, ['schema', 'product', 'version', 'minShellVersion', 'target', 'backend', 'entry']) || metadata.entry !== ENTRY
    || metadata.schema !== 1 || metadata.product !== PRODUCT || metadata.version !== manifest.version || metadata.minShellVersion !== manifest.minShellVersion
    || !sameTarget(validateTarget(metadata.target), manifest.target) || !exact(metadata.backend, ['origin', 'revision'])
    || metadata.backend.origin !== manifest.backend.origin || metadata.backend.revision !== manifest.backend.revision) throw fail('BUSINESS_METADATA_MISMATCH');
  validateBackend(metadata.backend, options);
}
async function validateTree(root, inspection, options = {}) {
  const expected = new Map(inspection.files.map(entry => [entry.path, entry])), dirs = new Set(inspection.directories), seen = new Set();
  const stat = await fsp.lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('INVALID_PAYLOAD_DIRECTORY');
  async function visit(directory, relative) {
    for (const item of await fsp.readdir(directory, { withFileTypes: true })) {
      notAborted(options);
      const name = relative ? relative + '/' + item.name : item.name, file = path.join(directory, item.name), info = await fsp.lstat(file);
      if (info.isSymbolicLink()) throw fail('PAYLOAD_CACHE_CHANGED');
      if (info.isDirectory()) { if (!dirs.has(name)) throw fail('PAYLOAD_CACHE_CHANGED'); seen.add(name); await visit(file, name); }
      else {
        const entry = expected.get(name);
        if (!info.isFile() || !entry || info.size !== entry.size || await hashFile(file, options) !== entry.sha256) throw fail('PAYLOAD_CACHE_CHANGED'); seen.add(name);
      }
    }
  }
  await visit(root, ''); if (seen.size !== expected.size + dirs.size) throw fail('PAYLOAD_CACHE_CHANGED');
}
function payloadLocation(directory, manifest) {
  const folder = path.join(directory, 'payloads', `${manifest.version}-${manifest.sha256.slice(0, 16)}`);
  return { folder, root: path.join(folder, 'app'), asarFile: path.join(folder, 'business.asar') };
}
async function quarantinePayload(directory, manifest, expected) {
  const location = payloadLocation(directory, manifest);
  if (path.dirname(location.folder) !== path.join(directory, 'payloads')) throw fail('INVALID_UPDATE_DIRECTORY');
  let current; try { current = await fsp.lstat(location.folder); } catch (error) { if (error.code === 'ENOENT' && !expected) return undefined; throw error; }
  if (!current.isDirectory() || current.isSymbolicLink() || expected && (current.ino !== expected.ino || current.dev !== expected.dev)) throw fail('UPDATE_STATE_CHANGED');
  const quarantined = path.join(directory, 'payloads', '.quarantine-' + path.basename(location.folder) + '-' + crypto.randomBytes(12).toString('hex'));
  await fsp.rename(location.folder, quarantined); return quarantined;
}
async function copyRaw(source, destination, options) {
  const input = await fsp.open(source, 'r'); let output;
  try { output = await fsp.open(destination, 'wx', 0o600); let offset = 0; for (;;) { notAborted(options); const block = Buffer.alloc(128 * 1024), result = await input.read(block, 0, block.length, offset); if (!result.bytesRead) break; await output.writeFile(block.subarray(0, result.bytesRead)); offset += result.bytesRead; } await output.sync(); }
  finally { await input.close(); if (output) await output.close(); }
}
async function extractVerifiedPayload(input) {
  const { directory, asarFile, manifest } = input;
  notAborted(input);
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail('INVALID_UPDATE_DIRECTORY');
  payloadIdentity(manifest, input);
  if (input.shellVersion !== undefined) { validVersion(input.shellVersion); compatible(manifest, input); }
  await prepareDirectory(directory);
  if (input.repairCache === true) {
    const lock = await readJson(path.join(directory, '.update.lock'));
    if (!lock || lock.pid !== process.pid) throw fail('UPDATE_BUSY');
  }
  const inspection = await inspectAsar(asarFile, input);
  if (inspection.bytes !== manifest.bytes || inspection.sha256 !== manifest.sha256) throw fail('PAYLOAD_CHECKSUM_MISMATCH');
  validateBusinessMetadata(inspection.metadata, manifest, input);
  const location = payloadLocation(directory, manifest);
  let existing;
  try {
    existing = await fsp.lstat(location.folder);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw fail('INVALID_PAYLOAD_DIRECTORY');
    try {
    const members = await fsp.readdir(location.folder); if (members.sort().join(',') !== 'app,business.asar') throw fail('PAYLOAD_CACHE_CHANGED');
    const archive = await regular(location.asarFile);
    if (archive.size !== manifest.bytes || await hashFile(location.asarFile, input) !== manifest.sha256) throw fail('PAYLOAD_CACHE_CHANGED');
    await validateTree(location.root, inspection, input); return { ...location, version: manifest.version, manifest };
    } catch (error) {
      if (input.repairCache !== true || error.code === 'UPDATE_CANCELLED') throw error;
    }
  }
  const temporary = await fsp.mkdtemp(path.join(directory, 'payloads', '.stage-'));
  try {
    const root = path.join(temporary, 'app'); await fsp.mkdir(root, { mode: 0o700 });
    for (const relative of inspection.directories.sort((a, b) => a.split('/').length - b.split('/').length)) await fsp.mkdir(path.join(root, ...relative.split('/')), { mode: 0o700 });
    const handle = await fsp.open(asarFile, 'r');
    try {
      for (const entry of inspection.files) {
        notAborted(input);
        const file = path.join(root, ...entry.path.split('/')), output = await fsp.open(file, 'wx', 0o600); let done = 0;
        try { while (done < entry.size) { notAborted(input); const chunk = await readExact(handle, Math.min(entry.size - done, 128 * 1024), inspection.dataOffset + entry.offset + done); await output.writeFile(chunk); done += chunk.length; } await output.sync(); }
        finally { await output.close(); }
      }
    } finally { await handle.close(); }
    await copyRaw(asarFile, path.join(temporary, 'business.asar'), input); await validateTree(root, inspection, input); notAborted(input);
    let quarantined;
    if (existing) {
      quarantined = await quarantinePayload(directory, manifest, existing);
    }
    try { await fsp.rename(temporary, location.folder); }
    catch (error) {
      if (quarantined) {
        try {
          const restored = await fsp.lstat(location.folder).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return null; });
          if (!restored) await fsp.rename(quarantined, location.folder);
        } catch { /* Preserve quarantine if restoration cannot be completed. */ }
      }
      throw error;
    }
    return { ...location, version: manifest.version, manifest, ...(quarantined ? { repaired: true, quarantined } : {}) };
  } finally {
    // Only the unique temporary directory created above is ever removed.
    if (path.dirname(temporary) !== path.join(directory, 'payloads') || !path.basename(temporary).startsWith('.stage-')) throw fail('INVALID_UPDATE_DIRECTORY');
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}
async function ensureBuiltinPayload(input) {
  if (!input || typeof input.directory !== 'string' || !path.isAbsolute(input.directory)) throw fail('INVALID_UPDATE_DIRECTORY');
  await prepareDirectory(input.directory); const unlock = await acquireLock(input.directory);
  try { return await extractVerifiedPayload(input); } finally { await unlock(); }
}
async function readJson(file) {
  try { await regular(file, MAX_MANIFEST_BYTES * 4); return strictJson(await fsp.readFile(file), MAX_MANIFEST_BYTES * 4); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicJson(file, value) {
  const temporary = path.join(path.dirname(file), '.json-' + crypto.randomBytes(12).toString('hex')); let handle;
  try { handle = await fsp.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = null; await fsp.rename(temporary, file); }
  finally { if (handle) await handle.close(); await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function inspectInstalled(input) {
  const options = normalize(input), state = await readJson(path.join(options.directory, 'state.json'));
  if (!state) return undefined;
  if (!exact(state, ['schema', 'current', 'previous']) || state.schema !== 1) throw fail('INVALID_UPDATE_STATE');
  const manifest = validateManifest(state.current, options);
  let previous;
  if (state.previous !== null) {
    previous = validateManifest(state.previous, options); if (compareVersions(previous.version, manifest.version) >= 0) throw fail('INVALID_UPDATE_STATE');
  }
  const backend = selectBackend([options.baseBackend, manifest.backend, previous?.backend], options);
  if (compareVersions(manifest.version, options.baseVersion) <= 0) return { version: manifest.version, manifest, envelope: state.current,
    previous: state.previous, backend, ignoredByBase: true };
  if (compareVersions(manifest.minShellVersion, options.shellVersion) > 0) throw fail('SHELL_UPDATE_REQUIRED');
  if (input.metadataOnly === true) return { version: manifest.version, manifest, envelope: state.current, previous: state.previous, backend, cacheUnchecked: true };
  const location = payloadLocation(options.directory, manifest);
  const result = await extractVerifiedPayload({ ...options, repairCache: false, asarFile: location.asarFile, manifest });
  return { ...result, envelope: state.current, previous: state.previous, backend };
}
function progress(options, phase, values = {}) { try { options.onProgress?.({ phase, ...values }); } catch {} }
function responseFailure(status) { return fail([401, 403, 404, 429].includes(status) || status >= 500 ? 'SERVICE_UNAVAILABLE' : status >= 300 && status < 400 ? 'REDIRECT_REJECTED' : 'HTTP_REJECTED'); }
async function requestBytes(urlValue, options, maximum, consume) {
  notAborted(options);
  const url = checkedUrl(urlValue, options), timeout = options.timeoutMs === undefined ? maximum === MAX_MANIFEST_BYTES ? 15000 : 600000 : options.timeoutMs;
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 600000) throw fail('INVALID_TIMEOUT');
  if (options.fetcher) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout); let received = 0;
    const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
    const wait = work => new Promise((resolve, reject) => {
      const cancelled = () => reject(fail(options.signal?.aborted ? 'UPDATE_CANCELLED' : 'NETWORK_TIMEOUT'));
      if (controller.signal.aborted) return cancelled();
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve(work).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancelled));
    });
    try {
      const response = await wait(options.fetcher(url.href, { redirect: 'error', signal: controller.signal, headers: { 'accept-encoding': 'identity' } }));
      if (!response || response.status !== 200) throw responseFailure(response?.status || 0);
      const header = key => response.headers?.get ? response.headers.get(key) : response.headers?.[key];
      const encoding = header('content-encoding'); if (encoding && encoding !== 'identity') throw fail('ENCODING_REJECTED');
      const length = header('content-length'); if (length !== undefined && length !== null && (!/^\d+$/.test(String(length)) || Number(length) > maximum)) throw fail('PAYLOAD_TOO_LARGE');
      const take = bytes => { notAborted(options); const chunk = Buffer.from(bytes); received += chunk.length; if (received > maximum) throw fail('PAYLOAD_TOO_LARGE'); consume(chunk, received); };
      if (response.body?.getReader) { const reader = response.body.getReader(); try { for (;;) { const result = await wait(reader.read()); if (result.done) break; take(result.value); } } finally { void reader.cancel().catch(() => {}); } }
      else if (response.body) { const iterator = response.body[Symbol.asyncIterator](); try { for (;;) { const result = await wait(iterator.next()); if (result.done) break; take(result.value); } } finally { void Promise.resolve(iterator.return?.()).catch(() => {}); } }
      else if (response.arrayBuffer) take(await wait(response.arrayBuffer()));
      else throw fail('PARTIAL_DOWNLOAD');
      if (length !== undefined && length !== null && Number(length) !== received) throw fail('PARTIAL_DOWNLOAD'); return received;
    } catch (error) { if (options.signal?.aborted) throw fail('UPDATE_CANCELLED'); if (/^[A-Z_]+$/.test(error.code || '')) throw error; throw fail(controller.signal.aborted ? 'NETWORK_TIMEOUT' : 'NETWORK_ERROR'); }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  }
  return new Promise((resolve, reject) => {
    let received = 0, settled = false, timer;
    const abort = () => { done(fail('UPDATE_CANCELLED')); request.destroy(); };
    const done = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const request = (url.protocol === 'https:' ? https : http).get(url, { headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity' } }, response => {
      if (response.statusCode !== 200) { response.destroy(); done(responseFailure(response.statusCode)); return; }
      const length = response.headers['content-length'], encoding = response.headers['content-encoding'];
      if (encoding && encoding !== 'identity') { response.destroy(); done(fail('ENCODING_REJECTED')); return; }
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) { response.destroy(); done(fail('PAYLOAD_TOO_LARGE')); return; }
      response.on('data', chunk => { try { received += chunk.length; if (received > maximum) throw fail('PAYLOAD_TOO_LARGE'); consume(chunk, received); } catch (error) { response.destroy(); done(error); } });
      response.on('end', () => { if (!response.complete || length !== undefined && Number(length) !== received) done(fail('PARTIAL_DOWNLOAD')); else done(null, received); });
      response.on('aborted', () => done(fail('PARTIAL_DOWNLOAD'))); response.on('error', () => done(fail('NETWORK_ERROR')));
    });
    request.on('error', () => done(fail('NETWORK_ERROR')));
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    timer = setTimeout(() => { done(fail('NETWORK_TIMEOUT')); request.destroy(); }, timeout);
  });
}
async function fetchManifest(options) {
  const chunks = []; await requestBytes(manifestUrl(options), options, MAX_MANIFEST_BYTES, chunk => chunks.push(chunk));
  const envelope = strictJson(Buffer.concat(chunks)); validateManifest(envelope, options); return envelope;
}
async function acquireLock(directory) {
  const file = path.join(directory, '.update.lock'), value = JSON.stringify({ pid: process.pid, nonce: crypto.randomBytes(16).toString('hex') });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const handle = await fsp.open(file, 'wx', 0o600); try { await handle.writeFile(value); } finally { await handle.close(); }
      return async () => { if ((await fsp.readFile(file, 'utf8').catch(() => '')) === value) await fsp.unlink(file); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const before = await regular(file, MAX_MANIFEST_BYTES);
      const lock = await readJson(file); if (!exact(lock, ['pid', 'nonce']) || !Number.isInteger(lock.pid) || lock.pid <= 0) throw fail('UPDATE_BUSY');
      try { process.kill(lock.pid, 0); throw fail('UPDATE_BUSY'); } catch (cause) { if (cause.code !== 'ESRCH') throw fail('UPDATE_BUSY'); }
      const latest = await readJson(file), after = await regular(file, MAX_MANIFEST_BYTES);
      if (!latest || latest.pid !== lock.pid || latest.nonce !== lock.nonce || before.ino !== after.ino || before.dev !== after.dev) throw fail('UPDATE_BUSY');
      await fsp.unlink(file);
    }
  }
  throw fail('UPDATE_BUSY');
}
function compatible(manifest, options) { if (compareVersions(manifest.minShellVersion, options.shellVersion) > 0) throw fail('SHELL_UPDATE_REQUIRED'); }
async function installPayload(envelope, options) {
  const manifest = validateManifest(envelope, options), location = payloadLocation(options.directory, manifest);
  // A repair always obtains a complete verified network payload before isolating
  // the broken directory. A valid cache is reusable; it is never overwritten.
  try { await regular(location.asarFile); return await extractVerifiedPayload({ ...options, repairCache: false, asarFile: location.asarFile, manifest }); }
  catch (error) { if (error.code !== 'ENOENT' && (options.repairCache !== true || error.code === 'UPDATE_CANCELLED')) throw error; }
  const temporary = path.join(options.directory, '.download-' + crypto.randomBytes(12).toString('hex') + '.asar'); let handle;
  try {
    handle = await fsp.open(temporary, 'wx', 0o600); let offset = 0;
    progress(options, 'DOWNLOADING', { version: manifest.version, downloaded: 0, received: 0, total: manifest.bytes });
    await requestBytes(manifest.url, options, manifest.bytes, (chunk, received) => {
      let done = 0; while (done < chunk.length) { const written = fs.writeSync(handle.fd, chunk, done, chunk.length - done, offset); if (!written) throw fail('PAYLOAD_WRITE_FAILED'); done += written; offset += written; }
      progress(options, 'DOWNLOADING', { version: manifest.version, downloaded: received, received, total: manifest.bytes });
    });
    await handle.sync(); await handle.close(); handle = null; progress(options, 'VERIFYING', { version: manifest.version });
    const result = await extractVerifiedPayload({ ...options, asarFile: temporary, manifest }); progress(options, 'INSTALLING', { version: manifest.version }); return result;
  } finally { if (handle) await handle.close(); await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function runStartupUpdate(input) {
  let options, unlock;
  try {
    options = normalize(input); await prepareDirectory(options.directory); unlock = await acquireLock(options.directory);
    notAborted(options);
    let installed, cacheFailure;
    try { installed = await inspectInstalled(options); }
    catch (error) {
      if (options.repairCache !== true || error.code === 'UPDATE_CANCELLED') throw error;
      installed = await inspectInstalled({ ...options, metadataOnly: true });
      if (!installed || installed.ignoredByBase) throw error;
      cacheFailure = error.code || 'PAYLOAD_CACHE_CHANGED';
    }
    const currentVersion = installed && compareVersions(installed.version, options.baseVersion) > 0 ? installed.version : options.baseVersion;
    const backend = selectBackend([options.baseBackend, installed?.backend], options);
    const pendingFile = path.join(options.directory, 'pending.json'); let pending = await readJson(pendingFile);
    if (pending && !cacheFailure && compareVersions(validateManifest(pending, options).version, currentVersion) <= 0) { await fsp.unlink(pendingFile); pending = null; }
    progress(options, 'CHECKING', { version: currentVersion }); let latest;
    try { latest = await fetchManifest(options); }
    catch (error) {
      if (!['NETWORK_ERROR', 'NETWORK_TIMEOUT', 'PARTIAL_DOWNLOAD', 'SERVICE_UNAVAILABLE'].includes(error.code)) throw error;
      if (!pending && !cacheFailure) return { status: 'offline', version: currentVersion, root: installed?.root, manifest: installed?.manifest, backend, code: error.code };
      latest = pending || installed.envelope;
    }
    if (pending) {
      const a = validateManifest(latest, options), b = validateManifest(pending, options), comparison = compareVersions(a.version, b.version);
      if (comparison < 0) latest = pending;
      else if (!comparison && !sameManifestContent(a, b)) throw fail('MANIFEST_CONFLICT');
    }
    if (cacheFailure && compareVersions(validateManifest(latest, options).version, currentVersion) < 0) latest = installed.envelope;
    const manifest = validateManifest(latest, options);
    const nextBackend = selectBackend([backend, manifest.backend], options);
    if (installed && manifest.version === installed.version && !sameManifestContent(manifest, installed.manifest)) throw fail('MANIFEST_CONFLICT');
    if (compareVersions(manifest.version, currentVersion) <= 0 && !cacheFailure) {
      return { status: 'current', version: currentVersion, root: installed?.root, manifest: installed?.manifest, backend: nextBackend };
    }
    if (backend && manifest.backend.revision < backend.revision) throw fail('BACKEND_REVISION_REGRESSION');
    notAborted(options);
    await atomicJson(pendingFile, latest);
    // A signed newer version remains mandatory even when it first needs a newer
    // base shell. Persist the version floor before reporting that incompatibility.
    compatible(manifest, options);
    const result = await installPayload(latest, options);
    notAborted(options);
    const quarantined = cacheFailure && installed.version !== manifest.version
      ? await quarantinePayload(options.directory, installed.manifest) : result.quarantined;
    await atomicJson(path.join(options.directory, 'state.json'), { schema: 1, current: latest,
      previous: installed && installed.version === manifest.version ? installed.previous : installed?.envelope || null });
    await fsp.unlink(pendingFile); progress(options, 'READY', { version: manifest.version });
    return { status: 'updated', version: manifest.version, root: result.root, asarFile: result.asarFile, manifest, backend: nextBackend,
      ...(result.repaired || cacheFailure ? { repaired: true, ...(quarantined ? { quarantined } : {}) } : {}) };
  } catch (error) { return { status: 'blocked', code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'UPDATE_FAILED' }; }
  finally { if (unlock) await unlock(); }
}
module.exports = { DEFAULT_FEED_BASE, MAX_ASAR_BYTES, MAX_MANIFEST_BYTES, PRODUCT, ENTRY, compareVersions, validateTarget, validateManifest,
  validateBusinessMetadata, manifestUrl, inspectAsar, extractVerifiedPayload, ensureBuiltinPayload, inspectInstalled, runStartupUpdate, strictJson, selectBackend };
