import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { listPackage, extractFile, createPackage } from '@electron/asar';
import { buildBusinessPayload } from './build-business-payload.mjs';
import { stageBusinessShell } from './stage-business-shell.mjs';
import { PROJECT, checkedTarget } from './business-package-common.mjs';

const target = { platform: 'win32', arch: 'x64', variant: 'standard', electronMajor: 44 };
const { afterPack } = createRequire(import.meta.url)('./business-shell-config.cjs');
async function file(root, name, content) { const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); return path; }
async function fixture(t) {
  await mkdir(join(PROJECT, '.tmp'), { recursive: true });
  const root = await mkdtemp(join(PROJECT, '.tmp/business-package-fixture-'));
  t.after(async () => {
    assert.equal(dirname(root), join(PROJECT, '.tmp'));
    assert(root.startsWith(join(PROJECT, '.tmp/business-package-fixture-')));
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true });
  });
  await file(root, 'package.json', JSON.stringify({ name: 'data-fusion-desktop', productName: '数据融合助手', version: '1.1.0', author: '数据融合助手',
    license: 'UNLICENSED', dependencies: { parent: '1.0.0' }, devDependencies: { 'never-ship': '1.0.0' } }));
  for (const source of ['out', 'out-win7']) {
    await file(root, `${source}/main/index.js`, 'module.exports={business:true};');
    await file(root, `${source}/preload/index.js`, 'require("electron");');
    await file(root, `${source}/renderer/index.html`, '<html>业务界面</html>');
    await file(root, `${source}/renderer/templates/行政许可.xlsx`, Buffer.from([1, 2, 3]));
    for (const name of ['private/credentials.json', 'main/index.js.map', 'main/ignored.test.js', 'smoke-hidden.js', 'credentials.secure.json']) await file(root, `${source}/${name}`, 'must not ship');
  }
  await file(root, 'node_modules/parent/package.json', JSON.stringify({ name: 'parent', version: '1.0.0', main: 'index.js', dependencies: { child: '1.0.0' }, peerDependencies: { peer: '*' } }));
  await file(root, 'node_modules/parent/index.js', 'module.exports=require("child");');
  await file(root, 'node_modules/parent/tests/private.txt', 'must not ship');
  await file(root, 'node_modules/parent/.npmrc', 'must not ship');
  await file(root, 'node_modules/parent/node_modules/child/package.json', JSON.stringify({ name: 'child', version: '1.0.0', main: 'index.js' }));
  await file(root, 'node_modules/parent/node_modules/child/index.js', 'module.exports=42;');
  await file(root, 'node_modules/peer/package.json', JSON.stringify({ name: 'peer', version: '1.0.0', main: 'index.js' }));
  await file(root, 'node_modules/peer/index.js', 'module.exports=43;');
  await file(root, 'node_modules/never-ship/package.json', JSON.stringify({ name: 'never-ship', version: '1.0.0' }));
  await file(root, 'node_modules/never-ship/index.js', 'must not ship');
  await file(root, 'node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: '44.3.0' }));
  await file(root, 'node_modules/electron/dist/version', '44.3.0');
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await file(root, 'src/main/runtime.ts', 'const PRODUCT_PUBLIC_KEY = `' + publicKey.export({ type: 'spki', format: 'pem' }) + '`;');
  for (const name of ['business-bootstrap.cjs', 'business-preload.cjs', 'business-startup.html', 'business-updater.cjs']) await file(root, 'resources/' + name, 'fixed trusted base ' + name);
  return root;
}
const options = root => ({ projectRoot: root, version: '1.1.0', minShellVersion: '1.1.0', ...target });

test('business ASAR includes complete business output and only resolved production dependencies', async t => {
  const root = await fixture(t), result = await buildBusinessPayload(options(root));
  assert.equal(result.metadata.entry, 'out/main/index.js'); assert.deepEqual(result.metadata.target, target);
  assert.deepEqual(JSON.parse(extractFile(result.file, 'business.json').toString()), result.metadata);
  assert.equal(extractFile(result.file, join('node_modules/parent/node_modules/child/index.js')).toString(), 'module.exports=42;');
  assert.equal(extractFile(result.file, join('node_modules/peer/index.js')).toString(), 'module.exports=43;');
  assert.deepEqual(extractFile(result.file, join('out/renderer/templates/行政许可.xlsx')), Buffer.from([1, 2, 3]));
  const entries = listPackage(result.file).join('\n');
  assert(!/never-ship|private|secure|ignored\.test|smoke-hidden|\.map|\/tests\/|\.npmrc/.test(entries));
  assert.equal(result.productionPackages.length, 3);
});

test('rebuilding identical content is reproducible, while another payload cannot replace that version', async t => {
  const root = await fixture(t), result = await buildBusinessPayload(options(root));
  assert.equal((await buildBusinessPayload(options(root))).sha256, result.sha256);
  const original = await readFile(result.file);
  await file(root, 'out/main/index.js', 'module.exports={changed:true};');
  await assert.rejects(buildBusinessPayload(options(root)), /different artifact/);
  assert.deepEqual(await readFile(result.file), original);
});

