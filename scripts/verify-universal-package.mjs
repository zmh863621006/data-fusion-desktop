import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { extractFile, listPackage } from '@electron/asar';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const directory = resolve(`release/${version}/universal`);
const manifest = JSON.parse(await readFile(join(directory, 'universal-manifest.json'), 'utf8'));
const sevenZip = resolve('node_modules/electron-winstaller/vendor/7z.exe');
const work = await mkdtemp(join(tmpdir(), 'fusion-final-universal-'));
const hash = data => createHash('sha256').update(data).digest('hex');
const extract = (archive, entry, destination, outer = false) => {
  const descriptor = openSync(destination, 'wx');
  try { execFileSync(sevenZip, ['x', '-so', ...(outer ? ['-tNsis'] : []), archive, entry], { windowsHide: true, stdio: ['ignore', descriptor, 'pipe'] }); }
  finally { closeSync(descriptor); }
};
try {
  assert.equal(hash(await readFile(manifest.file)), manifest.sha256);
  assert.deepEqual(manifest.prerequisites, []);
  assert.equal(manifest.automaticPrerequisites, false);
  const listing = execFileSync(sevenZip, ['l', '-slt', '-tNsis', manifest.file], { windowsHide: true, encoding: 'utf8' });
  const outerEntries = [...listing.matchAll(/^Path = (\$PLUGINSDIR[^\r\n]*)/gm)].map(match => match[1].trim());
  assert.deepEqual(outerEntries.sort(), ['$PLUGINSDIR\\System.dll', '$PLUGINSDIR\\DataFusion-Modern-Setup.exe', '$PLUGINSDIR\\DataFusion-Legacy-Setup.exe'].sort());
  const reports = [];
  for (const component of manifest.components) {
    const track = component.track;
    const child = join(work, `${track}.exe`);
    extract(manifest.file, `$PLUGINSDIR\\DataFusion-${track === 'legacy' ? 'Legacy' : 'Modern'}-Setup.exe`, child, true);
    assert.equal(hash(await readFile(child)), component.sha256, 'Embedded component differs from its tested build');
    const helper = execFileSync(sevenZip, ['x', '-so', '-tNsis', child, '$PLUGINSDIR\\DataFusion.ExportPreserver.exe'], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const expectedHelper = track === 'legacy' ? 'resources/win7-compat/DataFusion.ExportPreserver.exe' : 'resources/DataFusion.ExportPreserver.exe';
    assert.deepEqual(helper, await readFile(expectedHelper));
    if (track === 'legacy') {
      const legacyDirectory = join(work, 'legacy-check');
      await mkdir(legacyDirectory);
      const executable = join(legacyDirectory, 'DataFusion.ExportPreserver.exe');
      await writeFile(executable, helper);
      const config = execFileSync(sevenZip, ['x', '-so', '-tNsis', child, '$PLUGINSDIR\\DataFusion.ExportPreserver.exe.config'], { windowsHide: true });
      await writeFile(executable + '.config', config);
      assert(helper.includes(Buffer.from('v2.0.50727')));
      const dll = execFileSync(sevenZip, ['x', '-so', '-tNsis', child, '$PLUGINSDIR\\d3dcompiler_47.dll'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      assert.deepEqual(dll, await readFile('.tmp/win7-runtime/22.3.27/x64/d3dcompiler_47.dll'));
      await writeFile(join(legacyDirectory, 'd3dcompiler_47.dll'), dll);
      const check = spawnSync(executable, ['CheckLegacyGraphics'], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
      assert.equal(check.status, 0, check.stdout + check.stderr);
      assert.match(check.stdout, /legacy_bundled_graphics_verified/);
    } else {
      const modernDirectory = join(work, 'modern-check');
      await mkdir(modernDirectory);
      const executable = join(modernDirectory, 'DataFusion.ExportPreserver.exe');
      await writeFile(executable, helper);
      const dll = execFileSync(sevenZip, ['x', '-so', '-tNsis', child, '$PLUGINSDIR\\d3dcompiler_47.dll'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      assert.deepEqual(dll, await readFile('node_modules/electron/dist/d3dcompiler_47.dll'));
      await writeFile(join(modernDirectory, 'd3dcompiler_47.dll'), dll);
      const check = spawnSync(executable, ['CheckBundledGraphics'], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
      assert.equal(check.status, 0, check.stdout + check.stderr);
      assert.match(check.stdout, /bundled_graphics_verified/);
    }
    const childListing = execFileSync(sevenZip, ['l', '-tNsis', child], { windowsHide: true, encoding: 'utf8' });
    const payloadEntry = childListing.split(/\r?\n/).map(line => line.match(/\$PLUGINSDIR\\[^\r\n]+\.7z$/)?.[0]).find(Boolean);
    assert(payloadEntry);
    const payload = join(work, `${track}.7z`);
    extract(child, payloadEntry, payload, true);
    const updateHost = execFileSync(sevenZip, ['x', '-so', payload, 'resources/update/DataFusion.UpdateHost.exe'], { windowsHide: true, maxBuffer: 1024 * 1024 });
    assert.deepEqual(updateHost, await readFile(track === 'legacy' ? 'resources/win7-compat/DataFusion.UpdateHost.exe' : 'resources/DataFusion.UpdateHost.exe'));
    if (track === 'legacy') {
      assert(updateHost.includes(Buffer.from('v2.0.50727')));
      const hostConfig = execFileSync(sevenZip, ['x', '-so', payload, 'resources/update/DataFusion.UpdateHost.exe.config'], { windowsHide: true });
      assert.deepEqual(hostConfig, await readFile('resources/win7-compat/DataFusion.UpdateHost.exe.config'));
    }
    const appGraphics = execFileSync(sevenZip, ['x', '-so', payload, 'd3dcompiler_47.dll'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    assert.deepEqual(appGraphics, await readFile(track === 'legacy'
      ? '.tmp/win7-runtime/22.3.27/x64/d3dcompiler_47.dll' : 'node_modules/electron/dist/d3dcompiler_47.dll'));
    const archive = join(work, `${track}.asar`);
    extract(payload, 'resources/app.asar', archive);
    const unpacked = track === 'legacy' ? `release/${version}/win7-component/win-unpacked` : `release/${version}/win-unpacked`;
    assert.equal(hash(await readFile(archive)), hash(await readFile(join(unpacked, 'resources/app.asar'))));
    const files = listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
    for (const file of files) {
      assert(['out', 'node_modules', 'package.json'].includes(file.split('/')[0]));
      assert(!/(?:^|\/)(?:private|admin-server|\.tmp|local-data)(?:\/|$)|\.(?:pem|sqlite3?|secure\.json)$|(?:^|\/)\.env(?:\.|$)/i.test(file));
    }
    assert.equal(JSON.parse(extractFile(archive, 'package.json')).version, version);
    const main = extractFile(archive, join('out', 'main', 'index.js')).toString();
    if (track === 'legacy') {
      assert(main.includes('Win7 兼容测试版暂未开放在线更新'));
      const sqlite = await readFile(join(unpacked, 'resources/legacy-runtime/node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
      assert.equal(hash(sqlite), '86075d4bf0a25d6d86206144bf793fe5e6e19a581dcd0ae138bcf0170a55fe01');
    }
    reports.push({ track, bytes: component.bytes, embeddedComponentSha256: component.sha256,
      currentBuildMatched: true, privateArtifactsExcluded: true, officialGraphicsBundled: true, helperRuntime: component.preservationRuntime });
  }
  const detectionPath = join(tmpdir(), `DataFusion-Universal-${version}-platform.txt`);
  const check = spawnSync(manifest.file, ['/CHECKOS', '/S'], { windowsHide: true, timeout: 30000 });
  assert.equal(check.status, 0, String(check.error ?? ''));
  const detection = await readFile(detectionPath, 'utf8');
  assert.match(detection, /runtime=modern/);
  assert.match(detection, /prerequisites=none/);
  await rm(detectionPath);
  const result = { passed: true, artifact: manifest.file, bytes: manifest.bytes, sha256: manifest.sha256,
    finalExeInspected: true, finalExeCheckOnlyPassed: true, actualInstallationPerformed: false,
    actualHost: 'Windows10', systemUpdatesBundled: false, published: false, reports };
  const evidence = resolve('private/deploy', `universal-${version}`);
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'final-package.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  assert.equal(dirname(resolve(work)), resolve(tmpdir()));
  assert(basename(work).startsWith('fusion-final-universal-'));
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
