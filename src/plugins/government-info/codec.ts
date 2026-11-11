import { randomInt } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const BASE64_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-~';

function checksum(value: string): string {
  let hash = 1369;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    hash = (hash + (hash << 5) + value.charCodeAt(index)) | 0;
  }
  let positive = hash & 0x7fffffff;
  let result = '';
  do {
    result += BASE64_TABLE[positive & 63];
    positive >>= 6;
  } while (positive !== 0);
  return result;
}

function randomString(length: number): string {
  return Array.from({ length }, () => BASE64_TABLE[randomInt(BASE64_TABLE.length)]).join('');
}

function obfuscate(value: string): string {
  const padded = `${randomString(5)}${value}${randomString(5)}`;
  const first = Math.floor(padded.length * 0.25);
  const second = Math.floor(padded.length * 0.75);
  const hash = checksum(padded).padEnd(6, '_');
  return `${padded.slice(0, first)}${hash}${padded.slice(first, second)}${randomString(3)}${padded.slice(second)}`;
}

function deobfuscate(value: string): string {
  if (value.length < 20) throw new Error('综合信息平台响应长度不正确');
  const coreLength = value.length - 9;
  const first = Math.floor(coreLength * 0.25);
  const second = Math.floor(coreLength * 0.75);
  const actualHash = value.slice(first, first + 6);
  const padded = value.slice(0, first)
    + value.slice(first + 6, second + 6)
    + value.slice(second + 9);
  const expectedHash = checksum(padded).padEnd(6, '_');
  if (actualHash !== expectedHash) throw new Error('综合信息平台响应校验失败');
  if (padded.length < 10) throw new Error('综合信息平台响应格式不正确');
  return padded.slice(5, -5);
}

function decodeUrlEncoded(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function jsEscape(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const character = value[index];
    if (/[A-Za-z0-9@*_+./-]/.test(character)) result += character;
    else if (code < 256) result += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
    else result += `%u${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return result;
}

function jsUnescape(value: string): string {
  return value.replace(/%u([0-9a-f]{4})|%([0-9a-f]{2})/gi, (_match, unicode: string | undefined, byte: string | undefined) => (
    String.fromCharCode(Number.parseInt(unicode ?? byte ?? '0', 16))
  ));
}

export function encryptEcsRequest(parameters: string): string {
  const compressed = deflateSync(Buffer.from(parameters, 'utf8'));
  return `a=${obfuscate(compressed.toString('base64'))}`;
}

export function decryptEcsRequest(payload: string): string {
  const encoded = payload.startsWith('a=') ? payload.slice(2) : payload;
  return inflateSync(Buffer.from(deobfuscate(encoded), 'base64')).toString('utf8');
}

/** Data-Type 14 follows the legacy browser escape/encodeURIComponent path and does not use zlib. */
export function encryptEcs14Request(parameters: string): string {
  const encoded = encodeURIComponent(jsEscape(parameters));
  return `a=${obfuscate(Buffer.from(encoded, 'utf8').toString('base64'))}`;
}

export function decryptEcs14Request(payload: string): string {
  const encoded = payload.startsWith('a=') ? payload.slice(2) : payload;
  const escaped = decodeURIComponent(Buffer.from(deobfuscate(encoded), 'base64').toString('utf8'));
  return jsUnescape(escaped);
}

export function decryptEcsResponse(payload: string): string {
  const base64 = deobfuscate(payload.trim()).replace(/-/g, '+').replace(/~/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  const decoded = Buffer.from(base64 + '='.repeat(padding), 'base64');
  let text: string;
  try {
    text = inflateSync(decoded).toString('utf8');
  } catch {
    text = decoded.toString('utf8');
  }
  return decodeUrlEncoded(text);
}
