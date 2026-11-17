import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT, inside, parseArguments, checkedVersion, ordinary, digestFile } from './business-package-common.mjs';

export async function buildBusinessShellUniversal(options) {
  assert.equal(process.platform, 'win32', 'Build the Windows universal installer on Windows');
  const root = resolve(options.projectRoot ?? PROJECT), version = checkedVersion(options.version);
  const modern = resolve(root, options.modern), legacy = resolve(root, options.legacy);
  for (const path of [modern, legacy]) { assert(inside(path, root), 'Installer component must stay in the project'); await ordinary(path); }
  assert(basename(modern).includes(version) && basename(legacy).includes(version), 'Component filenames must identify the selected version');
  const sevenZip = join(root, 'node_modules/electron-winstaller/vendor/7z.exe'); await ordinary(sevenZip);
  const artifacts = [];
  for (const [track, file] of [['modern', modern], ['legacy', legacy]]) {
    const info = await ordinary(file), prefix = await readFile(file); assert.equal(prefix.toString('ascii', 0, 2), 'MZ');
    const helper = execFileSync(sevenZip, ['x', '-so', '-tNsis', file, '$PLUGINSDIR\\DataFusion.ExportPreserver.exe'],
      { windowsHide: true, maxBuffer: 1024 * 1024 });
    assert.deepEqual(helper, await readFile(join(root, track === 'legacy' ? 'resources/win7-compat/DataFusion.ExportPreserver.exe' : 'resources/DataFusion.ExportPreserver.exe')),
      `${track} installer has a stale preservation helper`);
    if (track === 'legacy') {
      assert(helper.includes(Buffer.from('v2.0.50727')), 'Win7 component must use its built-in CLR2 runtime');
      const config = execFileSync(sevenZip, ['x', '-so', '-tNsis', file, '$PLUGINSDIR\\DataFusion.ExportPreserver.exe.config'],
        { windowsHide: true, maxBuffer: 1024 * 1024 });
      assert.deepEqual(config, await readFile(join(root, 'resources/win7-compat/DataFusion.ExportPreserver.exe.config')));
    }
    artifacts.push({ track, file, bytes: info.size, sha256: createHash('sha256').update(prefix).digest('hex'),
      preservationRuntime: track === 'legacy' ? 'CLR2-.NET3.5' : 'CLR4', graphicsProvider: 'electron-bundled' });
  }
  const source = join(root, 'resources/nsis-universal.nsi'), script = await readFile(source, 'utf8');
  assert(!/PreparePrerequisites|nsis-prerequisites|PREREQUISITE_|RunOnce|INSTALLPREREQUISITES/i.test(script), 'Universal bridge must not add OS prerequisite installers');
  const outputDirectory = resolve(root, options.outputRoot ?? join('release', version, 'shell/universal'));
  assert(inside(outputDirectory, root), 'Universal output must stay in the project'); await mkdir(outputDirectory, { recursive: true }); await ordinary(outputDirectory, true);
  const output = join(outputDirectory, `数据融合助手-兼容通用安装包-${version}-x64.exe`);
  const compiler = options.makensis ? resolve(options.makensis) : join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe'); await ordinary(compiler);
  const quote = value => value.replaceAll('$', () => '$$').replaceAll('"', '$\\"');
  execFileSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', `/DAPP_VERSION=${version}`, `/DOUTPUT_FILE=${quote(output)}`,
    `/DAPP_ICON=${quote(join(root, 'resources/app-icon.ico'))}`, `/DMODERN_INSTALLER=${quote(modern)}`,
    `/DLEGACY_INSTALLER=${quote(legacy)}`, source], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const bytes = (await ordinary(output)).size; assert(bytes > 0 && bytes < 240 * 1024 * 1024, 'Unexpected universal size; never bundle system updates');
  const manifest = { schema: 1, version, file: output, bytes, sha256: await digestFile(output), platform: 'win32', arch: 'x64',
    installer: 'nsis', universal: true, authenticode: 'unsigned', components: artifacts, prerequisites: [], automaticPrerequisites: false,
    forcedReboot: false, selection: { windows7: 'legacy-CLR2', windows10And11: 'modern' }, finalUniversalWin7InstallationTested: false, published: false };
  await writeFile(join(outputDirectory, 'universal-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2), ['version', 'modern', 'legacy', 'output-root', 'makensis']);
  assert(args.version && args.modern && args.legacy, 'Provide --version, --modern and --legacy');
  const options = Object.fromEntries(Object.entries(args).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
  console.log(JSON.stringify(await buildBusinessShellUniversal(options)));
}
