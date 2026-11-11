import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const installer = resolve(process.argv[2] ?? `release/${version}/数据融合助手-安装包-${version}-x64.exe`);
const skipPortable = process.argv.includes('--skip-portable');
// This bundled full 7-Zip supports the outer NSIS archive; the builder's 7za
// only sees the inner application payload and cannot verify installer helpers.
const sevenZip = resolve('node_modules/electron-winstaller/vendor/7z.exe');
const listing = execFileSync(sevenZip, ['l', '-tNsis', installer], { windowsHide: true, encoding: 'utf8' });
assert(listing.includes('DataFusion.ExportPreserver.exe'));
assert(!listing.includes('export-preservation.ps1'));
const binary = execFileSync(sevenZip, ['x', '-so', '-tNsis', installer, '$PLUGINSDIR\\DataFusion.ExportPreserver.exe'],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
assert.deepEqual(binary, await readFile('resources/DataFusion.ExportPreserver.exe'));
const work = await mkdtemp(join(tmpdir(), 'fusion-packed-preserver-'));
try {
  const helper = join(work, 'DataFusion.ExportPreserver.exe'), install = join(work, '中文安装目录'), backup = join(work, 'backup');
  const innerName = listing.split(/\r?\n/).map(line => line.match(/\$PLUGINSDIR\\[^\r\n]+\.7z$/)?.[0]).find(Boolean);
  assert(innerName, 'No NSIS application archive found');
  const inner = join(work, 'application.7z'), descriptor = openSync(inner, 'wx');
  try { execFileSync(sevenZip, ['x', '-so', '-tNsis', installer, innerName], { windowsHide: true, stdio: ['ignore', descriptor, 'pipe'] }); }
  finally { closeSync(descriptor); }
  const payload = execFileSync(sevenZip, ['l', '-slt', inner], { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert(/^Path = d3dcompiler_47\.dll\r?$/im.test(payload), 'Official compiler is missing from the final NSIS payload');
  assert(payload.includes('graphics-runtime.json'));
  const official = await readFile('node_modules/electron/dist/d3dcompiler_47.dll');
  const bundled = execFileSync(sevenZip, ['x', '-so', '-tNsis', installer, '$PLUGINSDIR\\d3dcompiler_47.dll'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.deepEqual(bundled, official);
  const appGraphics = execFileSync(sevenZip, ['x', '-so', inner, 'd3dcompiler_47.dll'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.deepEqual(appGraphics, official);
  if (!skipPortable) {
    const portable = resolve(`release/${version}/数据融合助手-免安装版-${version}-x64.zip`);
    const portableGraphics = execFileSync(sevenZip, ['x', '-so', portable, 'd3dcompiler_47.dll'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    assert.deepEqual(portableGraphics, official);
  }
  const file = join(install, '导出文件/行政许可 验证.xlsx');
  await writeFile(helper, binary);
  await writeFile(join(work, 'd3dcompiler_47.dll'), bundled);
  const graphics = spawnSync(helper, ['CheckBundledGraphics'], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  assert.equal(graphics.status, 0, graphics.stdout + graphics.stderr);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'packed installer helper probe');
  const environment = { ...process.env, PSExecutionPolicyPreference: 'Restricted', DATA_FUSION_EXPORT_INSTALL: install,
    DATA_FUSION_EXPORT_BACKUP: backup, DATA_FUSION_EXPORT_PREVIOUS_USER: '', DATA_FUSION_EXPORT_PREVIOUS_MACHINE: '' };
  const run = phase => {
    const result = spawnSync(helper, [phase], { windowsHide: true, encoding: 'utf8', env: environment, timeout: 20000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  run('Backup');
  await rm(file);
  run('Restore');
  assert.equal(await readFile(file, 'utf8'), 'packed installer helper probe');
  const report = { status: 'pass', version, actualNsisArtifactInspected: true,
    nativeHelperMatchesBuild: true, nativeHelperSha256: createHash('sha256').update(binary).digest('hex'),
    officialCompilerInPreflightAndPayload: true, portableChecked: !skipPortable, actualGraphicsPreflightPassed: true,
    legacyPowerShellFileNotEmbedded: true, extractedHelperRunsWithScriptsDisabled: true,
    extractedHelperRestoresExports: true, userDataChanged: false };
  const evidence = resolve(`.tmp/installer-qa-${version}`);
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  assert.equal(dirname(resolve(work)), resolve(tmpdir()));
  assert(basename(work).startsWith('fusion-packed-preserver-'));
  await rm(work, { recursive: true, force: true });
}
