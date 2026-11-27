import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir, release } from 'node:os';

assert.equal(process.platform, 'win32');
assert(Number(release().split('.')[0]) >= 10, 'Run the actual-host case on modern Windows');
const work = await mkdtemp(join(tmpdir(), 'fusion-universal-dispatch-'));
const compiler = join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');
const quote = value => value.replaceAll('$', () => '$$').replaceAll('"', '$\\"');
const source = await readFile('resources/nsis-universal.nsi', 'utf8');
const exists = async file => access(file).then(() => true, () => false);
assert(!/AtLeastServicePack|PreparePrerequisites|RunOnce|nsis-prerequisites|powershell|cmd\.exe/i.test(source));
assert(source.indexOf('HideWindow') > source.indexOf('安装组件提取失败'));
assert(source.indexOf('HideWindow') < source.indexOf('ExecWait'));
assert(source.includes('安装程序未能启动'));
const versionBase = 10000 + Math.floor(Math.random() * 40000);
const reports = [];
try {
  for (const [index, scenario] of [
    { name: 'actual-win10', track: 'modern', interactive: true },
    { name: 'win7-7600-rtm', track: 'legacy', conditions: [true, false, true] },
    { name: 'win7-7601-sp1', track: 'legacy', conditions: [true, false, true], interactive: true },
    { name: 'child-cancelled', track: 'modern', childExit: 1602 },
    { name: 'child-launch-failed', track: 'modern', launchError: true },
    { name: 'unsupported-32bit', conditions: [false, true, false] },
    { name: 'unsupported-windows8', conditions: [true, false, false] },
  ].entries()) {
    const directory = join(work, scenario.name);
    await mkdir(directory);
    const version = `0.0.${versionBase + index}`;
    const lifecycle = join(directory, 'lifecycle.ini');
    for (const track of ['modern', 'legacy']) {
      const child = join(directory, `${track}.exe`);
      if (scenario.launchError && track === scenario.track) {
        await writeFile(child, 'Synthetic invalid executable; never an application installer.');
        continue;
      }
      const fixture = `Unicode true
!include "LogicLib.nsh"
RequestExecutionLevel user
Name "Synthetic installation component"
Caption "Synthetic installation component ${version}"
SilentInstall ${scenario.interactive ? 'normal' : 'silent'}
Page instfiles
AutoCloseWindow true
OutFile "${quote(child)}"
Section
 ReadINIStr $2 "${quote(lifecycle)}" "wrapper" "parentHwnd"
 ReadINIStr $4 "${quote(lifecycle)}" "wrapper" "parentPid"
 System::Call 'kernel32::OpenProcess(i 0x100000, i 0, i r4) p .r5'
 System::Call 'kernel32::WaitForSingleObject(p r5, i 0) i .r6'
 WriteINIStr "${quote(lifecycle)}" "child" "parentProcessBefore" "$6"
 System::Call 'user32::IsWindow(p r2) i .r3'
 WriteINIStr "${quote(lifecycle)}" "child" "parentWindowAlive" "$3"
 System::Call 'user32::IsWindowVisible(p r2) i .r3'
 WriteINIStr "${quote(lifecycle)}" "child" "parentVisibleAtChild" "$3"
 System::Call 'user32::IsWindowVisible(p $HWNDPARENT) i .r3'
 WriteINIStr "${quote(lifecycle)}" "child" "childVisible" "$3"
 Sleep 250
 System::Call 'kernel32::WaitForSingleObject(p r5, i 0) i .r6'
 WriteINIStr "${quote(lifecycle)}" "child" "parentProcessAfter" "$6"
 System::Call 'kernel32::CloseHandle(p r5)'
 System::Call 'user32::IsWindow(p r2) i .r3'
 WriteINIStr "${quote(lifecycle)}" "child" "parentStillAlive" "$3"
 IfFileExists "$EXEPATH" 0 +2
  WriteINIStr "${quote(lifecycle)}" "child" "componentPresent" "1"
 FileOpen $0 "${quote(join(directory, track + '.marker'))}" w
 FileWrite $0 "$CMDLINE"
 FileClose $0
 SetErrorLevel ${scenario.childExit ?? 42}
SectionEnd`;
      await writeFile(child + '.nsi', '\ufeff' + fixture);
      execFileSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', child + '.nsi'], { windowsHide: true });
    }
    // Only test-generated source substitutes the Windows conditions. The
    // production installer has no runtime/environment OS override.
    let wrapper = source;
    // Instrument only this generated wrapper so the tiny child can inspect its
    // own parent window. No real application installer or user window is opened.
    wrapper = wrapper.replace('  HideWindow', `  System::Call 'user32::IsWindowVisible(p $HWNDPARENT) i .r1'
  WriteINIStr "${quote(lifecycle)}" "wrapper" "beforeVisible" "$1"
  WriteINIStr "${quote(lifecycle)}" "wrapper" "parentHwnd" "$HWNDPARENT"
  System::Call 'kernel32::GetCurrentProcessId() i .r1'
  WriteINIStr "${quote(lifecycle)}" "wrapper" "parentPid" "$1"
  HideWindow`);
    if (scenario.conditions) {
      for (const [i, token] of ['${RunningX64}', '${AtLeastWin10}', '${IsWin7}'].entries()) {
        assert.equal(wrapper.split(token).length, 2);
        wrapper = wrapper.replace(token, scenario.conditions[i] ? '1 == 1' : '0 == 1');
      }
    }
    const bootstrap = join(directory, 'bootstrap.exe');
    const definitions = `!define APP_VERSION "${version}"
!define OUTPUT_FILE "${quote(bootstrap)}"
!define APP_ICON "${quote(resolve('resources/app-icon.ico'))}"
!define MODERN_INSTALLER "${quote(join(directory, 'modern.exe'))}"
!define LEGACY_INSTALLER "${quote(join(directory, 'legacy.exe'))}"
`;
    const script = join(directory, 'bootstrap.nsi');
    await writeFile(script, '\ufeff' + definitions + wrapper);
    execFileSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', script], { windowsHide: true });
    const detectionPath = join(tmpdir(), `DataFusion-Universal-${version}-platform.txt`);
    const check = spawnSync(bootstrap, ['/CHECKOS', '/S'], { windowsHide: true, timeout: 30000 });
    assert.equal(check.status, scenario.track ? 0 : 87, `${scenario.name}: ${check.error ?? ''}`);
    if (scenario.track) {
      const detection = await readFile(detectionPath, 'utf8');
      assert(detection.includes(`runtime=${scenario.track}`));
      assert(detection.includes('prerequisites=none'));
      await rm(detectionPath);
    }
    assert(!(await exists(join(directory, 'modern.marker'))));
    assert(!(await exists(join(directory, 'legacy.marker'))));
    const destination = join(directory, "应用目录 [测试] O'Brien & $files");
    const run = spawnSync(bootstrap, [...(scenario.interactive ? [] : ['/S']), `/D=${destination}`], { windowsHide: true, timeout: 30000 });
    const expectedExit = scenario.launchError ? 23 : scenario.track ? scenario.childExit ?? 42 : 87;
    assert.equal(run.status, expectedExit, `${scenario.name}: ${run.error ?? ''}`);
    for (const track of ['modern', 'legacy']) {
      const marker = join(directory, `${track}.marker`);
      if (scenario.track === track && !scenario.launchError) {
        const argumentsSeen = await readFile(marker, 'utf8');
        assert.equal(argumentsSeen.includes('/S'), !scenario.interactive);
        assert(argumentsSeen.includes(`/D=${destination}`));
        assert(!argumentsSeen.includes('/CHECKOS'));
      } else { assert(!(await exists(marker))); }
    }
    let windowLifecycle;
    if (scenario.track && !scenario.launchError) {
      const bytes = await readFile(lifecycle);
      const text = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\ufeff/, '');
      const value = key => Number(text.match(new RegExp(`^${key}=(\\d+)`, 'm'))?.[1] ?? NaN);
      windowLifecycle = { wrapperInitiallyVisible: value('beforeVisible') === 1,
        wrapperHiddenWhenChildRuns: value('parentVisibleAtChild') === 0,
        componentWindowVisible: value('childVisible') === 1,
        wrapperWaitsForChild: value('parentProcessBefore') === 258 && value('parentProcessAfter') === 258,
        wrapperWindowRetained: scenario.interactive ? value('parentWindowAlive') === 1 && value('parentStillAlive') === 1 : null,
        extractedComponentPreserved: value('componentPresent') === 1 };
      assert.equal(windowLifecycle.wrapperInitiallyVisible, Boolean(scenario.interactive), `${scenario.name}: ${text}`);
      assert(windowLifecycle.wrapperHiddenWhenChildRuns, `${scenario.name}: ${text}`);
      assert.equal(windowLifecycle.componentWindowVisible, Boolean(scenario.interactive), `${scenario.name}: ${text}`);
      if (scenario.interactive) assert(windowLifecycle.wrapperWindowRetained, `${scenario.name}: ${text}`);
      assert(windowLifecycle.wrapperWaitsForChild && windowLifecycle.extractedComponentPreserved, `${scenario.name}: ${text}`);
    }
    reports.push({ scenario: scenario.name, selectedRuntime: scenario.track ?? null, exit: run.status,
      actualHostDetection: !scenario.conditions, installationSimulated: true, ...(windowLifecycle ? { windowLifecycle } : {}) });
  }
  const applicationVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
  const output = resolve('private/deploy', `universal-${applicationVersion}`);
  await mkdir(output, { recursive: true });
  const result = { passed: true, productionWrapperSource: true, directoryAndSilentArgumentsPreserved: true,
    realNsisExecutables: true, preparationWindowHandsOffToComponent: true,
    actualApplicationInstalled: false, systemPrerequisitesInstalled: false, reports };
  await writeFile(join(output, 'wrapper-dispatch.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  assert.equal(dirname(resolve(work)), resolve(tmpdir()));
  assert(basename(work).startsWith('fusion-universal-dispatch-'));
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
