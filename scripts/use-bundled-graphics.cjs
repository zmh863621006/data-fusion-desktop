const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { lstat, readFile, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');

// Keep the compiler shipped by the exact Electron distribution used to build
// this application. Never copy a developer machine's System32 DLL.
module.exports = async function useBundledGraphics(context) {
  if (context.electronPlatformName !== 'win32') return;
  const directory = resolve(context.appOutDir);
  const project = context.packager.projectDir;
  assert.equal(directory, resolve(project, 'release', context.packager.appInfo.version, 'win-unpacked'));
  assert.equal((await lstat(directory)).isSymbolicLink(), false);
  assert((await lstat(join(directory, 'DataFusion.exe'))).isFile());
  assert((await lstat(join(directory, 'resources/app.asar'))).isFile());
  const file = join(directory, 'd3dcompiler_47.dll');
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink());
  const bytes = await readFile(file);
  assert.deepEqual(bytes, await readFile(resolve(project, 'node_modules/electron/dist/d3dcompiler_47.dll')),
    'Bundled graphics compiler must match the official Electron distribution');
  assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
  const offset = bytes.readUInt32LE(60);
  assert(offset >= 64 && offset + 6 <= bytes.length);
  assert.equal(bytes.readUInt32LE(offset), 0x00004550);
  assert.equal(bytes.readUInt16LE(offset + 4), 0x8664);
  await writeFile(join(directory, 'resources/graphics-runtime.json'), JSON.stringify({
    schema: 1, library: 'd3dcompiler_47.dll', provider: 'electron-bundled',
    bundledCompiler: true, installerPreflight: true, sha256: createHash('sha256').update(bytes).digest('hex'),
  }, null, 2), { flag: 'wx' });
  console.log('Official Electron graphics compiler retained in the application.');
};
