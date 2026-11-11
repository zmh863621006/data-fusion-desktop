import assert from 'node:assert/strict';
import { open, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { listPackage } from '@electron/asar';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';

const [directory, architecture] = process.argv.slice(2);
assert(directory && ['x64', 'arm64'].includes(architecture), 'Usage: node scripts/verify-linux-package.mjs <directory> <x64|arm64>');
const root = resolve(directory), machine = architecture === 'x64' ? 62 : 183;
for (const name of await readdir(root)) {
  assert(!/\.(exe|dll)$/i.test(name), `Windows resource in Linux package: ${name}`);
  if (name !== 'data-fusion' && name !== 'chrome-sandbox' && name !== 'chrome_crashpad_handler' && !/\.so(?:\.\d+)*$/.test(name)) continue;
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
const wire = await getCurrentFuseWire(join(root, 'data-fusion'));
assert.equal(wire[FuseV1Options.RunAsNode], 48);
assert.equal(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable], 48);
assert.equal(wire[FuseV1Options.EnableNodeCliInspectArguments], 48);
assert.equal(wire[FuseV1Options.OnlyLoadAppFromAsar], 49);
console.log(JSON.stringify({ architecture, elf: 'verified', archive: 'verified', fuses: 'verified', files: files.length }));
