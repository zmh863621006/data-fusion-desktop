import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
const work = await mkdtemp(join(tmpdir(), 'fusion-export-upgrade-'));
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const helper = resolve(process.argv.includes('--legacy') ? 'resources/win7-compat/DataFusion.ExportPreserver.exe' : 'resources/DataFusion.ExportPreserver.exe');
const run = (phase, install, backup, previous = '', expected = 0, extra = {}) => {
  const result = spawnSync(helper, [phase], { windowsHide: true, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PSExecutionPolicyPreference: 'Restricted', DATA_FUSION_EXPORT_INSTALL: install,
      DATA_FUSION_EXPORT_BACKUP: backup, DATA_FUSION_EXPORT_PREVIOUS_USER: previous,
      DATA_FUSION_EXPORT_PREVIOUS_MACHINE: '', ...extra } });
  assert.equal(result.status, expected, result.stdout + result.stderr);
  return result;
};
// All deletion below is confined to this disposable test directory.
const remove = async path => {
  assert(resolve(path).startsWith(resolve(work) + '\\'));
  await rm(path, { recursive: true, force: true });
};
try {
  // Reproduce the previous installer's failure without changing any policy.
  const restricted = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', resolve('resources/export-preservation.ps1'),
    '-Phase', 'Backup', '-InstallDirectory', join(work, 'policy-probe'), '-BackupDirectory', join(work, 'policy-backup')],
    { windowsHide: true, encoding: 'utf8', env: { ...process.env, PSExecutionPolicyPreference: 'Restricted' } });
  assert.notEqual(restricted.status, 0);
  assert.equal(await stat(join(work, 'policy-backup')).catch(() => null), null);
  const install = join(work, "应用 O'Brien & desktop"), backup = join(work, 'backups/normal');
  const exports = join(install, '导出文件');
  await mkdir(join(exports, 'nested/empty'), { recursive: true });
  const entries = ['行政许可-测试.xlsx', 'nested/许可 [1] & 报告.xlsx', '.hidden.xlsx', 'zero-byte.xlsx'];
  for (const [index, name] of entries.entries()) await writeFile(join(exports, name), index === 3 ? '' : `probe-${index}`);
  const expected = await Promise.all(entries.map(name => readFile(join(exports, name))));
  run('Backup', install, backup);
  await remove(install); // Models the old electron-builder uninstaller's recursive delete.
  await mkdir(install);
  run('Restore', install, backup);
  for (const [index, name] of entries.entries()) assert.deepEqual(await readFile(join(exports, name)), expected[index]);
  assert((await stat(join(exports, 'nested/empty'))).isDirectory());
  assert((await stat(join(backup, 'restored.ok'))).isFile());
  run('Restore', install, backup); // Idempotent, retaining the verified recovery copy.
  run('Backup', install, backup, '', 21);
  run('Backup', install, join(install, 'unsafe-backup'), '', 21);
  await writeFile(join(exports, entries[0]), 'user changed this after installation');
  run('Restore', install, backup, '', 22);
  assert.equal(await readFile(join(exports, entries[0]), 'utf8'), 'user changed this after installation');
  const clean = join(work, 'new-install'), emptyBackup = join(work, 'backups/empty');
  run('Backup', clean, emptyBackup);
  run('Restore', clean, emptyBackup);
  assert.equal(await stat(join(clean, '导出文件')).catch(() => null), null);
  const emptyInstall = join(work, 'empty-export-install'), emptyExportBackup = join(work, 'backups/empty-export');
  await mkdir(join(emptyInstall, '导出文件'), { recursive: true });
  run('Backup', emptyInstall + '\\', emptyExportBackup);
  await remove(emptyInstall);
  run('Restore', emptyInstall + '\\', emptyExportBackup);
  assert((await stat(join(emptyInstall, '导出文件'))).isDirectory());
  const moved = join(work, 'moved-install'), movedBackup = join(work, 'backups/moved');
  run('Backup', moved, movedBackup, install);
  await remove(install);
  run('Restore', moved, movedBackup);
  assert.equal(await readFile(join(moved, '导出文件', entries[0]), 'utf8'), 'user changed this after installation');
  const tampered = JSON.parse(await readFile(join(movedBackup, 'manifest.json'), 'utf8'));
  tampered.entries[0].path = '..\\outside.xlsx';
  await writeFile(join(movedBackup, 'manifest.json'), JSON.stringify(tampered));
  run('Restore', moved, movedBackup, '', 22);
  const conflict = join(work, 'conflict-install');
  await mkdir(join(conflict, '导出文件'), { recursive: true });
  await writeFile(join(conflict, '导出文件', entries[0]), 'different same-name export');
  run('Backup', moved, join(work, 'backups/conflict'), conflict + '\\', 21);
  assert.equal(await readFile(join(conflict, '导出文件', entries[0]), 'utf8'), 'different same-name export');
  const corruptBackup = join(work, 'backups/corrupt');
  run('Backup', conflict, corruptBackup);
  await writeFile(join(corruptBackup, 'files', entries[0]), 'corrupted recovery copy');
  run('Restore', conflict, corruptBackup, '', 22);
  const readonly = join(work, 'readonly-install'), readonlyBackup = join(work, 'backups/readonly');
  await mkdir(join(readonly, '导出文件'), { recursive: true });
  await writeFile(join(readonly, '导出文件', 'readonly.xlsx'), 'readonly probe');
  execFileSync('attrib.exe', ['+R', join(readonly, '导出文件', 'readonly.xlsx')]);
  run('Backup', readonly, readonlyBackup);
  // Node's rm normalizes file attributes in this confined disposable tree.
  await remove(readonly);
  run('Restore', readonly, readonlyBackup);
  run('Restore', readonly, readonlyBackup);
  assert.equal(await readFile(join(readonly, '导出文件', 'readonly.xlsx'), 'utf8'), 'readonly probe');
  const lockSource = join(work, 'lock.cs'), lockExe = join(work, 'lock.exe');
  await writeFile(lockSource, 'using System; using System.IO; class Lock { static void Main(string[] a) { using(File.Open(a[0],FileMode.Open,FileAccess.Read,FileShare.None)){Console.WriteLine("ready"); Console.ReadLine();} } }');
  execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', '/out:' + lockExe, lockSource], { windowsHide: true });
  const lockedBackup = join(work, 'backups/locked');
  const locker = spawn(lockExe, [join(conflict, '导出文件', entries[0])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('Lock fixture did not start')), 10000);
      locker.stdout.once('data', chunk => { clearTimeout(timeout); assert.equal(chunk.toString().trim(), 'ready'); resolveReady(); });
      locker.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    assert.match(run('Backup', conflict, lockedBackup, '', 21).stdout, /file_in_use/);
    const diagnostic = JSON.parse((await readFile(join(lockedBackup, 'preservation.log'), 'utf8')).trim());
    assert.equal(diagnostic.status, 'failed'); assert.equal(diagnostic.code, 'file_in_use');
    assert.equal(await stat(join(lockedBackup, 'manifest.json')).catch(() => null), null);
  } finally {
    locker.stdin.end('\n');
    await new Promise(resolveExit => { if (locker.exitCode !== null) resolveExit(); else locker.once('exit', resolveExit); });
  }
  assert.equal(await readFile(join(conflict, '导出文件', entries[0]), 'utf8'), 'different same-name export');
  const linked = join(work, 'linked-install');
  await mkdir(join(linked, '导出文件'), { recursive: true });
  await symlink(work, join(linked, '导出文件/link'), 'junction');
  run('Backup', linked, join(work, 'backups/linked'), '', 21);
  const nsis = await readFile('resources/nsis-safe-update.nsh', 'utf8');
  assert(!nsis.includes('powershell.exe') && !nsis.includes('ExecutionPolicy'));
  assert(nsis.includes('DataFusion.ExportPreserver.exe'));
  console.log(JSON.stringify({ status: 'pass', nestedAndEmptyDirectories: true, unicodeAndLiteralFileNames: true,
    zeroByteFiles: true, oldUninstallerDeletionSimulated: true, fileHashesPreserved: true, migrationSupported: true,
    recoveryCopyRetained: true, conflictsAndTamperingRejected: true, reparsePointsRejected: true,
    restrictedPowerShellFailureReproduced: true, nativeHelperWorksWithScriptsDisabled: true,
    trailingBackslashesSupported: true, lockedFileDiagnosticRetained: true, readonlyRecoveryIsIdempotent: true,
    securityPoliciesChanged: false, productionDataChanged: false }));
} finally {
  assert.equal(dirname(resolve(work)), resolve(tmpdir()));
  assert(basename(work).startsWith('fusion-export-upgrade-'));
  await rm(work, { recursive: true, force: true });
}
