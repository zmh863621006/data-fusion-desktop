import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

assert.equal(process.platform, 'win32', 'Build the Windows universal installer on Windows');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
assert(/^\d+\.\d+\.\d+$/.test(version));
const root = resolve('release', version);
const modern = join(root, `DataFusion-Modern-Component-${version}-x64.exe`);
const legacy = join(root, 'win7-component', `DataFusion-Win7-Component-${version}-x64.exe`);
const sevenZip = resolve('node_modules/electron-winstaller/vendor/7z.exe');
const artifacts = [];
for (const [track, file] of [['modern', modern], ['legacy', legacy]]) {
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink());
  const content = await readFile(file);
  assert.equal(content.toString('ascii', 0, 2), 'MZ');
  const helper = execFileSync(sevenZip, ['x', '-so', '-tNsis', file, '$PLUGINSDIR\\DataFusion.ExportPreserver.exe'],
    { windowsHide: true, maxBuffer: 1024 * 1024 });
  const expected = await readFile(track === 'legacy'
    ? 'resources/win7-compat/DataFusion.ExportPreserver.exe' : 'resources/DataFusion.ExportPreserver.exe');
  assert.deepEqual(helper, expected, `${track} installer has a stale preservation helper; rebuild this component`);
  if (track === 'legacy') {
    assert(helper.includes(Buffer.from('v2.0.50727')), 'Win7 component must use its built-in CLR2 runtime');
    const config = execFileSync(sevenZip, ['x', '-so', '-tNsis', file, '$PLUGINSDIR\\DataFusion.ExportPreserver.exe.config'],
      { windowsHide: true, maxBuffer: 1024 * 1024 });
    assert.deepEqual(config, await readFile('resources/win7-compat/DataFusion.ExportPreserver.exe.config'));
  }
  artifacts.push({ track, file, bytes: info.size, sha256: createHash('sha256').update(content).digest('hex'),
    preservationRuntime: track === 'legacy' ? 'CLR2-.NET3.5' : 'CLR4', graphicsProvider: 'electron-bundled' });
}
const source = await readFile('resources/nsis-universal.nsi', 'utf8');
assert(!/PreparePrerequisites|nsis-prerequisites|PREREQUISITE_|RunOnce|INSTALLPREREQUISITES/i.test(source),
  'Default universal installer must not install OS/.NET prerequisites');
const outputDirectory = join(root, 'universal');
await mkdir(outputDirectory, { recursive: true });
const output = join(outputDirectory, `数据融合助手-兼容通用安装包-${version}-x64.exe`);
const compiler = join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');
const quote = value => value.replaceAll('$', () => '$$').replaceAll('"', '$\\"');
execFileSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', `/DAPP_VERSION=${version}`, `/DOUTPUT_FILE=${quote(output)}`,
  `/DAPP_ICON=${quote(resolve('resources/app-icon.ico'))}`, `/DMODERN_INSTALLER=${quote(modern)}`,
  `/DLEGACY_INSTALLER=${quote(legacy)}`, resolve('resources/nsis-universal.nsi')],
{ encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
const content = await readFile(output);
assert(content.length < 240 * 1024 * 1024, 'Unexpected universal installer size; do not bundle system updates');
const manifest = { version, file: output, bytes: content.length,
  sha256: createHash('sha256').update(content).digest('hex'), platform: 'win32', arch: 'x64',
  installer: 'nsis', universal: true, authenticode: 'unsigned', components: artifacts,
  prerequisites: [], automaticPrerequisites: false, forcedReboot: false,
  selection: { windows7: 'legacy-CLR2-including-RTM-and-SP1', windows10And11: 'modern' },
  priorTargetedWin7InstallerConfirmedByUser: true, finalUniversalWin7InstallationTested: false, published: false };
await writeFile(join(outputDirectory, 'universal-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ version, output, bytes: manifest.bytes, sha256: manifest.sha256, published: false }));
