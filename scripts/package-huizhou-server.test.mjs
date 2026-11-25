import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, unlink } from 'node:fs/promises';
import { join, basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { packageHuizhouServer } from './package-huizhou-server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'huizhou-server-package-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('huizhou-server-package-')); await rm(root, { recursive: true, force: true }); });
  async function put(path, content) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  await put('package.json', JSON.stringify({ name: 'fixture-project', version: '1.2.3', dependencies: { exceljs: '4.4.0', 'unused-client-package': '1.0.0' } }));
  await put('admin-server/server.mjs', "import './app.mjs';\n");
  await put('admin-server/app.mjs', "import ExcelJS from 'exceljs';\nimport catalog from '../src/plugins/fictional-catalog/matter-catalog.json' with { type: 'json' };\nexport {ExcelJS,catalog};\n");
  await put('src/plugins/fictional-catalog/matter-catalog.json', '[{"id":"fixture-matter","name":"虚构目录"}]');
  await put('admin-server/public/index.html', '<html><script type="module" src="/assets/app.js"></script></html>');
  await put('admin-server/public/assets/app.js', 'console.log("synthetic manager build");');
  await put('admin-server/deploy/nginx.conf.example', 'server_name intranet.example.invalid;\n');
  await put('node_modules/exceljs/package.json', JSON.stringify({ name: 'exceljs', version: '4.4.0', main: 'index.js', dependencies: { 'fixture-child': '1.0.0' }, devDependencies: { 'unused-build': '1.0.0' }, scripts: { postinstall: 'never run this' } }));
  await put('node_modules/exceljs/index.js', 'module.exports=require("./lib/doc/workbook");');
  await put('node_modules/exceljs/lib/doc/workbook.js', 'module.exports=require("fixture-child");');
  await put('node_modules/exceljs/LICENSE', 'Synthetic dependency license.');
  await put('node_modules/fixture-child/package.json', JSON.stringify({ name: 'fixture-child', version: '1.0.0', main: 'index.js' }));
  await put('node_modules/fixture-child/index.js', 'module.exports={Workbook:class Workbook{}};');
  return { root, put, build: options => packageHuizhouServer({ projectRoot: root, ...options }) };
}

test('offline server package contains catalog graph, built manager and only the required portable runtime dependency tree', async t => {
  const f = await fixture(t);
  for (const path of ['admin-server/data/admin.sqlite', 'admin-server/.env', 'private/license-private.pem', 'admin-server/tests/secrets.har',
    'admin-server/update-oss.secure.json', 'admin-server/deploy/client-tencent-http.env.example', 'node_modules/exceljs/test/fixture.json', 'node_modules/exceljs/.env', 'node_modules/exceljs/index.js.map', 'src/plugins/unreferenced/private.json']) await f.put(path, 'must never be copied');
  const result = await f.build(), manifestText = await readFile(result.manifest, 'utf8'), manifest = JSON.parse(manifestText);
  const paths = manifest.files.map(file => file.path);
  assert(paths.includes('admin-server/app.mjs')); assert(paths.includes('src/plugins/fictional-catalog/matter-catalog.json'));
  assert(paths.includes('admin-server/public/assets/app.js')); assert(paths.includes('admin-server/deploy/nginx.conf.example'));
  assert(paths.includes('node_modules/exceljs/LICENSE')); assert(paths.includes('node_modules/fixture-child/index.js'));
  assert(paths.includes('node_modules/exceljs/lib/doc/workbook.js'));
  assert.equal(manifest.dependencies.length, 2); assert(!manifestText.includes(f.root));
  assert(!paths.some(path => /private|\.env$|\.secure\.json|\.sqlite|\.har|\/test\/|\.map$|tencent|unreferenced/.test(path)));
  const metadata = JSON.parse(await readFile(join(result.output, 'node_modules/exceljs/package.json'), 'utf8'));
  assert.equal(metadata.scripts, undefined); assert.equal(metadata.devDependencies, undefined);
  const loader = createRequire(join(result.output, 'package.json')); assert.equal(typeof loader('exceljs').Workbook, 'function');
  for (const file of manifest.files) { const bytes = await readFile(join(result.output, file.path)); assert.equal(bytes.length, file.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256); }
  assert.equal((await f.build()).reused, true); assert.equal(result.reused, false);
});

test('missing imported JSON, missing transitive packages and missing manager assets fail before publication', async t => {
  for (const missing of ['src/plugins/fictional-catalog/matter-catalog.json', 'node_modules/fixture-child/package.json', 'admin-server/public/assets/app.js']) {
    const f = await fixture(t); await unlink(join(f.root, missing)); await assert.rejects(f.build());
    assert.deepEqual((await readdir(join(f.root, 'release'))).filter(name => !name.endsWith('.lock')), []);
  }
});

test('native runtime artifacts, actual deployment addresses and credential values are rejected', async t => {
  for (const [path, content] of [['node_modules/exceljs/addon.node', 'not a pure JS dependency'],
    ['admin-server/app.mjs', 'export const backend="https://10.20.30.40";'],
    ['admin-server/deploy/huizhou-intranet.env.example', 'ALIYUN_ENTERPRISE_APPCODE=synthetic-but-nonempty-secret\n']]) {
    const f = await fixture(t); await f.put(path, content); await assert.rejects(f.build(), /Native runtime|Deployment address|Credential value/);
  }
});

test('existing altered bytes or extra files are never overwritten and failed staging is cleaned without touching the prior package', async t => {
  const f = await fixture(t), built = await f.build(), target = join(built.output, 'admin-server/app.mjs');
  await writeFile(target, 'modified existing content'); await assert.rejects(f.build(), /modified package/); assert.equal(await readFile(target, 'utf8'), 'modified existing content');
  await writeFile(target, await readFile(join(f.root, 'admin-server/app.mjs'))); await writeFile(join(built.output, 'unexpected.txt'), 'keep existing file');
  await assert.rejects(f.build(), /different package/); assert.equal(await readFile(join(built.output, 'unexpected.txt'), 'utf8'), 'keep existing file');
  assert.deepEqual((await readdir(join(f.root, 'release'))).sort(), ['huizhou-server']);
});

test('symlink inputs/outputs and source or outside output paths are rejected', async t => {
  const f = await fixture(t); await f.put('actual.js', 'module.exports={};');
  await unlink(join(f.root, 'node_modules/exceljs/index.js')); await symlink(join(f.root, 'actual.js'), join(f.root, 'node_modules/exceljs/index.js'), 'file');
  await assert.rejects(f.build(), /Symbolic links/); await unlink(join(f.root, 'node_modules/exceljs/index.js')); await f.put('node_modules/exceljs/index.js', 'module.exports={};');
  await mkdir(join(f.root, 'release'), { recursive: true }); await mkdir(join(f.root, 'destination'));
  await symlink(join(f.root, 'destination'), join(f.root, 'release/linked'), 'junction'); await assert.rejects(f.build({ output: 'release/linked' }), /Symbolic links/); await unlink(join(f.root, 'release/linked'));
  for (const output of ['../outside', 'admin-server/delivery', 'node_modules/delivery', '.']) await assert.rejects(f.build({ output }), /Output must be/);
});
