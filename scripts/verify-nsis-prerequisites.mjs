import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

assert.equal(process.platform, 'win32');
const work = await mkdtemp(join(tmpdir(), 'fusion-prerequisites-'));
const compiler = join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');
const plugins = join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis/nsis-resources-3.4.1/plugins/x86-unicode');
const includes = resolve('node_modules/app-builder-lib/templates/nsis/include');
const registryRoot = `Software\\DataFusionPrerequisiteTests\\${basename(work)}`;
const quote = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
const compile = async (file, source) => {
  const script = `${file}.nsi`;
  await writeFile(script, '\ufeff' + source);
  execFileSync(compiler, ['/V2', script], { encoding: 'utf8', windowsHide: true });
};
const exists = async file => access(file).then(() => true, () => false);
const evidence = [];
try {
  for (const definition of [
    { name: 'ready', sp1: 0, net: 0, expected: 0 },
    { name: 'silent-no-consent', sp1: 1, net: 1, expected: 32, consent: false },
    { name: 'sp1-before-net-and-app', sp1: 1, net: 1, expected: 3010, phase: 'SP1', calls: ['SP1'], resume: true },
    { name: 'net-install-and-recheck', sp1: 0, net: 1, expected: 0, calls: ['NET48'] },
    { name: 'win7-support-before-net', sp1: 0, net: 1, ssu: 1, sha2: 1, expected: 3010, calls: ['SSU', 'SHA2'], phase: 'SHA2', resume: true },
    { name: 'win7-ssu-reboot', sp1: 0, net: 1, ssu: 1, sha2: 1, ssuExit: 3010, expected: 3010, calls: ['SSU'], phase: 'SSU', resume: true },
    { name: 'resume-support-then-net', sp1: 0, net: 1, previous: 'SHA2', expected: 0, calls: ['NET48'] },
    { name: 'resume-sha2-not-ready-no-loop', sp1: 0, net: 1, sha2: 1, previous: 'SHA2', expected: 35 },
    { name: 'resume-ssu-not-ready-no-loop', sp1: 0, net: 1, ssu: 1, previous: 'SSU', expected: 35 },
    { name: 'net-reboot', sp1: 0, net: 1, netExit: 3010, expected: 3010, calls: ['NET48'], phase: 'NET48', resume: true },
    { name: 'resume-sp1-then-net', sp1: 0, net: 1, previous: 'SP1', expected: 0, calls: ['NET48'] },
    { name: 'resume-net-already-ready', sp1: 0, net: 0, previous: 'NET48', expected: 0 },
    { name: 'resume-sp1-not-ready-no-loop', sp1: 1, net: 1, previous: 'SP1', expected: 35 },
    { name: 'resume-net-not-ready-no-loop', sp1: 0, net: 1, previous: 'NET48', expected: 35 },
    { name: 'net-installer-failed', sp1: 0, net: 1, netExit: 1603, expected: 35, calls: ['NET48'] },
    { name: 'net-success-without-installation', sp1: 0, net: 1, noNetChange: true, expected: 35, calls: ['NET48'] },
    { name: 'sp1-integrity-failed', sp1: 1, net: 1, corrupt: 'SP1', expected: 33 },
    { name: 'net-integrity-failed', sp1: 0, net: 1, corrupt: 'NET48', expected: 33 },
    { name: 'ssu-integrity-failed', sp1: 0, net: 1, ssu: 1, corrupt: 'SSU', expected: 33 },
    { name: 'sha2-integrity-failed', sp1: 0, net: 1, sha2: 1, corrupt: 'SHA2', expected: 33 },
    { name: 'elevation-launch-failed', sp1: 0, net: 1, invalidVerb: true, expected: 34 },
  ]) {
    const directory = join(work, definition.name);
    await mkdir(directory);
    const state = join(directory, 'state.ini');
    const calls = join(directory, 'calls.txt');
    const marker = join(directory, 'app-install.marker');
    const registry = `${registryRoot}\\${definition.name}`;
    await writeFile(state, `[environment]\r\nsp1=${definition.sp1}\r\nnet=${definition.net}\r\nssu=${definition.ssu ?? 0}\r\nsha2=${definition.sha2 ?? 0}\r\n`);
    const components = {};
    for (const phase of ['SP1', 'SSU', 'SHA2', 'NET48']) {
      const executable = join(directory, `${phase}.exe`);
      const result = phase === 'NET48' ? definition.netExit ?? 0 : phase === 'SSU' ? definition.ssuExit ?? 0 : 0;
      await compile(executable, `Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${quote(executable)}"
Section
 FileOpen $0 "${quote(calls)}" a
 FileSeek $0 0 END
 FileWrite $0 "${phase}$\\r$\\n"
 FileClose $0
 ${phase === 'NET48' && !definition.noNetChange && [0, 3010].includes(result) ? `WriteINIStr "${quote(state)}" "environment" "net" "0"` : ''}
 ${['SSU', 'SHA2'].includes(phase) && [0, 3010].includes(result) ? `WriteINIStr "${quote(state)}" "environment" "${phase.toLowerCase()}" "0"` : ''}
 SetErrorLevel ${result}
SectionEnd`);
      components[phase] = { file: executable, hash: createHash('sha256').update(await readFile(executable)).digest('hex') };
    }
    const executable = join(directory, 'bootstrap.exe');
    const source = `Unicode true
RequestExecutionLevel user
SilentInstall silent
ManifestSupportedOS all
OutFile "${quote(executable)}"
!addincludedir "${quote(includes)}"
!addplugindir /x86-unicode "${quote(plugins)}"
!include LogicLib.nsh
!include WinVer.nsh
!include FileFunc.nsh
!define APP_VERSION "test"
!define BOOTSTRAP_REGISTRY_KEY "${registry}"
; No test ever registers a real logon action or installs a system component.
!define BOOTSTRAP_RUNONCE_KEY "${registry}\\FakeRunOnce"
!define BOOTSTRAP_CACHE "${quote(join(directory, 'cache'))}"
!define BOOTSTRAP_SHELL_VERB "open"
!define BOOTSTRAP_LAUNCH FixtureLaunch
!define BOOTSTRAP_DETECT FixtureDetect
!define PREREQUISITE_SP1_FILE "${quote(components.SP1.file)}"
!define PREREQUISITE_SP1_SHA256 "${definition.corrupt === 'SP1' ? '0'.repeat(64) : components.SP1.hash}"
!define PREREQUISITE_NET48_FILE "${quote(components.NET48.file)}"
!define PREREQUISITE_NET48_SHA256 "${definition.corrupt === 'NET48' ? '0'.repeat(64) : components.NET48.hash}"
!define PREREQUISITE_SSU_FILE "${quote(components.SSU.file)}"
!define PREREQUISITE_SSU_SHA256 "${definition.corrupt === 'SSU' ? '0'.repeat(64) : components.SSU.hash}"
!define PREREQUISITE_SHA2_FILE "${quote(components.SHA2.file)}"
!define PREREQUISITE_SHA2_SHA256 "${definition.corrupt === 'SHA2' ? '0'.repeat(64) : components.SHA2.hash}"
Var ForwardArguments
!include "${quote(resolve('resources/nsis-prerequisites.nsh'))}"
Function FixtureDetect
 ReadINIStr $MissingSP1 "${quote(state)}" "environment" "sp1"
 ReadINIStr $MissingNet "${quote(state)}" "environment" "net"
 ReadINIStr $MissingSSU "${quote(state)}" "environment" "ssu"
 ReadINIStr $MissingSHA2 "${quote(state)}" "environment" "sha2"
FunctionEnd
Function FixtureLaunch
 ${definition.invalidVerb ? `
 StrCpy $0 "error"
 StrCpy $1 1223
 ` : `
 \${If} $PrerequisitePhase == "SSU"
  StrCpy $PrerequisiteExecutable "${quote(components.SSU.file)}"
 \${ElseIf} $PrerequisitePhase == "SHA2"
  StrCpy $PrerequisiteExecutable "${quote(components.SHA2.file)}"
 \${EndIf}
 Call ExecutePrerequisiteShell
 `}
FunctionEnd
Function .onInit
 SetRegView 32
 ${definition.previous ? `WriteRegStr HKCU "${registry}" "Phase" "${definition.previous}"` : ''}
 \${GetParameters} $ForwardArguments
FunctionEnd
Section
 Call PreparePrerequisites
 FileOpen $0 "${quote(marker)}" w
 FileWrite $0 "application installation reached"
 FileClose $0
 SetErrorLevel 0
SectionEnd`;
    await compile(executable, source);
    const result = spawnSync(executable, ['/S', ...(definition.consent === false ? [] : ['/INSTALLPREREQUISITES']), ...(definition.previous ? ['/RESUME'] : [])],
      { timeout: 60000, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, definition.expected, `${definition.name}: ${result.error ?? ''}`);
    assert.equal(await exists(marker), definition.expected === 0, definition.name);
    const actualCalls = (await readFile(calls, 'utf8').catch(() => '')).trim().split(/\r?\n/).filter(Boolean);
    assert.deepEqual(actualCalls, definition.calls ?? [], definition.name);
    const stored = spawnSync('reg.exe', ['query', `HKCU\\${registry}\\FakeRunOnce`, '/v', 'DataFusionPrerequisites-test'], { encoding: 'utf8', windowsHide: true });
    assert.equal(stored.status === 0, definition.resume ?? false, definition.name);
    if (definition.resume) {
      assert.match(stored.stdout, /\/RESUME \/INSTALLPREREQUISITES/);
      assert(await exists(join(directory, 'cache/Setup.exe')));
    }
    const log = await readFile(join(directory, 'cache/prerequisites.log'), 'utf8');
    if (definition.netExit === 1603) assert.match(log, /exit=1603/);
    evidence.push({ name: definition.name, exit: result.status, calls: actualCalls, appReached: definition.expected === 0, pendingResume: definition.resume ?? false });
  }
  const output = resolve('private/deploy/universal-1.0.21-environment-20261110');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'nsis-prerequisites.json'), JSON.stringify({ passed: true, actualMicrosoftUpdatesExecuted: false,
    realNsisAndHashAndProcessWait: true, realRunOnceModified: false, forcedReboot: false, cases: evidence }, null, 2));
  console.log(JSON.stringify({ passed: true, cases: evidence.length, actualMicrosoftUpdatesExecuted: false }));
} finally {
  spawnSync('reg.exe', ['delete', `HKCU\\${registryRoot}`, '/f'], { encoding: 'utf8', windowsHide: true });
  assert.equal(dirname(resolve(work)), resolve(tmpdir()));
  assert(basename(work).startsWith('fusion-prerequisites-'));
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
