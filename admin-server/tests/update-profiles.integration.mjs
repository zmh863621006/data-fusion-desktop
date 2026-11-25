import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { createUpdateReleases } from '../update-releases.mjs';
import { installerName, installerVersion, installerDisposition, isInstallerName } from '../update-filenames.mjs';

const version = '1.2.0';
const product = '惠州数据融合助手';
const identity = { id: 'fixture-admin', role: 'admin', passwordChangeRequired: false };
const hash = value => createHash('sha256').update(value).digest('hex');

function versionBlock(key, value, children = [], type = 1) {
  const name = Buffer.from(key + '\0', 'utf16le'), header = Buffer.alloc(6), headPad = Buffer.alloc((4 - (6 + name.length) % 4) % 4);
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value ? value + '\0' : '', 'utf16le');
  const valuePad = Buffer.alloc((4 - body.length % 4) % 4), content = [header, name, headPad, body, valuePad];
  for (const child of children) content.push(child, Buffer.alloc((4 - child.length % 4) % 4));
  const result = Buffer.concat(content); result.writeUInt16LE(result.length, 0); result.writeUInt16LE(type === 1 ? body.length / 2 : body.length, 2); result.writeUInt16LE(type, 4);
  return result;
}

function installer(productName = product) {
  const bytes = Buffer.alloc(4096); bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(0x14c, 0x84); bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(224, 0x94); bytes.writeUInt16LE(0x10b, 0x98);
  const directories = 0x98 + 96; bytes.writeUInt32LE(0x1000, directories + 16); bytes.writeUInt32LE(0xc00, directories + 20);
  const section = 0x98 + 224; bytes.write('.rsrc', section); bytes.writeUInt32LE(0xc00, section + 8); bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0xc00, section + 16); bytes.writeUInt32LE(0x200, section + 20);
  for (const [relative, id, address] of [[0, 16, 0x80000020], [32, 1, 0x80000040], [64, 0x409, 96]]) {
    bytes.writeUInt16LE(1, 0x200 + relative + 14); bytes.writeUInt32LE(id, 0x200 + relative + 16); bytes.writeUInt32LE(address, 0x200 + relative + 20);
  }
  const info = versionBlock('VS_VERSION_INFO', Buffer.alloc(52), [versionBlock('StringFileInfo', '', [versionBlock('080404b0', '', [versionBlock('ProductName', productName)])])], 0);
  bytes.writeUInt32LE(0x1100, 0x200 + 96); bytes.writeUInt32LE(info.length, 0x200 + 100); info.copy(bytes, 0x300);
  Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex').copy(bytes, 0x800);
  return bytes;
}

