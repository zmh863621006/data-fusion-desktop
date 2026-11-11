import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const installer = resolve(`release/${version}/win7-graphics-test/数据融合助手-Win7安装修复版-${version}-x64.exe`);
const sevenZip = resolve('node_modules/electron-winstaller/vendor/7z.exe');
const work = await mkdtemp(join(tmpdir(), 'fusion-packed-win7-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const extract = name => execFileSync(sevenZip, ['x', '-so', '-tNsis', installer, name], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
try {
  const listing = execFileSync(sevenZip, ['l', '-tNsis', installer], { windowsHide: true, encoding: 'utf8' });
  const binary = extract('$PLUGINSDIR\\DataFusion.ExportPreserver.exe');
  const config = extract('$PLUGINSDIR\\DataFusion.ExportPreserver.exe.config');
  const graphics = extract('$PLUGINSDIR\\d3dcompiler_47.dll');
  assert.deepEqual(binary, await readFile('resources/win7-compat/DataFusion.ExportPreserver.exe'));
  assert(binary.includes(Buffer.from('v2.0.50727')));
  assert.match(config.toString(), /supportedRuntime version="v2\.0\.50727"/);
  assert.deepEqual(graphics, await readFile('.tmp/win7-runtime/22.3.27/x64/d3dcompiler_47.dll'));
  const helper = join(work, 'DataFusion.ExportPreserver.exe');
  await writeFile(helper, binary);
  await writeFile(helper + '.config', config);
  await writeFile(join(work, 'd3dcompiler_47.dll'), graphics);
  const check = spawnSync(helper, ['CheckLegacyGraphics'], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /legacy_bundled_graphics_verified/);
  const install = join(work, '应用 中文目录');
  const backup = join(work, 'backup');
  const file = join(install, '导出文件/行政许可-测试.xlsx');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'verified installer export');
  const env = { ...process.env, DATA_FUSION_EXPORT_INSTALL: install, DATA_FUSION_EXPORT_BACKUP: backup,
    DATA_FUSION_EXPORT_PREVIOUS_USER: '', DATA_FUSION_EXPORT_PREVIOUS_MACHINE: '' };
  for (const phase of ['Backup', 'Restore']) {
    if (phase === 'Restore') await rm(file);
    const result = spawnSync(helper, [phase], { windowsHide: true, encoding: 'utf8', env, timeout: 20000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.equal(await readFile(file, 'utf8'), 'verified installer export');
  const innerName = listing.split(/\r?\n/).map(line => line.match(/\$PLUGINSDIR\\[^\r\n]+\.7z$/)?.[0]).find(Boolean);
  assert(innerName);
  const inner = join(work, 'app.7z');
  const fd = openSync(inner, 'wx');
  try { execFileSync(sevenZip, ['x', '-so', '-tNsis', installer, innerName], { windowsHide: true, stdio: ['ignore', fd, 'pipe'] }); }
  finally { closeSync(fd); }
  const bundledGraphics = execFileSync(sevenZip, ['x', '-so', inner, 'd3dcompiler_47.dll'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.deepEqual(bundledGraphics, graphics);
  const appArchive = execFileSync(sevenZip, ['x', '-so', inner, 'resources/app.asar'], { windowsHide: true, maxBuffer: 96 * 1024 * 1024 });
  assert.deepEqual(appArchive, await readFile(`release/${version}/win7-graphics-test/win-unpacked/resources/app.asar`));
  const packageBytes = await readFile(installer);
  const previous = JSON.parse(await readFile('private/deploy/win7-graphics-1.0.21-20261110/final-artifact.json', 'utf8'));
  assert(packageBytes.length < 90 * 1024 * 1024);
  const result = { version, artifact: installer, bytes: packageBytes.length, sha256: hash(packageBytes),
    actualFailureExit: -2146232576, actualFailureHresult: '0x80131700',
    actualGuestLogRead: true, actualGuestClr2Present: true, actualGuestClr4Absent: true,
    installerHelperRuntimeTarget: 'v2.0.50727', extractedHelperSha256: hash(binary),
    extractedHelperRuntimeOutput: check.stdout.trim(), actualNsisInspected: true,
    extractedHelperBacksUpAndRestoresExports: true, officialGraphicsEmbeddedForPreflightAndRuntime: true,
    applicationArchiveSha256: hash(appArchive), previousPackageSha256: previous.sha256,
    osPrerequisitePackagesIncluded: false, windows7InstallationTested: false,
    actualHost: '10.0.19043', published: false, unsigned: true };
  await writeFile('private/deploy/win7-graphics-1.0.21-20261110/clr2-fixed-artifact.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  assert.equal(dirname(resolve(work)), resolve(tmpdir()));
  assert(basename(work).startsWith('fusion-packed-win7-'));
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
