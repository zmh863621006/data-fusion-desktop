import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultStageRoot = join(project, '.tmp', 'kylin-deb');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const contained = (path, root) => { const name = relative(root, path); return name && !name.startsWith('..' + sep) && name !== '..' && !isAbsolute(name); };
const integer = value => { const result = Number(value); assert(Number.isSafeInteger(result) && result >= 0, 'ELF section offset exceeds the supported size'); return result; };
const cstring = (buffer, offset) => { assert(offset < buffer.length, 'Invalid ELF string offset'); const end = buffer.indexOf(0, offset); assert(end >= offset, 'Unterminated ELF string'); return buffer.toString('utf8', offset, end); };

/** Inspect dynamic symbol definitions/imports instead of looking for strings in an ELF. */
export function inspectArm64Elf(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length >= 64, 'Missing ELF64 header');
  assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46', 'Expected ELF, not a script or arbitrary file');
  assert.equal(bytes[4], 2, 'Expected ELF64'); assert.equal(bytes[5], 1, 'Expected little-endian ELF');
  assert.equal(bytes.readUInt16LE(18), 183, 'Expected AArch64 executable/library');
  const offset = integer(bytes.readBigUInt64LE(40)), width = bytes.readUInt16LE(58), count = bytes.readUInt16LE(60);
  assert(width >= 64 && count > 0 && count < 65535 && offset + width * count <= bytes.length, 'ELF section table is missing or truncated');
  const sections = [];
  for (let index = 0; index < count; index++) {
    const pos = offset + index * width;
    const section = { type: bytes.readUInt32LE(pos + 4), offset: integer(bytes.readBigUInt64LE(pos + 24)), size: integer(bytes.readBigUInt64LE(pos + 32)), link: bytes.readUInt32LE(pos + 40), entrySize: integer(bytes.readBigUInt64LE(pos + 56)) };
    if (section.type !== 8) assert(section.offset + section.size <= bytes.length, 'ELF section exceeds file size');
    sections.push(section);
  }
  const imports = new Set(), exports = new Set(), needed = new Set();
  for (const section of sections) {
    if (![6, 11].includes(section.type)) continue;
    const strings = sections[section.link]; assert(strings && strings.type === 3, 'ELF dynamic string table is missing');
    const names = bytes.subarray(strings.offset, strings.offset + strings.size);
    const entrySize = section.entrySize || (section.type === 11 ? 24 : 16);
    assert(entrySize >= (section.type === 11 ? 24 : 16) && section.size % entrySize === 0, 'Invalid ELF dynamic entry size');
    for (let pos = section.offset; pos < section.offset + section.size; pos += entrySize) {
      if (section.type === 6) {
        if (bytes.readBigUInt64LE(pos) === 1n) needed.add(cstring(names, integer(bytes.readBigUInt64LE(pos + 8))));
        continue;
      }
      const binding = bytes[pos + 4] >> 4, visibility = bytes[pos + 5] & 3, nameOffset = bytes.readUInt32LE(pos);
      if (!nameOffset || ![1, 2].includes(binding)) continue;
      const name = cstring(names, nameOffset), defined = bytes.readUInt16LE(pos + 6) !== 0;
      if (!defined && binding === 1) imports.add(name);
      if (defined && [0, 3].includes(visibility)) exports.add(name);
    }
  }
  return { machine: 183, imports: [...imports].sort(), exports: [...exports].sort(), needed: [...needed].sort() };
}

async function ordinaryFile(path) {
  const info = await lstat(path); assert(info.isFile() && !info.isSymbolicLink(), 'Compatibility resources must be ordinary files'); return readFile(path);
}

