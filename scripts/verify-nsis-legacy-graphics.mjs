import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile, access } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

const work = await mkdtemp(join(tmpdir(), 'fusion-legacy-graphics-'));
const prefix = `legacy-${basename(work)}`;
const backups = join(process.env.APPDATA, 'data-fusion-desktop/updates/export-backups');
const resources = join(work, 'resources');
const runtime = join(work, '.tmp/win7-runtime/22.3.27/x64');
const modernRuntime = join(work, 'node_modules/electron/dist');
const compiler = join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');
const csc = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const legacyCsc = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v3.5/csc.exe');
const legacyReferences = ['/noconfig', '/reference:System.dll', '/reference:' + join(process.env.SystemRoot,
  'assembly/GAC_MSIL/System.Web.Extensions/3.5.0.0__31bf3856ad364e35/System.Web.Extensions.dll')];
const official = resolve('.tmp/win7-runtime/22.3.27/x64/d3dcompiler_47.dll');
const modernOfficial = resolve('node_modules/electron/dist/d3dcompiler_47.dll');
const quote = text => text.replaceAll('$', '$$').replaceAll('"', '$\\"');
const exists = async path => access(path).then(() => true, () => false);
const cases = [];
try {
  await mkdir(join(resources, 'win7-compat'), { recursive: true }); await mkdir(runtime, { recursive: true });
  await mkdir(modernRuntime, { recursive: true });
  await copyFile(resolve('resources/win7-compat/DataFusion.ExportPreserver.exe.config'), join(resources, 'win7-compat/DataFusion.ExportPreserver.exe.config'));
  const source = await readFile('resources/system-graphics.cs', 'utf8');
  const selector = 'private static string SystemDirectory() { return Environment.SystemDirectory; }';
  assert.equal(source.split(selector).length, 2);
  // The system directory is empty only in this isolated checker build. The
  // shipped binary has no runtime DLL-path override and never changes Windows.
  const checker = join(work, 'checker.cs');
  await writeFile(checker, source.replace(selector, `private static string SystemDirectory() { return @"${join(work, 'empty-system')}"; }`));
  execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll',
    '/out:' + join(resources, 'DataFusion.ExportPreserver.exe'), resolve('resources/export-preserver.cs'), checker], { windowsHide: true });
  const checkerBinary = await readFile(join(resources, 'DataFusion.ExportPreserver.exe'));
  execFileSync(legacyCsc, [...legacyReferences, '/nologo', '/target:exe', '/platform:x64',
    '/out:' + join(resources, 'win7-compat/DataFusion.ExportPreserver.exe'), resolve('resources/export-preserver.cs'), checker], { windowsHide: true });
  const legacyCheckerBinary = await readFile(join(resources, 'win7-compat/DataFusion.ExportPreserver.exe'));
  assert(legacyCheckerBinary.includes(Buffer.from('v2.0.50727')));
  const failedCheckerSource = join(work, 'failed-checker.cs');
  const failedChecker = join(work, 'failed-checker.exe');
  await writeFile(failedCheckerSource, 'class FailedChecker { static int Main() { return unchecked((int)0x80131700); } }');
  execFileSync(legacyCsc, ['/noconfig', '/nologo', '/target:exe', '/platform:x64', '/out:' + failedChecker, failedCheckerSource], { windowsHide: true });
  for (const scenario of ['legacy-valid-system-missing', 'legacy-invalid-stops', 'legacy-checker-failed',
    'modern-valid-system-missing', 'modern-upgrade-old-local', 'modern-invalid-stops', 'modern-checker-failed']) {
    const directory = join(work, scenario); const install = join(directory, '应用 [图形测试]');
    await mkdir(join(install, '导出文件'), { recursive: true });
    await writeFile(join(install, '导出文件/probe.xlsx'), 'export remains intact');
    const previousDll = 'old application compiler sentinel';
    await writeFile(join(install, 'd3dcompiler_47.dll'), previousDll);
    await copyFile(official, join(runtime, 'd3dcompiler_47.dll'));
    await copyFile(modernOfficial, join(modernRuntime, 'd3dcompiler_47.dll'));
    await writeFile(join(resources, 'DataFusion.ExportPreserver.exe'), checkerBinary);
    await writeFile(join(resources, 'win7-compat/DataFusion.ExportPreserver.exe'), legacyCheckerBinary);
    if (scenario === 'legacy-checker-failed') await copyFile(failedChecker, join(resources, 'win7-compat/DataFusion.ExportPreserver.exe'));
    if (scenario === 'modern-checker-failed') await copyFile(failedChecker, join(resources, 'DataFusion.ExportPreserver.exe'));
    if (scenario === 'legacy-invalid-stops') await writeFile(join(runtime, 'd3dcompiler_47.dll'), 'invalid compiler fixture');
    if (scenario === 'modern-invalid-stops') await writeFile(join(modernRuntime, 'd3dcompiler_47.dll'), 'invalid compiler fixture');
    const isLegacy = scenario.startsWith('legacy'); const version = prefix + '-' + scenario;
    const installer = join(directory, 'fixture.exe'); const script = `${installer}.nsi`;
    const nsi = `Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${quote(installer)}"
InstallDir "${quote(install)}"
!include LogicLib.nsh
!define VERSION "${version}"
!define INSTALL_REGISTRY_KEY "Software\\DataFusionLegacyGraphicsTest\\${version}"
!define APP_EXECUTABLE_FILENAME "UnusedFixture.exe"
!define BUILD_RESOURCES_DIR "${quote(resources)}"
${isLegacy ? '!define DATA_FUSION_WIN7_RUNTIME' : ''}
!macro fixtureFindProcess executable result
 StrCpy \${result} 603
!macroend
!define nsProcess::FindProcess "!insertmacro fixtureFindProcess"
!include /CHARSET=UTF8 "${quote(resolve('resources/nsis-safe-update.nsh'))}"
!insertmacro customHeader
Section
 FileOpen $R4 "$INSTDIR\\before-uninstall.marker" w
 FileWrite $R4 "preflight and export backup passed"
 FileClose $R4
 Delete "$INSTDIR\\导出文件\\probe.xlsx"
 File /oname=$INSTDIR\\d3dcompiler_47.dll "${quote(join(isLegacy ? runtime : modernRuntime, 'd3dcompiler_47.dll'))}"
 !insertmacro customInstall
SectionEnd`;
    await writeFile(script, '\ufeff' + nsi);
    execFileSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', script], { windowsHide: true });
    const result = spawnSync(installer, ['/S', `/D=${install}`], { windowsHide: true, timeout: 30000 });
    const success = scenario.includes('valid-system-missing') || scenario === 'modern-upgrade-old-local';
    assert.equal(result.status, success ? 0 : scenario.endsWith('checker-failed') ? 25 : 23, scenario);
    assert.equal(await exists(join(install, 'before-uninstall.marker')), success);
    assert.equal(await readFile(join(install, '导出文件/probe.xlsx'), 'utf8'), 'export remains intact');
    if (success) {
      const expectedHash = createHash('sha256').update(await readFile(isLegacy ? official : modernOfficial)).digest('hex');
      assert.equal(createHash('sha256').update(await readFile(join(install, 'd3dcompiler_47.dll'))).digest('hex'), expectedHash);
    } else {
      assert.equal(await readFile(join(install, 'd3dcompiler_47.dll'), 'utf8'), previousDll);
      const folders = (await readdir(backups)).filter(name => name.startsWith(version + '-'));
      assert.equal(folders.length, 1);
      const log = await readFile(join(backups, folders[0], 'installer-graphics.log'), 'utf8');
      assert(log.includes(`package-version=${version}`));
      assert(log.includes(`graphics-mode=${isLegacy ? 'electron22-bundled' : 'electron-bundled'}`));
      if (scenario.endsWith('checker-failed')) {
        assert(log.includes('error-type=checker-failed'));
        assert(!log.includes('error-type=graphics-runtime'));
        assert(/exit=(?:2148734720|-2146232576)/.test(log));
      } else {
        assert(log.includes('error-type=graphics-runtime'));
        assert(log.includes('load_failed_win32='));
      }
    }
    cases.push({ scenario, exitCode: result.status, exportsPreserved: true });
  }
  const applicationVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
  const evidence = resolve('private/deploy', `universal-${applicationVersion}`); await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'nsis-legacy-graphics.json'), JSON.stringify({ passed: true, realNsisMacros: true,
    systemGraphicsMissingSimulated: true, windowsFilesChanged: false, bundledCompilerRetained: true, cases }, null, 2));
  console.log(JSON.stringify({ passed: true, cases, windowsFilesChanged: false }));
} finally {
  for (const name of await readdir(backups).catch(() => [])) {
    if (!name.startsWith(prefix + '-')) continue;
    const path = resolve(backups, name); assert.equal(dirname(path), resolve(backups)); await rm(path, { recursive: true, force: true });
  }
  assert.equal(dirname(resolve(work)), resolve(tmpdir())); assert(basename(work).startsWith('fusion-legacy-graphics-'));
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
