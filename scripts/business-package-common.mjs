import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, copyFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_FEED_BASE = 'https://shenzhen-sjrh-desktop-updates.oss-cn-shenzhen.aliyuncs.com/data-fusion/updates/business/v1/';
export const VERSION = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
export function inside(file, directory) {
  const rel = relative(directory, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
export function parseArguments(args, names) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, '');
    assert(args[index]?.startsWith('--') && names.includes(key) && args[index + 1] && !args[index + 1].startsWith('--'), `Invalid option: ${args[index]}`);
    assert(options[key] === undefined, `Duplicate option: ${key}`);
    options[key] = args[index + 1];
  }
  return options;
}
export function checkedVersion(value, label = 'version') {
  assert(typeof value === 'string' && VERSION.test(value), `Invalid ${label}`);
  return value;
}
export function checkedTarget(value) {
  assert(value && ['win32', 'linux'].includes(value.platform) && ['x64', 'arm64'].includes(value.arch)
    && ['standard', 'kirin990'].includes(value.variant) && [22, 44].includes(value.electronMajor), 'Invalid business runtime target');
  assert(value.platform !== 'win32' || value.arch === 'x64' && value.variant === 'standard', 'Windows requires x64 standard target');
  assert(value.variant !== 'kirin990' || value.platform === 'linux' && value.arch === 'arm64', 'Kirin990 requires Linux ARM64');
  assert(value.electronMajor !== 22 || value.platform === 'win32', 'Electron 22 is reserved for the Win7 track');
  return { platform: value.platform, arch: value.arch, variant: value.variant, electronMajor: value.electronMajor };
}
export const laneForTarget = target => `${target.platform}-${target.arch}-${target.variant}-electron-${target.electronMajor}`;
export function checkedBackend(origin, revision) {
  const url = new URL(origin);
  assert(url.protocol === 'https:' && origin === url.origin && !url.username && !url.password, 'Backend must be a complete HTTPS origin');
  assert(Number.isSafeInteger(revision) && revision > 0, 'Invalid backend revision');
  return { origin, revision };
}
export function checkedFeed(value) {
  const url = new URL(value);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('/'), 'Feed base must be a stable HTTPS directory');
  return url.href;
}
export async function ordinary(path, directory = false) {
  const info = await lstat(path);
  assert(!info.isSymbolicLink(), 'Linked path is forbidden');
  assert(directory ? info.isDirectory() : info.isFile(), `Expected an ordinary ${directory ? 'directory' : 'file'}: ${path}`);
  const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  assert.equal(canonical(await realpath(path)), canonical(path), `Reparse path is forbidden: ${path}`);
  return info;
}
export async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const excludedDirectories = new Set(['.git', '.github', '.tmp', 'private', '__tests__', 'test', 'tests', 'benchmark', 'benchmarks', 'example', 'examples', 'coverage']);
const excludedFiles = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml', '.netrc', '.gitconfig', 'npm-debug.log', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
export function excludedPath(name) {
  const parts = name.replaceAll('\\', '/').split('/');
  return parts.some(part => excludedDirectories.has(part) || excludedFiles.has(part) || part.startsWith('.env'))
    || /(?:\.map|\.test\.[^/]+|\.spec\.[^/]+|\.pem|\.secure\.json|\.sqlite(?:3)?(?:-(?:wal|shm))?)$/i.test(name)
    || parts.some(part => part.startsWith('smoke-'));
}
export async function copyTree(source, destination, { skipNodeModules = false } = {}) {
  await ordinary(source, true);
  await mkdir(destination, { recursive: true });
  let count = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (excludedPath(entry.name) || skipNodeModules && entry.name === 'node_modules') continue;
    assert(!entry.isSymbolicLink(), `Linked input is forbidden: ${entry.name}`);
    const src = join(source, entry.name), dest = join(destination, entry.name);
    if (entry.isDirectory()) count += await copyTree(src, dest, { skipNodeModules });
    else {
      await ordinary(src);
      assert(!/\.(?:node|dll|so(?:\.[0-9]+)*|dylib|exe)$/i.test(entry.name), `Native component belongs in the base package: ${entry.name}`);
      await copyFile(src, dest); count++;
    }
  }
  return count;
}
export async function readJson(path, limit = 1024 * 1024) {
  assert((await ordinary(path)).size <= limit, 'JSON metadata is too large');
  return JSON.parse(await readFile(path, 'utf8'));
}
