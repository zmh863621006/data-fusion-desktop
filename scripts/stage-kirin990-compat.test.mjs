import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inspectArm64Elf, stageKirin990Compatibility } from './stage-kirin990-compat.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const project = resolve('.');
const required = ['gbm_bo_map', 'gbm_bo_unmap', 'gbm_bo_get_fd_for_plane'];

// Synthetic structure-only ELF fixtures. Never executed or distributed.
function elf(symbols, defined = false, machine = 183) {
  const names = Buffer.from('\0' + symbols.join('\0') + '\0');
  const stringsOffset = 256, dynamicOffset = Math.ceil((stringsOffset + names.length) / 8) * 8;
  const buffer = Buffer.alloc(dynamicOffset + (symbols.length + 1) * 24);
  buffer.write('\x7fELF'); buffer[4] = 2; buffer[5] = 1; buffer[6] = 1;
  buffer.writeUInt16LE(3, 16); buffer.writeUInt16LE(machine, 18);
  buffer.writeBigUInt64LE(64n, 40); buffer.writeUInt16LE(64, 58); buffer.writeUInt16LE(3, 60);
  buffer.writeUInt32LE(3, 128 + 4); buffer.writeBigUInt64LE(BigInt(stringsOffset), 128 + 24); buffer.writeBigUInt64LE(BigInt(names.length), 128 + 32);
  buffer.writeUInt32LE(11, 192 + 4); buffer.writeBigUInt64LE(BigInt(dynamicOffset), 192 + 24); buffer.writeBigUInt64LE(BigInt((symbols.length + 1) * 24), 192 + 32);
  buffer.writeUInt32LE(1, 192 + 40); buffer.writeBigUInt64LE(24n, 192 + 56);
  names.copy(buffer, stringsOffset); let nameOffset = 1;
  symbols.forEach((name, index) => { const pos = dynamicOffset + (index + 1) * 24; buffer.writeUInt32LE(nameOffset, pos); buffer[pos + 4] = 0x12; buffer.writeUInt16LE(defined ? 1 : 0, pos + 6); nameOffset += Buffer.byteLength(name) + 1; });
  return buffer;
}

async function fixture(t, symbols = required) {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-kirin990-stage-'));
  t.after(async () => { assert(dirname(directory) === resolve(tmpdir()) && directory.includes('fusion-kirin990-stage-')); await rm(directory, { recursive: true, force: true }); });
  const stage = join(directory, 'stage with spaces'), libraries = join(directory, 'libraries'), application = join(stage, 'opt', 'data-fusion');
  await mkdir(join(application, 'resources'), { recursive: true }); await mkdir(libraries);
  const native = elf(required), library = elf(symbols, true), license = Buffer.from('Synthetic test license fixture; not an upstream resource.\n');
  await writeFile(join(application, 'data-fusion'), native); await writeFile(join(application, 'resources/app.asar'), 'synthetic-asar-fixture');
  await writeFile(join(libraries, 'libgbm.so.1'), library); await writeFile(join(libraries, 'COPYRIGHT.libgbm1'), license);
  const common = { sourceUrl: 'https://ports.ubuntu.com/ubuntu-ports/pool/main/m/mesa/libgbm1_fixture_arm64.deb', packageSha256: '0'.repeat(64), packageName: 'libgbm1', packageVersion: 'fixture', license: 'MIT (synthetic fixture)' };
  const provenance = { schema: 1, variant: 'kirin990-arm64', architecture: 'arm64', files: [
    { ...common, path: 'libgbm.so.1', sha256: digest(library), kind: 'library' },
    { ...common, path: 'COPYRIGHT.libgbm1', sha256: digest(license), kind: 'license' },
  ] };
  const manifest = join(directory, 'provenance.json'); await writeFile(manifest, JSON.stringify(provenance));
  return { directory, stage, libraries, application, native, provenance, manifest, options: { stageRoot: directory } };
}

test('reads actual ELF dynamic definitions and imports, rejects wrong architecture and broken tables', () => {
  assert.deepEqual(inspectArm64Elf(elf(required)).imports, [...required].sort());
  assert.deepEqual(inspectArm64Elf(elf(required, true)).exports, [...required].sort());
  assert.throws(() => inspectArm64Elf(elf(required, true, 62)), /AArch64/);
  const broken = elf(required); broken.writeBigUInt64LE(999999n, 40); assert.throws(() => inspectArm64Elf(broken), /truncated/);
});

test('stages private GBM and licenses without changing native bytes, application data or common builds', async t => {
  const f = await fixture(t); const result = await stageKirin990Compatibility(f.stage, f.libraries, f.manifest, f.options);
  assert.deepEqual(await readFile(join(f.application, 'data-fusion.bin')), f.native);
  assert.equal((await readFile(join(f.application, 'data-fusion'), 'utf8')).startsWith('#!/bin/sh\n'), true);
  const metadata = JSON.parse(await readFile(result.provenance, 'utf8'));
  assert.deepEqual(metadata.requiredGbmSymbols, [...required].sort()); assert.equal(metadata.nativeSha256, digest(f.native));
  assert.equal(metadata.systemLibrariesModified, false); assert.equal(metadata.rendererSandbox, true); assert.equal(metadata.graphicsMode, 'software-x11');
  assert.equal(metadata.files.filter(file => file.kind === 'license').length, 1);
  await assert.rejects(stageKirin990Compatibility(f.stage, f.libraries, f.manifest, f.options), /already staged/);
});

