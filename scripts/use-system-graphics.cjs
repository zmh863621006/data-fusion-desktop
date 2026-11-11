const assert = require('node:assert/strict');
const { lstat, readFile, unlink, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');

// Windows 10/11 provide this API. Keep Windows responsible for servicing it,
// rather than redistributing a copy taken from a developer's System32 folder.
module.exports = async function useSystemGraphics(context) {
  if (context.electronPlatformName !== 'win32') return;
  const directory = resolve(context.appOutDir);
  const expected = resolve(context.packager.projectDir, 'release', context.packager.appInfo.version, 'win-unpacked');
  assert.equal(directory, expected, 'Unexpected graphics packaging output directory');
  assert.equal((await lstat(directory)).isSymbolicLink(), false);
  assert((await lstat(join(directory, 'DataFusion.exe'))).isFile());
  assert((await lstat(join(directory, 'resources/app.asar'))).isFile());
  const library = join(directory, 'd3dcompiler_47.dll');
  const info = await lstat(library);
  assert(info.isFile() && !info.isSymbolicLink(), 'Expected the original bundled compiler file');
  const bytes = await readFile(library);
  assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
  const offset = bytes.readUInt32LE(60);
  assert(offset >= 64 && offset + 6 <= bytes.length);
  assert.equal(bytes.readUInt32LE(offset), 0x00004550);
  assert.equal(bytes.readUInt16LE(offset + 4), 0x8664, 'Only the Windows x64 package is supported');
  await unlink(library);
  await writeFile(join(directory, 'resources/system-graphics.json'), JSON.stringify({
    schema: 1, library: 'D3DCompiler_47.dll', provider: 'windows-system32',
    minimumWindows: '10', bundledCompiler: false, installerPreflight: true,
  }, null, 2), { flag: 'wx' });
  console.log('Windows graphics compiler is supplied by the operating system.');
};
