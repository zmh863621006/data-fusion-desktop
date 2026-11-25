import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, uncache } from '@electron/asar';
import { PROJECT, DEFAULT_FEED_BASE, inside, parseArguments, checkedVersion, checkedTarget, laneForTarget,
  checkedBackend, checkedFeed, ordinary, digestFile, readJson } from './business-package-common.mjs';

export async function stageBusinessShell(options = {}) {
  const root = resolve(options.projectRoot ?? PROJECT), payloadPath = resolve(root, options.payload ?? '');
  assert(inside(payloadPath, root), 'Payload receipt must stay in the project');
  const payload = await readJson(payloadPath), source = await readJson(join(root, 'package.json'));
  const metadata = payload.metadata, target = checkedTarget(metadata?.target);
  assert(options.deployment === undefined || options.deployment === 'huizhou-intranet', 'Invalid fixed-shell deployment identity');
  const huizhou = options.deployment === 'huizhou-intranet';
  assert.deepEqual(target, metadata.target, 'Unexpected business target fields');
  assert(metadata.schema === 1 && metadata.product === 'data-fusion-desktop' && metadata.entry === 'out/main/index.js', 'Invalid business payload identity');
  checkedVersion(metadata.version); checkedVersion(metadata.minShellVersion);
  checkedBackend(metadata.backend?.origin, metadata.backend?.revision);
  assert(inside(resolve(payload.file), root), 'Business payload escaped the project');
  assert.equal((await ordinary(payload.file)).size, payload.bytes); assert.equal(await digestFile(payload.file), payload.sha256);
  uncache(payload.file);
  assert.deepEqual(JSON.parse(extractFile(payload.file, 'business.json').toString('utf8')), metadata, 'Payload metadata differs from receipt');
  const version = checkedVersion(options.shellVersion ?? metadata.minShellVersion, 'shell version');
  const shellParts = version.split('.').map(Number), minimumParts = metadata.minShellVersion.split('.').map(Number);
  const firstDifference = shellParts.findIndex((part, index) => part !== minimumParts[index]);
  assert(firstDifference < 0 || shellParts[firstDifference] > minimumParts[firstDifference], 'Shell version is below the payload minimum');
  const runtimeSource = await readFile(join(root, 'src/main/runtime.ts'), 'utf8');
  const publicKey = runtimeSource.match(/const PRODUCT_PUBLIC_KEY = `([\s\S]*?)`;/)?.[1];
  assert(publicKey && createPublicKey(publicKey).asymmetricKeyType === 'rsa', 'Product RSA public key is missing');
  const stagingRoot = join(root, '.tmp/business-shell'); await mkdir(stagingRoot, { recursive: true }); await ordinary(stagingRoot, true);
  const stage = await mkdtemp(join(stagingRoot, laneForTarget(target) + '-'));
  const appDirectory = join(stage, 'app'), resourceDirectory = join(stage, 'resources');
  await mkdir(appDirectory); await mkdir(join(resourceDirectory, 'business'), { recursive: true });
  const resources = ['business-bootstrap.cjs', 'business-preload.cjs', 'business-startup.html', 'business-updater.cjs'];
  for (const name of resources) { const file = join(root, 'resources', name); await ordinary(file); await copyFile(file, join(appDirectory, name)); }
  await copyFile(payload.file, join(resourceDirectory, 'business/builtin.asar'));
  const shell = { schema: 1, product: 'data-fusion-desktop', shellVersion: version, baseBusinessVersion: metadata.version,
    ...(huizhou ? { deployment: 'huizhou-intranet' } : {}),
    target, feedBase: checkedFeed(options.feedBase ?? DEFAULT_FEED_BASE), publicKey,
    builtin: { bytes: payload.bytes, sha256: payload.sha256, version: metadata.version, backend: metadata.backend, minShellVersion: metadata.minShellVersion } };
  await writeFile(join(appDirectory, 'shell.json'), JSON.stringify(shell, null, 2) + '\n');
  await writeFile(join(appDirectory, 'package.json'), JSON.stringify({ name: huizhou ? 'huizhou-data-fusion-desktop' : source.name, productName: huizhou ? '惠州数据融合助手' : source.productName,
    version, author: source.author, description: source.description, license: source.license, private: true,
    main: 'business-bootstrap.cjs', dependencies: {} }, null, 2) + '\n');
  const outputDirectory = resolve(root, options.outputRoot ?? join('release', version, 'shell'), laneForTarget(target));
  assert(inside(outputDirectory, root) && !inside(outputDirectory, stage), 'Invalid shell output directory');
  const electronVersion = target.electronMajor === 22 ? '22.3.27' : JSON.parse(await readFile(join(root, 'node_modules/electron/package.json'), 'utf8')).version;
  assert.equal(Number(electronVersion.split('.')[0]), target.electronMajor, 'Electron runtime version and target disagree');
  const electronDist = target.electronMajor === 22 ? resolve(root, '.tmp/win7-runtime/22.3.27/x64')
    : target.platform === 'win32' ? resolve(root, 'node_modules/electron/dist')
      : options.electronDist ? resolve(root, options.electronDist) : process.env.DATA_FUSION_LINUX_ELECTRON_DIST ? resolve(process.env.DATA_FUSION_LINUX_ELECTRON_DIST) : null;
  if (electronDist) {
    await ordinary(electronDist, true); await ordinary(join(electronDist, 'version'));
    assert.equal((await readFile(join(electronDist, 'version'), 'utf8')).trim(), electronVersion, 'Selected Electron distribution version differs from the shell target');
  }
  const receipt = { schema: 1, stage, appDirectory, resourceDirectory, outputDirectory, target, shellVersion: version,
    ...(huizhou ? { deployment: 'huizhou-intranet' } : {}),
    baseBusinessVersion: metadata.version, payload: { file: payload.file, bytes: payload.bytes, sha256: payload.sha256 },
    electronVersion, electronDist, shellJson: join(appDirectory, 'shell.json') };
  await writeFile(join(stage, 'stage.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { ...receipt, receipt: join(stage, 'stage.json') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2), ['payload', 'shell-version', 'feed-base', 'output-root', 'electron-dist', 'deployment']);
  assert(args.payload, 'Usage: node scripts/stage-business-shell.mjs --payload <payload.json>');
  const options = Object.fromEntries(Object.entries(args).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
  const stage = await stageBusinessShell(options); console.log(JSON.stringify(stage));
}