test('blocks real missing-GBM-symbol regressions before touching the stage', async t => {
  const f = await fixture(t, ['gbm_bo_map']);
  await assert.rejects(stageKirin990Compatibility(f.stage, f.libraries, f.manifest, f.options), /gbm_bo_get_fd_for_plane/);
  assert.deepEqual(await readFile(join(f.application, 'data-fusion')), f.native);
  assert.equal(existsSync(join(f.application, 'data-fusion.bin')), false);
});

test('rejects a substituted private library and missing license identity', async t => {
  const f = await fixture(t); await writeFile(join(f.libraries, 'libgbm.so.1'), elf(required, true, 62));
  await assert.rejects(stageKirin990Compatibility(f.stage, f.libraries, f.manifest, f.options), /digest mismatch/);
  await writeFile(join(f.libraries, 'libgbm.so.1'), elf(required, true));
  f.provenance.files = f.provenance.files.filter(file => file.kind !== 'license'); await writeFile(f.manifest, JSON.stringify(f.provenance));
  await assert.rejects(stageKirin990Compatibility(f.stage, f.libraries, f.manifest, f.options), /copyright\/license/);
});

test('rejects traversal and mutation outside a generated staging root', async t => {
  const f = await fixture(t); await assert.rejects(stageKirin990Compatibility(f.stage, f.libraries, f.manifest, { stageRoot: join(f.stage, 'opt') }), /staging root/);
  f.provenance.files[0].path = '../libgbm.so.1'; await writeFile(f.manifest, JSON.stringify(f.provenance));
  await assert.rejects(stageKirin990Compatibility(f.stage, f.libraries, f.manifest, f.options), /flat names/);
});

function bashPath() {
  if (process.platform !== 'win32') return existsSync('/bin/bash') ? '/bin/bash' : null;
  try { const git = execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(Boolean); const bash = resolve(dirname(git), '../bin/bash.exe'); return existsSync(bash) ? bash : null; } catch { return null; }
}
const bash = bashPath();
const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const shellPath = path => process.platform === 'win32' ? path.replace(/^([A-Za-z]):[\\/]/, (_, drive) => '/' + drive.toLowerCase() + '/').replaceAll('\\', '/') : path;

test('launcher preserves spaced paths, Unicode args, process-only loader settings and native exit status', { skip: !bash || process.platform !== 'win32' || !existsSync(compiler) }, async t => {
  const f = await fixture(t), privateDirectory = join(f.application, 'resources/compat/kirin990'); await mkdir(privateDirectory, { recursive: true });
  await writeFile(join(privateDirectory, 'libgbm.so.1'), 'structure-only-library-fixture');
  const launcher = join(f.application, 'data-fusion'); await copyFile(join(project, 'resources/kirin990-launcher.sh'), launcher);
  // A native Windows child records env/argv without attempting to load a Linux
  // shared library into Git Bash. Target-ARM loading is a separate release gate.
  const source = join(f.directory, 'LauncherProbe.cs');
  await writeFile(source, 'using System; using System.Text; class LauncherProbe { static int Main(string[] args) { Console.OutputEncoding=new UTF8Encoding(false); foreach(var key in new[]{"LD_LIBRARY_PATH","LD_PRELOAD","DATA_FUSION_LINUX_COMPAT_VARIANT","LIBGL_ALWAYS_SOFTWARE"}) Console.Write((Environment.GetEnvironmentVariable(key)??"")+"\\0"); foreach(var arg in args)Console.Write(arg+"\\0");return 7;} }');
  execFileSync(compiler, ['/nologo', '/target:exe', '/out:' + join(f.application, 'data-fusion.bin'), source], { windowsHide: true });
  await chmod(launcher, 0o755); await chmod(join(f.application, 'data-fusion.bin'), 0o755);
  const priorLibrary = process.env.LD_LIBRARY_PATH;
  const environment = { ...process.env, LD_LIBRARY_PATH: '/existing library', MSYS2_ENV_CONV_EXCL: 'LD_LIBRARY_PATH;LD_PRELOAD' }; delete environment.LD_PRELOAD;
  const result = spawnSync(bash, ['--noprofile', '--norc', shellPath(launcher), 'file name with spaces.xlsx', '--name=中文', 'semi;colon'], {
    env: environment, windowsHide: true, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 7, result.stderr || result.error?.message);
  const values = result.stdout.split('\0');
  // MSYS translates path-valued variables when it starts a native Windows child.
  assert(values[0].replaceAll('\\', '/').split(';')[0].endsWith('/stage with spaces/opt/data-fusion/resources/compat/kirin990'), JSON.stringify(values));
  assert(values[0].includes('existing library')); assert.equal(values[1], 'libgbm.so.1');
  assert.deepEqual(values.slice(2, -1), ['kirin990-arm64', '1', '--ozone-platform=x11', '--disable-gpu', '--disable-gpu-compositing', 'file name with spaces.xlsx', '--name=中文', 'semi;colon']);
  assert.equal(process.env.LD_LIBRARY_PATH, priorLibrary); assert(!values.includes('--no-sandbox'));
});