/** Mutate only a generated DEB staging tree after authentic upstream files have been supplied. */
export async function stageKirin990Compatibility(stagingInput, libraryInput, provenanceInput, options = {}) {
  const stageRoot = await realpath(options.stageRoot ?? defaultStageRoot), staging = await realpath(stagingInput), libraryRoot = await realpath(libraryInput);
  assert(contained(staging, stageRoot), 'Kirin compatibility staging must stay below the generated DEB staging root');
  assert(options.deployment === undefined || options.deployment === 'huizhou-intranet', 'Invalid compatibility deployment');
  const application = join(staging, 'opt', options.deployment === 'huizhou-intranet' ? 'huizhou-data-fusion' : 'data-fusion');
  const nativePath = join(application, 'data-fusion'), renamedPath = join(application, 'data-fusion.bin');
  assert.equal(await realpath(application), application, 'Application staging must not redirect through links');
  assert(!(await lstat(renamedPath).catch(() => null)), 'Compatibility launcher is already staged; use a fresh DEB staging tree');
  const native = await ordinaryFile(nativePath), nativeElf = inspectArm64Elf(native);
  const required = nativeElf.imports.filter(name => name.startsWith('gbm_'));
  assert(required.includes('gbm_bo_map'), 'Expected the known GBM-requiring Electron ARM64 runtime');
  await ordinaryFile(join(application, 'resources', 'app.asar'));
  const provenance = JSON.parse(await ordinaryFile(provenanceInput));
  assert(provenance.schema === 1 && provenance.variant === 'kirin990-arm64' && provenance.architecture === 'arm64', 'Unexpected compatibility provenance target');
  assert(Array.isArray(provenance.files) && provenance.files.length > 0 && provenance.files.length <= 64, 'Missing upstream compatibility file manifest');
  const files = [], names = new Set(); let gbm;
  for (const entry of provenance.files) {
    assert(typeof entry.path === 'string' && basename(entry.path) === entry.path && /^[A-Za-z0-9_.+-]+$/.test(entry.path), 'Compatibility resources must have safe, flat names');
    assert(!names.has(entry.path), 'Duplicate compatibility resource'); names.add(entry.path);
    assert(/^[a-f0-9]{64}$/.test(entry.sha256) && /^https:\/\//.test(entry.sourceUrl ?? '') && /^[a-f0-9]{64}$/.test(entry.packageSha256 ?? ''), 'Missing upstream source identity');
    assert(typeof entry.packageName === 'string' && entry.packageName && typeof entry.packageVersion === 'string' && entry.packageVersion && typeof entry.license === 'string' && entry.license, 'Missing package and license provenance');
    const bytes = await ordinaryFile(join(libraryRoot, entry.path)); assert.equal(hash(bytes), entry.sha256, 'Upstream compatibility file digest mismatch');
    const kind = entry.kind ?? 'library'; assert(['library', 'license'].includes(kind), 'Unsupported compatibility file kind');
    let elf;
    if (kind === 'library') {
      assert(/^lib[A-Za-z0-9_+.-]+\.so(?:\.\d+)*$/.test(entry.path), 'Unexpected private shared-library name');
      assert(!/^(?:libc|libpthread|librt|libm|libdl)\.so|^ld-linux/.test(entry.path), 'Do not bundle or override the system C runtime');
      elf = inspectArm64Elf(bytes);
      if (entry.path === 'libgbm.so.1') gbm = elf;
    } else assert(/COPY|LICENSE|NOTICE/i.test(entry.path), 'License payload needs a recognizable filename');
    files.push({ ...entry, kind, bytes: bytes.length, ...(elf ? { needed: elf.needed } : {}), content: bytes });
  }
  assert(gbm, 'Missing private Mesa libgbm.so.1');
  const missing = required.filter(name => !gbm.exports.includes(name)); assert.equal(missing.length, 0, 'Private GBM lacks required imports: ' + missing.join(', '));
  assert(files.some(entry => entry.kind === 'license'), 'Ship the upstream copyright/license text');
  const launcher = await ordinaryFile(join(project, 'resources', 'kirin990-launcher.sh'));
  assert(launcher.toString('utf8').startsWith('#!/bin/sh\n') && !launcher.includes(13), 'Launcher must use POSIX LF text');
  const destination = join(application, 'resources', 'compat', 'kirin990');
  assert(!(await lstat(destination).catch(() => null)), 'Private compatibility directory already exists');
  await mkdir(destination, { recursive: true });
  for (const entry of files) await writeFile(join(destination, entry.path), entry.content, { flag: 'wx', mode: 0o644 });
  const metadata = { ...provenance, schema: 1, variant: 'kirin990-arm64', architecture: 'arm64',
    files: files.map(({ content, ...entry }) => entry), nativeExecutable: 'data-fusion.bin', nativeSha256: hash(native),
    launcherSha256: hash(launcher), requiredGbmSymbols: required, privateGbmNeeded: gbm.needed,
    systemLibrariesModified: false, rendererSandbox: true, graphicsMode: 'software-x11', autoUpdateVariant: 'manual-test-only' };
  await writeFile(join(destination, 'provenance.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  await rename(nativePath, renamedPath);
  await writeFile(nativePath, launcher, { flag: 'wx', mode: 0o755 });
  return { staging, application, variant: metadata.variant, nativeExecutable: metadata.nativeExecutable,
    libraryCount: files.filter(entry => entry.kind === 'library').length, requiredGbmSymbols: required.length, nativeSha256: metadata.nativeSha256,
    launcherSha256: metadata.launcherSha256, provenance: join(destination, 'provenance.json'), systemLibrariesModified: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 5, 'Usage: node scripts/stage-kirin990-compat.mjs <generated-deb-stage> <verified-flat-library-dir> <provenance.json>');
  console.log(JSON.stringify(await stageKirin990Compatibility(...process.argv.slice(2)), null, 2));
}
