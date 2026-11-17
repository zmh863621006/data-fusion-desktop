import { open, lstat } from 'node:fs/promises';

export const BUSINESS_MAX_BYTES = 256 * 1024 * 1024;
export const BUSINESS_VERSION = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
// Match the startup verifier: duplicate JSON keys must not publish a payload
// whose identity or file tree is interpreted differently by the client.
function strictJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); let at = 0, nodes = 0;
  const white = () => { while (at < text.length && /[ \t\r\n]/.test(text[at])) at++; };
  function string() {
    const begin = at++;
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at++] === '"') return JSON.parse(text.slice(begin, at));
    }
    fail('业务 ASAR JSON 字符串无效');
  }
  function value(depth) {
    if (depth > 128 || ++nodes > 250_000) fail('业务 ASAR JSON 超过限制');
    white(); const token = text[at];
    if (token === '"') return string();
    if (token === '{') {
      at++; white(); const result = {}, keys = new Set(); if (text[at] === '}') { at++; return result; }
      for (;;) {
        white(); if (text[at] !== '"') fail('业务 ASAR JSON 无效');
        const key = string(); if (keys.has(key)) fail('业务 ASAR JSON 包含重复字段'); keys.add(key);
        white(); if (text[at++] !== ':') fail('业务 ASAR JSON 无效');
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        white(); const next = text[at++]; if (next === '}') return result; if (next !== ',') fail('业务 ASAR JSON 无效');
      }
    }
    if (token === '[') {
      at++; white(); const result = []; if (text[at] === ']') { at++; return result; }
      for (;;) { result.push(value(depth + 1)); white(); const next = text[at++]; if (next === ']') return result; if (next !== ',') fail('业务 ASAR JSON 无效'); }
    }
    for (const [word, result] of [['true', true], ['false', false], ['null', null]]) if (text.slice(at, at + word.length) === word) { at += word.length; return result; }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at));
    if (!number || !Number.isFinite(Number(number[0]))) fail('业务 ASAR JSON 无效');
    at += number[0].length; return Number(number[0]);
  }
  const result = value(0); white(); if (at !== text.length) fail('业务 ASAR JSON 无效'); return result;
}
export function businessTarget(value = {}) {
  if (!plain(value)) return null;
  const { platform, arch, variant = 'standard' } = value, electronMajor = Number(value.electronMajor);
  if (!['win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch) || !['standard', 'kirin990'].includes(variant)
    || ![22, 44].includes(electronMajor) || platform === 'win32' && arch !== 'x64'
    || variant === 'kirin990' && (platform !== 'linux' || arch !== 'arm64') || electronMajor === 22 && platform !== 'win32') return null;
  return { platform, arch, variant, electronMajor };
}
export const businessLane = target => `${target.platform}/${target.arch}/${target.variant}/electron-${target.electronMajor}`;
export const businessFileName = version => `business-${version}.asar`;
export function compareBusinessVersion(a, b) {
  if (!BUSINESS_VERSION.test(a) || !BUSINESS_VERSION.test(b)) fail('业务版本号无效');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}
export function validateBusinessMetadata(value, expected) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'backend,entry,minShellVersion,product,schema,target,version'
    || value.schema !== 1 || value.product !== 'data-fusion-desktop' || !BUSINESS_VERSION.test(value.version)
    || !BUSINESS_VERSION.test(value.minShellVersion) || value.entry !== 'out/main/index.js') fail('业务包版本、产品或入口信息无效');
  const target = businessTarget(value.target);
  if (!target || !exact(value.target, ['platform', 'arch', 'variant', 'electronMajor']) || value.target.electronMajor !== target.electronMajor
    || expected && (value.version !== expected.version || Object.keys(target).some(key => target[key] !== expected.target[key]))) fail('业务包内部目标与发布平台不一致');
  let origin;
  try { origin = new URL(value.backend?.origin); } catch { fail('业务包后台地址无效'); }
  if (!plain(value.backend) || Object.keys(value.backend).length !== 2 || origin.protocol !== 'https:' || origin.origin !== value.backend.origin
    || origin.username || origin.password || !Number.isSafeInteger(value.backend.revision) || value.backend.revision < 1) fail('业务包后台地址或配置修订无效');
  return { schema: 1, product: value.product, version: value.version, minShellVersion: value.minShellVersion, target,
    backend: { origin: origin.origin, revision: value.backend.revision }, entry: value.entry };
}