test('Win7 payload selects the compiled compatibility output and leaves native resources in the shell', async t => {
  const root = await fixture(t);
  await file(root, 'out-win7/main/index.js', 'module.exports={node16:true};');
  const result = await buildBusinessPayload({ ...options(root), electronMajor: 22 });
  assert.equal(extractFile(result.file, join('out/main/index.js')).toString(), 'module.exports={node16:true};');
  assert.deepEqual(result.productionPackages, []); assert(!listPackage(result.file).some(name => name.includes('node_modules')));
});

test('native dependency files and invalid architecture variants are rejected', async t => {
  const root = await fixture(t);
  await file(root, 'node_modules/parent/native.node', Buffer.from([1, 2, 3]));
  await assert.rejects(buildBusinessPayload(options(root)), /Native component belongs/);
  assert.throws(() => checkedTarget({ ...target, platform: 'linux', variant: 'kirin990' }), /requires Linux ARM64/);
  assert.throws(() => checkedTarget({ ...target, platform: 'linux', electronMajor: 22 }), /reserved for the Win7/);
});

test('shell stage pins unchanged builtin archive, product key and empty base dependencies', async t => {
  const root = await fixture(t), payload = await buildBusinessPayload(options(root));
  const stage = await stageBusinessShell({ projectRoot: root, payload: payload.receipt });
  const shell = JSON.parse(await readFile(join(stage.appDirectory, 'shell.json'), 'utf8'));
  assert.equal(shell.builtin.sha256, payload.sha256); assert.equal(shell.builtin.bytes, payload.bytes);
  assert.deepEqual(shell.target, target); assert.equal(shell.feedBase.includes('/business/v1/'), true);
  const metadata = JSON.parse(await readFile(join(stage.appDirectory, 'package.json'), 'utf8'));
  assert.equal(metadata.main, 'business-bootstrap.cjs'); assert.deepEqual(metadata.dependencies, {});
  assert.deepEqual(await readFile(join(stage.resourceDirectory, 'business/builtin.asar')), await readFile(payload.file));
  assert.equal(await readFile(join(stage.appDirectory, 'business-bootstrap.cjs'), 'utf8'), 'fixed trusted base business-bootstrap.cjs');
});

test('shell staging rejects a changed business archive or receipt and unsafe feed/backend URLs', async t => {
  const root = await fixture(t), payload = await buildBusinessPayload(options(root));
  await assert.rejects(stageBusinessShell({ projectRoot: root, payload: payload.receipt, feedBase: 'http://updates.invalid/' }), /stable HTTPS/);
  await assert.rejects(stageBusinessShell({ projectRoot: root, payload: payload.receipt, shellVersion: '1.0.0' }), /below the payload minimum/);
  await assert.rejects(buildBusinessPayload({ ...options(root), backendOrigin: 'https://backend.invalid/path' }), /complete HTTPS origin/);
  const receipt = JSON.parse(await readFile(payload.receipt, 'utf8')); receipt.sha256 = '0'.repeat(64); await writeFile(payload.receipt, JSON.stringify(receipt));
  await assert.rejects(stageBusinessShell({ projectRoot: root, payload: payload.receipt }), /strictly equal|Expected values/);
});

test('post-pack inspection rejects a wrong Linux architecture and inherited business modules in the fixed shell', async t => {
  const root = await fixture(t), payload = await buildBusinessPayload({ ...options(root), platform: 'linux', arch: 'arm64' });
  const stage = await stageBusinessShell({ projectRoot: root, payload: payload.receipt });
  const output = join(stage.outputDirectory, 'linux-arm64-unpacked');
  await mkdir(join(output, 'resources'), { recursive: true });
  await createPackage(stage.appDirectory, join(output, 'resources/app.asar'));
  await file(output, 'resources/business/builtin.asar', await readFile(payload.file));
  const elf = Buffer.alloc(64); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf); elf.writeUInt16LE(183, 18);
  await file(output, 'data-fusion', elf); await file(output, 'version', '44.3.0');
  const inspect = afterPack(stage), context = { appOutDir: output };
  await inspect(context);
  const wrong = Buffer.from(elf); wrong.writeUInt16LE(62, 18); await file(output, 'data-fusion', wrong);
  await assert.rejects(inspect(context), /native architecture mismatch/);
  await file(output, 'data-fusion', elf);
  await file(stage.appDirectory, 'node_modules/inherited/index.js', 'must not enter the base');
  await createPackage(stage.appDirectory, join(output, 'resources/app.asar'));
  await assert.rejects(inspect(context), /fixed shell must not inherit/);
});

test('linked input paths are refused before packing', async t => {
  const root = await fixture(t);
  try { await symlink(join(root, 'node_modules/peer/index.js'), join(root, 'out/main/redirect.js')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Local account cannot create test symlinks'); throw error; }
  await assert.rejects(buildBusinessPayload(options(root)), /Linked input/);
});