function tar(entries) {
  const chunks = [];
  for (const [name, content] of entries) {
    assert(Buffer.byteLength(name) <= 100);
    const bytes = Buffer.from(content), header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((total, value) => total + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

function ar(members) {
  const chunks = [Buffer.from('!<arch>\n')];
  for (const [name, bytes] of members) {
    const header = (name + '/').padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(bytes.length).padEnd(10) + '`\n';
    chunks.push(Buffer.from(header), bytes, ...(bytes.length % 2 ? [Buffer.from('\n')] : []));
  }
  return Buffer.concat(chunks);
}

function shellAsar(arch, variant, mutate = () => {}) {
  const pkg = { name: 'huizhou-data-fusion-desktop', productName: product, version, main: 'business-bootstrap.cjs' };
  const shell = { schema: 1, product: 'data-fusion-desktop', deployment: 'huizhou-intranet', shellVersion: version,
    target: { platform: 'linux', arch, variant, electronMajor: 44 } };
  mutate(pkg, shell);
  const entries = { 'package.json': Buffer.from(JSON.stringify(pkg)), 'shell.json': Buffer.from(JSON.stringify(shell)),
    'business-bootstrap.cjs': Buffer.from('// fixture'), 'business-preload.cjs': Buffer.from('// fixture'), 'business-updater.cjs': Buffer.from('// fixture'), 'business-startup.html': Buffer.from('<p>fixture</p>') };
  let offset = 0; const files = {};
  for (const [name, data] of Object.entries(entries)) { files[name] = { size: data.length, offset: String(offset) }; offset += data.length; }
  const json = Buffer.from(JSON.stringify({ files })), headerBytes = 8 + json.length + (4 - json.length % 4) % 4, header = Buffer.alloc(8 + headerBytes);
  header.writeUInt32LE(4, 0); header.writeUInt32LE(headerBytes, 4); header.writeUInt32LE(headerBytes - 4, 8); header.writeUInt32LE(json.length, 12); json.copy(header, 16);
  return Buffer.concat([header, ...Object.values(entries)]);
}

const reviewedLauncher = Buffer.from((await readFile(new URL('../../resources/kirin990-launcher.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n'));
const source = JSON.parse(await readFile(new URL('../../resources/kirin990-compat/sources.json', import.meta.url), 'utf8'));
const libraries = await Promise.all(source.files.map(async entry => [entry.path, await readFile(new URL('../../resources/kirin990-compat/arm64/' + entry.path, import.meta.url))]));

function deb({ arch = 'x64', variant = 'standard', packageName = 'huizhou-data-fusion-desktop', prefix = 'opt/huizhou-data-fusion/', elfArch = arch,
  mutateShell, mutate = () => {} } = {}) {
  const elf = Buffer.alloc(64); elf.write('\x7fELF'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(elfArch === 'x64' ? 62 : 183, 18);
  const entries = new Map([
    [prefix + 'data-fusion', variant === 'kirin990' ? reviewedLauncher : elf],
    [prefix + 'resources/app.asar', shellAsar(arch, variant, mutateShell)],
    ['usr/share/applications/cn.zzkj.datafusion.huizhou.desktop', Buffer.from('[Desktop Entry]\nName=惠州数据融合助手\nType=Application\nExec=/opt/huizhou-data-fusion/data-fusion %U\nIcon=huizhou-data-fusion\nStartupWMClass=huizhou-data-fusion-desktop\n')],
    ['usr/share/icons/hicolor/512x512/apps/huizhou-data-fusion.png', Buffer.from('89504e470d0a1a0a', 'hex')],
  ]);
  let provenance;
  if (variant === 'kirin990') {
    entries.set(prefix + 'data-fusion.bin', elf);
    for (const [name, data] of libraries) entries.set(prefix + 'resources/compat/kirin990/' + name, data);
    provenance = { schema: 1, variant: 'kirin990-arm64', architecture: 'arm64', nativeExecutable: 'data-fusion.bin', launcherSha256: hash(reviewedLauncher),
      nativeSha256: hash(elf), rendererSandbox: true, systemLibrariesModified: false, graphicsMode: 'software-x11',
      files: source.files.map(entry => ({ ...entry, bytes: entries.get(prefix + 'resources/compat/kirin990/' + entry.path).length })) };
  }
  mutate(entries, provenance);
  if (provenance) entries.set(prefix + 'resources/compat/kirin990/provenance.json', Buffer.from(JSON.stringify(provenance)));
  return ar([['debian-binary', Buffer.from('2.0\n')], ['control.tar.gz', gzipSync(tar([['./control', `Package: ${packageName}\nVersion: ${version}\nArchitecture: ${arch === 'x64' ? 'amd64' : 'arm64'}\n`]]))],
    ['data.tar.gz', gzipSync(tar([...entries].map(([name, bytes]) => ['./' + name, bytes])))]]);
}

async function fixture(t, deploymentProfile = 'shenzhen') {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-installer-profile-')), db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE updates(id TEXT PRIMARY KEY,target_type TEXT,system_id TEXT,version TEXT,url TEXT,sha256 TEXT,notes TEXT,published_at INTEGER,enabled INTEGER);`);
  const options = { deploymentProfile, directory, storageMode: 'local', publicOrigin: 'https://fixture-updates.invalid', audit: () => {}, authorize: () => identity,
    transaction(work) { db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
  const releases = createUpdateReleases(db, options);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'https://fixture-updates.invalid');
      if (await releases.serve(request, response, url)) return;
      if (request.method === 'POST' && url.pathname === '/upload') {
        const result = await releases.upload(request, response, url, identity);
        response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify(result)); return;
      }
      response.writeHead(404); response.end();
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(error.status ?? 500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolveValue => server.listen(0, '127.0.0.1', resolveValue));
  t.after(async () => {
    await new Promise(resolveValue => { server.close(resolveValue); server.closeAllConnections(); });
    await releases.close(); db.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert(directory.startsWith(join(tmpdir(), 'fusion-installer-profile-')));
    await rm(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function upload(bytes, { platform = 'win32', arch = 'x64', variant = 'standard', name = installerName(version, platform, arch, variant, deploymentProfile) } = {}) {
    const response = await fetch(base + '/upload?' + new URLSearchParams({ version, platform, arch, variant, filename: name }),
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
    return { status: response.status, body: await response.json() };
  }
  return { releases, options, db, base, upload, directory };
}

test('Huizhou installer names are disjoint from Shenzhen, including generic ARM64 and Kirin990 targets', () => {
  for (const [platform, arch, variant] of [['win32', 'x64', 'standard'], ['linux', 'x64', 'standard'], ['linux', 'arm64', 'standard'], ['linux', 'arm64', 'kirin990']]) {
    const name = installerName(version, platform, arch, variant, 'huizhou');
    assert(isInstallerName(name, version, platform, arch, variant, 'huizhou'));
    assert(!isInstallerName(name, version, platform, arch, variant));
    assert.equal(installerVersion(name, 'huizhou'), version); assert.equal(installerVersion(name), null);
    assert(!isInstallerName(installerName(version, platform, arch, variant), version, platform, arch, variant, 'huizhou'));
  }
  assert(isInstallerName(`惠州数据融合助手-兼容通用安装包-${version}-x64.exe`, version, 'win32', 'x64', 'standard', 'huizhou'));
  assert(!isInstallerName(`HuizhouDataFusion-Win7-Component-${version}-x64.exe`, version, 'win32', 'x64', 'standard', 'huizhou'));
  assert(!isInstallerName(`惠州数据融合助手-麒麟测试版-${version}-arm64.deb`, version, 'linux', 'arm64', 'standard', 'huizhou'));
  assert(!isInstallerName(installerName(version, 'linux', 'arm64', 'kirin990', 'huizhou'), version, 'linux', 'arm64', 'standard', 'huizhou'));
  assert(!isInstallerName(installerName(version, 'linux', 'x64', 'kirin990', 'huizhou'), version, 'linux', 'x64', 'kirin990', 'huizhou'));
  assert.match(installerDisposition(installerName(version, 'win32', 'x64', 'standard', 'huizhou'), version, 'huizhou'), /HuizhouDataFusion-Setup/);
});

test('actual PE version resource identity rejects renamed Shenzhen and cross-profile Huizhou EXEs', async t => {
  const huizhou = await fixture(t, 'huizhou'), shenzhen = await fixture(t);
  const legacy = installer('数据融合助手');
  Buffer.from(product, 'utf16le').copy(legacy, 3000); // An arbitrary marker cannot replace RT_VERSION identity.
  assert.equal((await huizhou.upload(legacy)).status, 400);
  assert.equal((await shenzhen.upload(installer())).status, 400);
  assert.equal((await shenzhen.upload(installer(), { name: installerName(version, 'win32', 'x64', 'standard', 'huizhou') })).status, 400);
  assert.equal((await huizhou.upload(installer(), { name: installerName(version) })).status, 400);
  assert.equal((await readdir(shenzhen.directory)).length, 0);
  const original = await shenzhen.upload(legacy);
  assert.equal(original.status, 201); await shenzhen.releases.publish(original.body.id, true, {}, identity);
  const migratedHuizhou = createUpdateReleases(shenzhen.db, { ...shenzhen.options, deploymentProfile: 'huizhou' });
  try {
    assert.equal(migratedHuizhou.manifest(shenzhen.db.prepare('SELECT * FROM updates').get()), null);
    await assert.rejects(migratedHuizhou.publish(original.body.id, true, {}, identity), error => error.status === 409);
  } finally { await migratedHuizhou.close(); }
  const accepted = await huizhou.upload(installer());
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  const path = new URL(accepted.body.url).pathname;
  assert.equal((await fetch(huizhou.base + path)).status, 404);
  await huizhou.releases.publish(accepted.body.id, true, {}, identity);
  const fetched = await fetch(huizhou.base + path); assert.equal(fetched.status, 200);
  assert.match(fetched.headers.get('content-disposition'), /HuizhouDataFusion-Setup/); assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), installer());
  const migratedShenzhen = createUpdateReleases(huizhou.db, { ...huizhou.options, deploymentProfile: 'shenzhen' });
  try {
    assert.equal(migratedShenzhen.manifest(huizhou.db.prepare('SELECT * FROM updates').get()), null);
    await assert.rejects(migratedShenzhen.publish(accepted.body.id, true, {}, identity), error => error.status === 409);
  } finally { await migratedShenzhen.close(); }
  assert.equal((await readdir(shenzhen.directory)).length, 1);
});

test('Huizhou native x64 and ARM64 DEBs require new control, install prefix, desktop, icon and fixed-shell metadata', async t => {
  for (const arch of ['x64', 'arm64']) {
    const f = await fixture(t, 'huizhou'), good = await f.upload(deb({ arch }), { platform: 'linux', arch });
    assert.equal(good.status, 201, JSON.stringify(good.body));
    assert.equal(good.body.arch, arch);
  }
  const invalid = [
    { packageName: 'data-fusion-desktop' }, { prefix: 'opt/data-fusion/' }, { elfArch: 'arm64' },
    { mutateShell: pkg => { pkg.name = 'data-fusion-desktop'; } },
    { mutateShell: (_, shell) => { delete shell.deployment; } },
    { mutateShell: (_, shell) => { shell.target.arch = 'arm64'; } },
    { mutateShell: (_, shell) => { shell.target.variant = 'kirin990'; } },
    { mutate: entries => { const key = 'usr/share/applications/cn.zzkj.datafusion.huizhou.desktop'; entries.set(key, Buffer.from(entries.get(key).toString().replace('/opt/huizhou-data-fusion/', '/opt/data-fusion/'))); } },
    { mutate: entries => { entries.delete('usr/share/icons/hicolor/512x512/apps/huizhou-data-fusion.png'); } },
    { mutate: entries => { entries.set('opt/data-fusion/data-fusion', Buffer.from('other deployment')); } },
  ];
  const f = await fixture(t, 'huizhou');
  for (const input of invalid) assert.equal((await f.upload(deb(input), { platform: 'linux', arch: 'x64' })).status, 400, JSON.stringify(input));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM updates').get().n, 0);
  assert.equal((await readdir(f.directory)).length, 0);
  const shenzhen = await fixture(t);
  assert.equal((await shenzhen.upload(deb(), { platform: 'linux', arch: 'x64' })).status, 400);
});

test('Huizhou Kirin990 uses the relocated prefix while retaining the exact reviewed launcher, private libraries and licenses', async t => {
  const f = await fixture(t, 'huizhou'), target = { platform: 'linux', arch: 'arm64', variant: 'kirin990' };
  const good = await f.upload(deb({ arch: 'arm64', variant: 'kirin990' }), target);
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.equal(good.body.variant, 'kirin990');
  const tampered = await fixture(t, 'huizhou');
  for (const mutate of [
    entries => entries.set('opt/huizhou-data-fusion/data-fusion', Buffer.from('#!/bin/sh\nexit 0\n')),
    entries => entries.delete('opt/huizhou-data-fusion/resources/compat/kirin990/COPYRIGHT.libgbm1'),
    (entries, provenance) => {
      const data = Buffer.from('unreviewed private library'); entries.set('opt/huizhou-data-fusion/resources/compat/kirin990/libgbm.so.1', data);
      const entry = provenance.files.find(row => row.path === 'libgbm.so.1'); entry.bytes = data.length; entry.sha256 = hash(data);
    },
  ]) assert.equal((await tampered.upload(deb({ arch: 'arm64', variant: 'kirin990', mutate }), target)).status, 400);
  assert.equal((await tampered.upload(deb({ arch: 'arm64' }), target)).status, 400);
  assert.equal((await readdir(tampered.directory)).length, 0);
});