/** Parse archive metadata as bounded data; never mount, extract or execute uploaded code. */
export async function inspectBusinessAsar(path, expected) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 16 || info.size > BUSINESS_MAX_BYTES) fail('业务 ASAR 大小或文件类型无效');
  const file = await open(path, 'r');
  async function read(position, length) {
    const buffer = Buffer.alloc(length); let done = 0;
    while (done < length) {
      const result = await file.read(buffer, done, length - done, position + done);
      if (!result.bytesRead) fail('业务 ASAR 内容不完整'); done += result.bytesRead;
    }
    return buffer;
  }
  try {
    const size = await read(0, 8), headerBytes = size.readUInt32LE(4);
    if (size.readUInt32LE(0) !== 4 || headerBytes < 8 || headerBytes > 16 * 1024 * 1024 || headerBytes % 4 || headerBytes + 8 > info.size) fail('业务 ASAR 头无效');
    const header = await read(8, headerBytes), jsonBytes = header.readUInt32LE(4);
    if (header.readUInt32LE(0) !== headerBytes - 4 || jsonBytes < 2 || jsonBytes > headerBytes - 8 || headerBytes - 8 - jsonBytes > 3
      || header.subarray(8 + jsonBytes).some(byte => byte !== 0)) fail('业务 ASAR 头长度无效');
    let root; try { root = strictJson(header.subarray(8, 8 + jsonBytes)); }
    catch { fail('业务 ASAR 头不是有效 UTF-8 JSON'); }
    if (!exact(root, ['files']) || !plain(root.files)) fail('业务 ASAR 文件目录无效');
    const entries = [], names = new Set(); let total = 0, count = 0;
    function visit(files, prefix = '', depth = 0) {
      if (!plain(files) || depth > 40) fail('业务 ASAR 目录层级无效');
      for (const [name, value] of Object.entries(files)) {
        if (++count > 20_000 || !name || name.length > 240 || name !== name.normalize('NFC') || Buffer.from(name, 'utf8').toString('utf8') !== name
          || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..' || name.trim() !== name
          || /[. ]$/.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) || !plain(value)) fail('业务 ASAR 路径无效');
        const relative = prefix + name, key = relative.normalize('NFC').toLowerCase();
        if (relative.length > 1500) fail('业务 ASAR 路径过长');
        if (/(?:^|\/)(?:private|\.git|\.tmp)(?:\/|$)|\.secure\.json$|\.sqlite(?:3)?(?:-wal|-shm)?$|(?:^|\/)\.env(?:\.|$)|\.(?:pem|pfx|p12|key|node|dll|exe|so(?:\.\d+)*)$/i.test(relative)) fail('业务包包含用户数据、私钥或应留在基础包中的原生组件');
        if (names.has(key)) fail('业务 ASAR 路径重复'); names.add(key);
        if ('link' in value || value.unpacked !== undefined && value.unpacked !== false) fail('业务包不允许链接或外置 unpacked 载荷');
        if ('files' in value) { if (!exact(value, ['files'])) fail('业务 ASAR 条目类型冲突'); visit(value.files, relative + '/', depth + 1); continue; }
        if (Object.keys(value).some(key => !['size', 'offset', 'integrity', 'executable', 'unpacked'].includes(key))
          || !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.offset !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value.offset)) fail('业务 ASAR 文件范围无效');
        const offset = Number(value.offset), end = offset + value.size;
        total += value.size;
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || end > info.size - headerBytes - 8 || total > 512 * 1024 * 1024) fail('业务 ASAR 文件越界');
        entries.push({ path: relative, offset: 8 + headerBytes + offset, size: value.size });
      }
    }
    visit(root.files);
    let last = 8 + headerBytes;
    for (const entry of entries.filter(entry => entry.size > 0).sort((a, b) => a.offset - b.offset)) { if (entry.offset !== last) fail('业务 ASAR 文件范围重叠或不连续'); last = entry.offset + entry.size; }
    if (last !== info.size) fail('业务 ASAR 包含未声明的末尾内容');
    const metadata = entries.find(entry => entry.path === 'business.json');
    if (!metadata || metadata.size > 64 * 1024 || !entries.some(entry => entry.path === 'out/main/index.js')) fail('业务 ASAR 缺少发布信息或主程序');
    let value; try { value = strictJson(await read(metadata.offset, metadata.size)); }
    catch { fail('业务包发布信息无效'); }
    return { metadata: validateBusinessMetadata(value, expected), entries: entries.length, unpackedBytes: total };
  } finally { await file.close(); }
}
