import assert from 'node:assert/strict';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { listPackage } from '@electron/asar';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';

const [directory, architecture, variant] = process.argv.slice(2);
assert(directory && ['x64', 'arm64'].includes(architecture), 'Usage: node scripts/verify-linux-package.mjs <directory> <x64|arm64>');
assert(variant === undefined || variant === '--kirin990' && architecture === 'arm64', 'Unsupported Linux package variant');
const root = resolve(directory), machine = architecture === 'x64' ? 62 : 183;
const nativeName = variant ? 'data-fusion.bin' : 'data-fusion';
if (variant) {
  const metadata = JSON.parse(await readFile(join(root, 'resources/compat/kirin990/provenance.json'), 'utf8'));
  const hash = content => createHash('sha256').update(content).digest('hex');
  const launcher = await readFile(join(root, 'data-fusion'));
  assert.equal(launcher.toString(), (await readFile('resources/kirin990-launcher.sh', 'utf8')).replaceAll('\r\n', '\n'));
  assert.equal(hash(launcher), metadata.launcherSha256);
  assert.equal(metadata.variant, 'kirin990-arm64'); assert.equal(metadata.rendererSandbox, true);
  assert.equal(hash(await readFile(join(root, nativeName))), metadata.nativeSha256);
  for (const file of metadata.files) assert.equal(hash(await readFile(join(root, 'resources/compat/kirin990', file.path))), file.sha256);
}
for (const name of await readdir(root)) {
  assert(!/\.(exe|dll)$/i.test(name), `Windows resource in Linux package: ${name}`);
  if (name !== nativeName && name !== 'chrome-sandbox' && name !== 'chrome_crashpad_handler' && !/\.so(?:\.\d+)*$/.test(name)) continue;
  const file = await open(join(root, name), 'r');
  const header = Buffer.alloc(20);
  try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
  assert.equal(header.subarray(0, 4).toString('hex'), '7f454c46', `Not an ELF binary: ${name}`);
  assert.equal(header[4], 2, `Not ELF64: ${name}`);
  assert.equal(header.readUInt16LE(18), machine, `Wrong Linux architecture: ${name}`);
}
const files = listPackage(join(root, 'resources/app.asar'));
assert(files.some(path => /[\\/]out[\\/]main[\\/]index\.js$/.test(path)), 'Missing main process');
assert(!files.some(path => /(?:^|[\\/])(?:private|admin-server|\.tmp|\.env|tests|__tests__)(?:[\\/]|$)|\.pem$|\.secure\.json$|\.sqlite3?$|\.test\.[cm]?[jt]sx?$/.test(path)), 'Private or development content in application archive');
assert.equal((await stat(join(root, 'resources/icons/app-icon.png'))).isFile(), true);
const wire = await getCurrentFuseWire(join(root, nativeName));
assert.equal(wire[FuseV1Options.RunAsNode], 48);
assert.equal(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable], 48);
assert.equal(wire[FuseV1Options.EnableNodeCliInspectArguments], 48);
assert.equal(wire[FuseV1Options.OnlyLoadAppFromAsar], 49);
console.log(JSON.stringify({ architecture, variant, elf: 'verified', archive: 'verified', fuses: 'verified', files: files.length }));
