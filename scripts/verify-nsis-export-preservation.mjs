import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

const work = await mkdtemp(join(tmpdir(), 'fusion-nsis-preservation-'));
const version = `harness-${basename(work)}`;
const backups = join(process.env.APPDATA, 'data-fusion-desktop/updates/export-backups');
const compiler = process.env.DATA_FUSION_MAKENSIS ?? join(process.env.LOCALAPPDATA,
  'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');
const install = join(work, "应用 O'Brien & [1]"), exports = join(install, '导出文件');
const quote = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
const environment = { ...process.env, PSExecutionPolicyPreference: 'Restricted' };
try {
  await mkdir(exports, { recursive: true });
  await writeFile(join(exports, 'probe.xlsx'), 'export survives old uninstaller');
  const source = `
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Isolated export preservation regression"
OutFile "${quote(join(work, 'installer.exe'))}"
InstallDir "${quote(install)}"
!include LogicLib.nsh
!define VERSION "${version}"
!define INSTALL_REGISTRY_KEY "Software\\DataFusionPreservationTest\\${version}"
!define APP_EXECUTABLE_FILENAME "UnusedFixture.exe"
!define BUILD_RESOURCES_DIR "${quote(resolve('resources'))}"
; Only process discovery is mocked. The production pre/install sections, embedded
; binary, environment transport, nsExec, logging and exit behavior run unchanged.
!macro fixtureFindProcess executable result
  StrCpy \${result} 603
!macroend
!define nsProcess::FindProcess "!insertmacro fixtureFindProcess"
!include "${quote(resolve('resources/nsis-safe-update.nsh'))}"
!insertmacro customHeader
Section
  CreateDirectory "$INSTDIR"
  FileOpen $R4 "$INSTDIR\\after-backup.marker" w
  FileWrite $R4 "The old uninstaller would run here."
  FileClose $R4
  ; Confined to this unique test path, validated by the JS test before launch.
  Delete "$INSTDIR\\导出文件\\probe.xlsx"
  !insertmacro customInstall
SectionEnd
`;
  const nsi = join(work, 'fixture.nsi');
  await writeFile(nsi, '\ufeff' + source);
  execFileSync(compiler, ['/V2', nsi], { windowsHide: true, encoding: 'utf8' });
  assert.equal(dirname(resolve(install)), resolve(work));
  const run = () => spawnSync(join(work, 'installer.exe'), ['/S', `/D=${install}`],
    { windowsHide: true, timeout: 30000, env: environment, encoding: 'utf8' });
  const success = run();
  assert.equal(success.status, 0, success.stdout + success.stderr);
  assert.equal(await readFile(join(exports, 'probe.xlsx'), 'utf8'), 'export survives old uninstaller');
  assert.match(await readFile(join(install, 'after-backup.marker'), 'utf8'), /old uninstaller/);
  await rm(join(install, 'after-backup.marker'));
  const lockSource = join(work, 'lock.cs'), lockerExe = join(work, 'locker.exe');
  await writeFile(lockSource, 'using System; using System.IO; class Lock { static void Main(string[] a) { using(File.Open(a[0],FileMode.Open,FileAccess.Read,FileShare.None)){Console.WriteLine("ready"); Console.ReadLine();} } }');
  execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', '/out:' + lockerExe, lockSource], { windowsHide: true });
  const locker = spawn(lockerExe, [join(exports, 'probe.xlsx')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('Lock fixture did not start')), 10000);
      locker.stdout.once('data', () => { clearTimeout(timer); ready(); });
      locker.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const failure = run();
    assert.equal(failure.status, 21, failure.stdout + failure.stderr);
    await assert.rejects(readFile(join(install, 'after-backup.marker')), { code: 'ENOENT' });
  } finally {
    locker.stdin.end('\n');
    await new Promise(done => { if (locker.exitCode !== null) done(); else locker.once('exit', done); });
  }
  assert.equal(await readFile(join(exports, 'probe.xlsx'), 'utf8'), 'export survives old uninstaller');
  const folders = (await readdir(backups)).filter(name => name.startsWith(version + '-'));
  assert.equal(folders.length, 2);
  const events = await Promise.all(folders.map(async name => ({
    path: join(backups, name), log: await readFile(join(backups, name, 'preservation.log'), 'utf8')
  })));
  const failed = events.find(item => item.log.includes('file_in_use'));
  assert(failed);
  assert.match(await readFile(join(failed.path, 'installer-backup.log'), 'utf8'), /exit=21[\s\S]*file_in_use/);
  assert(events.some(item => item.log.includes('"phase":"Restore","status":"verified"')));
  console.log(JSON.stringify({ status: 'pass', realNsisSections: true, embeddedNativeHelper: true,
    unicodeEnvironmentTransport: true, restrictiveScriptPolicy: true, backupBeforeUninstaller: true,
    restoresAfterSimulatedOldUninstaller: true, failureStopsBeforeUninstaller: true,
    originalExportsUnchangedOnFailure: true, installerFailureLogRetained: true, userDataChanged: false }));
} finally {
  for (const name of await readdir(backups).catch(() => [])) {
    if (!name.startsWith(version + '-')) continue;
    const path = resolve(backups, name);
    assert.equal(dirname(path), resolve(backups));
    await rm(path, { recursive: true, force: true });
  }
  assert.equal(dirname(resolve(work)), resolve(tmpdir()));
  assert(basename(work).startsWith('fusion-nsis-preservation-'));
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
