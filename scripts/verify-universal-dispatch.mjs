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
const versionBase = 10000 + Math.floor(Math.random() * 40000);
const reports = [];
try {
  for (const [index, scenario] of [
    { name: 'actual-win10', track: 'modern' },
    { name: 'win7-7600-rtm', track: 'legacy', conditions: [true, false, true] },
    { name: 'win7-7601-sp1', track: 'legacy', conditions: [true, false, true] },
    { name: 'child-cancelled', track: 'modern', childExit: 1602 },
    { name: 'unsupported-32bit', conditions: [false, true, false] },
    { name: 'unsupported-windows8', conditions: [true, false, false] },
  ].entries()) {
    const directory = join(work, scenario.name);
    await mkdir(directory);
    const version = `0.0.${versionBase + index}`;
    for (const track of ['modern', 'legacy']) {
      const child = join(directory, `${track}.exe`);
      const fixture = `Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${quote(child)}"
Section
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
    const run = spawnSync(bootstrap, ['/S', `/D=${destination}`], { windowsHide: true, timeout: 30000 });
    const expectedExit = scenario.track ? scenario.childExit ?? 42 : 87;
    assert.equal(run.status, expectedExit, `${scenario.name}: ${run.error ?? ''}`);
    for (const track of ['modern', 'legacy']) {
      const marker = join(directory, `${track}.marker`);
      if (scenario.track === track) {
        const argumentsSeen = await readFile(marker, 'utf8');
        assert(argumentsSeen.includes('/S'));
        assert(argumentsSeen.includes(`/D=${destination}`));
        assert(!argumentsSeen.includes('/CHECKOS'));
      } else { assert(!(await exists(marker))); }
    }
    reports.push({ scenario: scenario.name, selectedRuntime: scenario.track ?? null, exit: run.status,
      actualHostDetection: !scenario.conditions, installationSimulated: true });
  }
  const applicationVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
  const output = resolve('private/deploy', `universal-${applicationVersion}`);
  await mkdir(output, { recursive: true });
  const result = { passed: true, productionWrapperSource: true, directoryAndSilentArgumentsPreserved: true,
    realNsisExecutables: true, actualApplicationInstalled: false, systemPrerequisitesInstalled: false, reports };
  await writeFile(join(output, 'wrapper-dispatch.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  assert.equal(dirname(resolve(work)), resolve(tmpdir()));
  assert(basename(work).startsWith('fusion-universal-dispatch-'));
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
