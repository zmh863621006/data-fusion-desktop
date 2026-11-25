import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, rm, lstat } from 'node:fs/promises';
import { join, dirname, resolve, posix, win32 } from 'node:path';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
const project = resolve('.'), source = await readFile('resources/business-bootstrap.cjs', 'utf8');
function bootstrap({ deployment, platform = 'win32', electron = '44.3.0', profile = '' } = {}) {
  const path = platform === 'linux' ? posix : win32, calls = { switches: [], paths: [], modelIds: [], names: [], directories: [] };
  const app = { commandLine: { hasSwitch: () => false, getSwitchValue: () => profile, appendSwitch: (...args) => calls.switches.push(args) },
    getPath: () => platform === 'linux' ? '/home/synthetic/.config' : 'C:\\Synthetic\\AppData\\Roaming', setPath: (...args) => calls.paths.push(args),
    setAppUserModelId: id => calls.modelIds.push(id), setName: name => calls.names.push(name), setDesktopName() {},
    requestSingleInstanceLock: () => false, on() {}, quit() {} };
  const shell = { schema: 1, product: 'data-fusion-desktop', shellVersion: '1.2.0', baseBusinessVersion: '1.2.0',
    feedBase: 'https://intranet.example.invalid/business-updates/', publicKey: 'unused for profile selection',
    builtin: { backend: { origin: 'https://intranet.example.invalid', revision: 1 } }, ...(deployment === undefined ? {} : { deployment }) };
  const context = { require(name) { return ({ electron: { app, BrowserWindow: function () {}, ipcMain: { handle() {} } },
    'node:path': path, 'original-fs': { mkdirSync: directory => calls.directories.push(directory) }, './business-updater.cjs': {}, './shell.json': shell })[name]; },
    process: { platform, versions: { electron }, env: {} }, AbortController, Promise, __dirname: '/fixed-shell' };
  runInNewContext(source, context); return calls;
}
test('trusted Huizhou shell uses separate automatic profiles and passes its chosen path into the frozen shared main', () => {
  for (const [platform, electron, expected] of [['win32', '44.3.0', 'huizhou-data-fusion-desktop'],
    ['win32', '22.3.27', 'huizhou-data-fusion-desktop-win7'], ['linux', '44.3.0', 'huizhou-data-fusion-desktop']]) {
    const calls = bootstrap({ deployment: 'huizhou-intranet', platform, electron });
    const selected = calls.paths.find(([key]) => key === 'userData')[1]; assert(selected.endsWith(expected));
    assert(calls.switches.some(([key, value]) => key === 'user-data-dir' && value === selected));
    assert(!calls.directories.some(path => /(?:^|[\\/])data-fusion-desktop(?:-win7)?$/.test(path)));
    assert.deepEqual(calls.names, ['惠州数据融合助手']);
    if (platform === 'win32') assert.deepEqual(calls.modelIds, ['cn.zzkj.datafusion.huizhou.desktop']);
  }
});
test('standard Shenzhen default identity/profile remains unchanged and an explicit isolated profile is respected', () => {
  for (const electron of ['44.3.0', '22.3.27']) {
    const calls = bootstrap({ electron }); assert(calls.paths[0][1].endsWith(electron.startsWith('22') ? 'data-fusion-desktop-win7' : 'data-fusion-desktop'));
    assert(!calls.switches.some(([key]) => key === 'user-data-dir')); assert.deepEqual(calls.names, []); assert.deepEqual(calls.modelIds, ['cn.zzkj.datafusion.desktop']);
  }
  const calls = bootstrap({ deployment: 'huizhou-intranet', profile: 'C:\\Isolated\\QA' });
  assert.equal(calls.paths[0][1], 'C:\\Isolated\\QA'); assert(!calls.switches.some(([key]) => key === 'user-data-dir'));
  for (const deployment of ['../../data-fusion-desktop', 'unknown', {}, null]) assert.throws(() => bootstrap({ deployment }), /INVALID_SHELL_DEPLOYMENT/);
});
test('Huizhou NSIS identity keeps export backups and universal-instance state outside Shenzhen paths', async () => {
  const safe = await readFile('resources/nsis-safe-update.nsh', 'utf8'), modern = await readFile('resources/nsis-huizhou-include.nsh', 'utf8'), legacy = await readFile('resources/nsis-huizhou-win7-include.nsh', 'utf8');
  assert(modern.includes('!define DATA_FUSION_HUIZHOU')); assert(legacy.includes('!define DATA_FUSION_HUIZHOU')); assert(legacy.includes('!define DATA_FUSION_WIN7_RUNTIME'));
  assert(safe.includes('$APPDATA\\huizhou-data-fusion-desktop\\updates\\export-backups'));
  const universal = await readFile('resources/nsis-universal.nsi', 'utf8');
  assert(universal.includes('"ProductName" "惠州数据融合助手"')); assert(universal.includes('Local\\HuizhouDataFusionUniversal-'));
});
test('Huizhou DEB identity and independent verifier reject old package metadata and any overlapping Shenzhen installation paths', async t => {
  await mkdir('.tmp/kylin-deb', { recursive: true }); const stage = await mkdtemp(join(project, '.tmp/kylin-deb/huizhou-identity-test-'));
  t.after(async () => { assert.equal(dirname(stage), join(project, '.tmp/kylin-deb')); assert.equal((await lstat(stage)).isSymbolicLink(), false); await rm(stage, { recursive: true, force: true }); });
  for (const name of ['data-fusion', 'chrome-sandbox', 'chrome_crashpad_handler']) {
    await mkdir(join(stage, 'opt/huizhou-data-fusion'), { recursive: true }); const bytes = Buffer.alloc(20); Buffer.from([0x7f,0x45,0x4c,0x46,2,1]).copy(bytes); bytes.writeUInt16LE(62, 18); await writeFile(join(stage, 'opt/huizhou-data-fusion', name), bytes);
  }
  await mkdir(join(stage, 'opt/huizhou-data-fusion/resources')); await writeFile(join(stage, 'opt/huizhou-data-fusion/resources/app.asar'), 'synthetic ASAR identity fixture');
  await mkdir(join(stage, 'DEBIAN')); const control = 'Package: huizhou-data-fusion-desktop\nVersion: 1.2.0\nArchitecture: amd64\nDescription: synthetic\n'; await writeFile(join(stage, 'DEBIAN/control'), control);
  const script = `import importlib.util,pathlib,sys,json\ndef load(name,file):\n s=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m\nb=load('b',sys.argv[1]);v=load('v',sys.argv[2]);stage=pathlib.Path(sys.argv[3]);out=stage.parent/(stage.name+'.deb');r=b.build(stage,'x64','1.2.0',out,None,'huizhou-intranet');assert v.verify(out,stage,'x64','1.2.0',None,'huizhou-intranet')['passed'];\ntry:\n v.verify(out,stage,'x64','1.2.0');raise AssertionError('standard verifier accepted Huizhou')\nexcept ValueError:pass\n(stage/'opt/data-fusion').mkdir();\ntry:\n b.build(stage,'x64','1.2.0',out,None,'huizhou-intranet');raise AssertionError('overlapping Shenzhen paths accepted')\nexcept ValueError:pass\nout.unlink();print('independent identity verified')`;
  const result = spawnSync('python', ['-c', script, 'scripts/build-kylin-deb.py', 'scripts/verify-kylin-deb.py', stage], { cwd: project, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /independent identity verified/);
});
