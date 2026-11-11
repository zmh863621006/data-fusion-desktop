import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

assert.equal(process.platform, 'win32');
const legacy = process.argv.includes('--legacy');
const work = await mkdtemp(join(tmpdir(), 'fusion-native-update-'));
const unique = randomBytes(6).toString('hex');
const applicationName = `FusionUpdateProbe${unique}`;
const registryKey = `Software\\DataFusionUpdateHostTest\\${unique}`;
const compiler = join(process.env.SystemRoot, legacy ? 'Microsoft.NET/Framework64/v3.5/csc.exe' : 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const fixtureCompiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const webExtensions = legacy
  ? join(process.env.SystemRoot, 'assembly/GAC_MSIL/System.Web.Extensions/3.5.0.0__31bf3856ad364e35/System.Web.Extensions.dll')
  : 'System.Web.Extensions.dll';
const controller = join(work, 'FixtureTools.exe');
const nativeHost = join(work, 'NativeHost.exe');
const productionHost = join(work, 'ProductionHost.exe');
const cases = [];
const fixtures = [];
const children = new Set();
const observedRuntimes = new Set();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async path => { try { await readFile(path); return true; } catch { return false; } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await pause(30);
  }
  throw new Error(`Native host fixture timeout: ${description}`);
}
function launch(file, args, env = {}, parent = false) {
  const child = spawn(file, args, { windowsHide: true, shell: false,
    stdio: parent ? ['pipe', 'pipe', 'pipe'] : 'ignore',
    env: { ...process.env, PSExecutionPolicyPreference: 'Restricted', ...env } });
  children.add(child);
  child.done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { children.delete(child); resolve(code); });
  });
  // Attach a rejection handler immediately even while a test is polling disk.
  child.done.catch(() => {});
  return child;
}
async function stopParent(parent) {
  if (parent && parent.exitCode === null) parent.stdin.end();
  if (parent) await parent.done;
}
function registry(action, directory = '') {
  execFileSync(controller, [action, registryKey, directory], { windowsHide: true, encoding: 'utf8' });
}
async function setup(name, patch = {}, settings = {}) {
  const directory = join(work, name);
  const install = join(directory, "应用 O'Brien & safe; $HOME");
  const updates = join(directory, 'profile/updates');
  const handoff = join(updates, 'handoff-' + randomBytes(5).toString('hex'));
  const executable = join(install, `${settings.production ? 'DataFusion' : applicationName}.exe`);
  await mkdir(join(install, 'resources'), { recursive: true });
  await mkdir(handoff, { recursive: true });
  await copyFile(controller, executable);
  await writeFile(join(install, 'resources/app.asar'), 'fixture');
  await mkdir(join(install, '导出文件'), { recursive: true });
  await writeFile(join(install, '导出文件/unchanged.xlsx'), 'must stay unchanged');
  const installer = join(updates, 'DataFusion-Setup-9.8.7-x64.exe');
  await copyFile(controller, installer);
  const parent = launch(executable, ['parent'], {}, true);
  await new Promise((ready, reject) => { parent.stdout.once('data', ready); parent.once('error', reject); });
  const configuration = { schema: 1, token: randomBytes(32).toString('hex'), handoffId: basename(handoff),
    handoffDirectory: handoff, updatesDirectory: updates, installerPath: installer,
    expectedSha256: digest(await readFile(installer)), installDirectory: install, executablePath: executable,
    parentPid: parent.pid, exitTimeoutMs: 4000, version: '9.8.7', ...patch };
  const configPath = join(handoff, 'configuration.json');
  const save = () => writeFile(configPath, JSON.stringify(configuration));
  await save();
  if (settings.registered !== false && !settings.production) registry('registry-set', install);
  else registry('registry-remove');
  const f = { name, directory, install, updates, handoff, executable, installer, parent, configuration, configPath, save,
    installerMarker: join(directory, 'installer.marker'), restartMarker: join(directory, 'restart.marker'),
    result: async () => { try { return JSON.parse(await readFile(join(handoff, 'result.json'), 'utf8')); } catch { return null; } },
    marker: (file, token = configuration.token) => writeFile(join(handoff, file), JSON.stringify({ token })),
    start: (env = {}, customHost) => launch(customHost ?? (settings.production ? productionHost : nativeHost), [], {
      DATA_FUSION_UPDATE_CONFIG: configPath, DATA_FUSION_TEST_INSTALLER_MARKER: join(directory, 'installer.marker'),
      DATA_FUSION_TEST_RESTART_MARKER: join(directory, 'restart.marker'), DATA_FUSION_TEST_APPLICATION: executable, ...env,
    }),
  };
  fixtures.push(f);
  return f;
}
const ready = async f => {
  await until(() => exists(join(f.handoff, 'ready.json')), `${f.name}:ready`);
  const value = JSON.parse(await readFile(join(f.handoff, 'ready.json'), 'utf8'));
  assert.equal(value.ready, true);
  assert.equal(value.token, f.configuration.token);
  assert.match(value.parentStartedAt, /^\d+$/);
  assert(value.runtimeVersion.startsWith(legacy ? '2.0.' : '4.0.'), `Unexpected actual helper runtime: ${value.runtimeVersion}`);
  observedRuntimes.add(value.runtimeVersion);
};
const outcome = (f, host) => until(async () => {
  if (host.exitCode === null) return false;
  return await f.result();
}, `${f.name}:result`);
async function untouched(f) {
  assert.equal(await exists(f.installerMarker), false);
  assert.equal(await readFile(join(f.install, '导出文件/unchanged.xlsx'), 'utf8'), 'must stay unchanged');
}
async function run(name, body) { await body(); cases.push(name); }
try {
  const source = await readFile('resources/windows-update-host.cs', 'utf8');
  assert(!/powershell|encodedcommand|cmd\.exe|wscript|cscript/i.test(source));
  assert(!/\.Kill\s*\(|TerminateProcess|taskkill/i.test(source), 'The update helper must never terminate an application process');
  // Only compile-time identity constants differ. No validation or control flow is mocked.
  const isolated = source.replace('"DataFusion.exe"', `"${applicationName}.exe"`)
    .replace('"DataFusion"', `"${applicationName}"`)
    .replace('@"Software\\7030467a-ac8a-531f-b76e-ee2a205ae613"', `@"${registryKey}"`);
  assert.notEqual(source, isolated);
  assert(!isolated.includes('7030467a-ac8a-531f-b76e-ee2a205ae613'));
  const isolatedSource = join(work, 'host.cs');
  await writeFile(isolatedSource, isolated);
  const compile = (output, input) => execFileSync(compiler,
    [...(legacy ? ['/noconfig', '/reference:System.dll'] : []), '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/reference:' + webExtensions, '/out:' + output, resolve(input)],
    { windowsHide: true, encoding: 'utf8' });
  compile(nativeHost, isolatedSource);
  const builtHost = resolve(legacy ? 'resources/win7-compat/DataFusion.UpdateHost.exe' : 'resources/DataFusion.UpdateHost.exe');
  await copyFile(builtHost, productionHost);
  if (legacy) {
    const config = await readFile(builtHost + '.config');
    assert.match(config.toString(), /supportedRuntime version="v2\.0\.50727"/);
    await writeFile(nativeHost + '.config', config);
    await writeFile(productionHost + '.config', config);
    assert((await readFile(productionHost)).includes(Buffer.from('v2.0.50727')));
  }
  execFileSync(fixtureCompiler, ['/nologo', '/target:exe', '/platform:x64', '/out:' + controller, resolve('scripts/fixtures/update-host-fixture.cs')], { windowsHide: true });

  await run('production host rejects a different unregistered installation', async () => {
    const f = await setup('production', {}, { production: true });
    const result = await outcome(f, f.start());
    assert.equal(result.code, 'unregistered_installation');
    await untouched(f); await stopParent(f.parent);
  });
  await run('unregistered fixture does not become ready or exit the parent', async () => {
    const f = await setup('unregistered', {}, { registered: false });
    assert.equal((await outcome(f, f.start())).code, 'unregistered_installation');
    assert.equal(f.parent.exitCode, null); await untouched(f); await stopParent(f.parent);
  });
  await run('a mismatched parent identity is rejected', async () => {
    const f = await setup('identity', { parentPid: process.pid });
    assert.equal((await outcome(f, f.start())).code, 'parent_identity_invalid');
    await untouched(f); await stopParent(f.parent);
  });
  await run('development directory is never overwritten', async () => {
    const f = await setup('development'); await writeFile(join(f.install, 'package.json'), '{}');
    assert.equal((await outcome(f, f.start())).code, 'development_directory');
    await untouched(f); await stopParent(f.parent);
  });
  await run('uncommitted parent exit cancels without launching the installer', async () => {
    const f = await setup('withoutcommit'); const host = f.start(); await ready(f);
    await stopParent(f.parent); const result = await outcome(f, host);
    assert.equal(result.status, 'cancelled'); assert.equal(result.code, 'parent_exited_without_commit'); await untouched(f);
  });
  await run('cancel marker takes precedence over a commit while parent is alive', async () => {
    const f = await setup('cancel'); const host = f.start(); await ready(f);
    await f.marker('commit.json'); await f.marker('cancel.json');
    assert.equal((await outcome(f, host)).status, 'cancelled'); assert.equal(f.parent.exitCode, null);
    await untouched(f); await stopParent(f.parent);
  });
  await run('an interrupted status write cannot block a later update preparation', async () => {
    const f = await setup('staletemporary');
    const stale = join(f.updates, 'update-install-result.json.writing');
    await writeFile(stale, 'interrupted old write');
    const host = f.start(); await ready(f); await f.marker('cancel.json');
    assert.equal((await outcome(f, host)).status, 'cancelled');
    assert.equal(await readFile(stale, 'utf8'), 'interrupted old write');
    await untouched(f); await stopParent(f.parent);
  });
  await run('wrong-token commit and cancel markers are ignored', async () => {
    const f = await setup('wrongtoken'); const host = f.start(); await ready(f);
    await f.marker('commit.json', 'wrong'); await f.marker('cancel.json', 'wrong'); await stopParent(f.parent);
    assert.equal((await outcome(f, host)).code, 'parent_exited_without_commit'); await untouched(f);
  });
  await run('parent exit deadline does not terminate the running application', async () => {
    const f = await setup('timeout', { exitTimeoutMs: 250 }); const host = f.start(); await ready(f);
    await f.marker('commit.json'); assert.equal((await outcome(f, host)).code, 'parent_exit_timeout');
    assert.equal(f.parent.exitCode, null); await untouched(f); await stopParent(f.parent);
  });
  await run('a second handoff cannot acquire the installation mutex', async () => {
    const f = await setup('mutex'); const host = f.start(); await ready(f);
    const second = await mkdtemp(join(f.updates, 'handoff-'));
    const configPath = join(second, 'configuration.json');
    await writeFile(configPath, JSON.stringify({ ...f.configuration, handoffId: basename(second), handoffDirectory: second }));
    const contender = launch(nativeHost, [], { DATA_FUSION_UPDATE_CONFIG: configPath });
    await contender.done;
    assert.equal(JSON.parse(await readFile(join(second, 'result.json'), 'utf8')).code, 'installation_already_prepared');
    await f.marker('cancel.json'); await outcome(f, host); await untouched(f); await stopParent(f.parent);
  });
  await run('another instance is not stopped to allow installation', async () => {
    const f = await setup('otherinstance'); const host = f.start(); await ready(f);
    const blocker = launch(f.executable, ['parent'], {}, true);
    await new Promise(resolve => blocker.stdout.once('data', resolve));
    await f.marker('commit.json'); await stopParent(f.parent);
    assert.equal((await outcome(f, host)).code, 'another_application_running'); assert.equal(blocker.exitCode, null);
    await untouched(f); await stopParent(blocker);
  });
  for (const [name, mutate, code] of [
    ['missing', async f => rm(f.installer), 'installer_missing'],
    ['hash', async f => writeFile(f.installer, 'changed installer'), 'installer_invalid'],
    ['digest', async f => { const bytes = await readFile(f.installer); bytes[128] ^= 1; await writeFile(f.installer, bytes); }, 'installer_hash_mismatch'],
    ['pe', async f => { const bytes = Buffer.alloc(128); await writeFile(f.installer, bytes); f.configuration.expectedSha256 = digest(bytes); await f.save(); }, 'installer_invalid'],
  ]) await run(`installer ${name} stops before native execution`, async () => {
    const f = await setup(name); await mutate(f); const host = f.start(); await ready(f);
    await f.marker('commit.json'); await stopParent(f.parent); assert.equal((await outcome(f, host)).code, code); await untouched(f);
  });
  for (const [exitCode, code] of [[21, 'export_backup_failed'], [22, 'export_restore_failed'], [23, 'graphics_runtime_unavailable'], [24, 'legacy_graphics_file_in_use'], [25, 'installer_check_failed'], [7, 'installer_failed']]) {
    await run(`installer exit ${exitCode} is reported without a restart`, async () => {
      const f = await setup('exit' + exitCode); const host = f.start({ DATA_FUSION_TEST_INSTALLER_EXIT: String(exitCode) }); await ready(f);
      await f.marker('commit.json'); await stopParent(f.parent); assert.equal((await outcome(f, host)).code, code);
      assert.equal(await exists(f.installerMarker), true); assert.equal(await exists(f.restartMarker), false);
    });
  }
  await run('installed product version mismatch is reported', async () => {
    const f = await setup('version', { version: '9.8.8' }); const host = f.start(); await ready(f);
    await f.marker('commit.json'); await stopParent(f.parent); assert.equal((await outcome(f, host)).code, 'installed_version_mismatch');
    assert.equal(await exists(f.restartMarker), false);
  });
  for (const forceRun of [false, true]) await run(`verified installer and ${forceRun ? 'installer restart' : 'fallback restart'} work under Restricted policy`, async () => {
    const f = await setup('success' + forceRun); const host = f.start({ DATA_FUSION_TEST_FORCE_RUN: forceRun ? '1' : '0' }); await ready(f);
    await f.marker('commit.json'); await stopParent(f.parent); assert.equal((await outcome(f, host)).status, 'installed');
    await until(() => exists(f.restartMarker + '.done'), f.name + ':restart complete');
    assert.equal(await readFile(f.restartMarker, 'utf8'), 'restarted\n');
    const args = await readFile(f.installerMarker, 'utf8');
    assert(args.endsWith('/S --updated --force-run /currentuser /D=' + f.install));
    assert.equal(await readFile(join(f.install, '导出文件/unchanged.xlsx'), 'utf8'), 'must stay unchanged');
  });
  console.log(JSON.stringify({ status: 'passed', nativeUpdateHost: true, scriptInterpreterRequired: false,
    targetRuntime: legacy ? 'CLR2-.NET3.5' : 'CLR4', actualRuntimes: [...observedRuntimes],
    actualBuiltProductionHostTested: true, actualWin7Tested: false, cases: cases.length }));
} finally {
  for (const f of fixtures) await stopParent(f.parent);
  for (const child of children) {
    if (child.stdin?.writable) child.stdin.end();
    await child.done;
  }
  // The fixed fixture utility refuses keys outside its test-only namespace.
  try { registry('registry-remove'); } catch { }
  assert.equal(dirname(resolve(work)), resolve(tmpdir()));
  assert(basename(work).startsWith('fusion-native-update-'));
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
