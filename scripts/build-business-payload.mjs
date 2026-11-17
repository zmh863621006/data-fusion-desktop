import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackage, listPackage } from '@electron/asar';
import { PROJECT, inside, parseArguments, checkedVersion, checkedTarget, laneForTarget, checkedBackend,
  ordinary, digestFile, copyTree, excludedPath, readJson } from './business-package-common.mjs';

function packageDirectory(name, parent) {
  assert(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name), 'Invalid dependency name');
  const loader = createRequire(join(parent, 'package.json'));
  return loader.resolve.paths(name + '/package.json').map(directory => join(directory, name, 'package.json'));
}
async function productionPackages(root, dependencies) {
  const found = new Map(), missing = [];
  async function visit(name, parent, optional = false) {
    let file;
    for (const candidate of packageDirectory(name, parent)) {
      try { await ordinary(candidate); file = candidate; break; }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    if (!file) { if (!optional) missing.push(name); return; }
    const directory = dirname(file);
    assert(inside(directory, join(root, 'node_modules')), 'Production dependency escaped the project node_modules');
    if (found.has(directory)) return;
    const metadata = await readJson(file);
    assert.equal(metadata.name, name, 'Dependency name and resolved package disagree');
    found.set(directory, metadata.version);
    for (const child of Object.keys(metadata.dependencies ?? {})) await visit(child, directory, Object.hasOwn(metadata.optionalDependencies ?? {}, child));
    for (const child of Object.keys(metadata.optionalDependencies ?? {})) if (!Object.hasOwn(metadata.dependencies ?? {}, child)) await visit(child, directory, true);
    for (const child of Object.keys(metadata.peerDependencies ?? {})) await visit(child, directory, metadata.peerDependenciesMeta?.[child]?.optional === true);
  }
  for (const name of Object.keys(dependencies)) await visit(name, root);
  assert.equal(missing.length, 0, `Missing production dependencies: ${missing.join(', ')}`);
  return [...found].sort(([left], [right]) => left.localeCompare(right));
}

export async function buildBusinessPayload(options = {}) {
  const root = resolve(options.projectRoot ?? PROJECT), sourcePackage = await readJson(join(root, 'package.json'));
  const version = checkedVersion(options.version ?? sourcePackage.version);
  const target = checkedTarget({ platform: options.platform ?? process.platform, arch: options.arch ?? process.arch,
    variant: options.variant ?? 'standard', electronMajor: Number(options.electronMajor ?? 44) });
  const metadata = { schema: 1, product: 'data-fusion-desktop', version,
    minShellVersion: checkedVersion(options.minShellVersion ?? '1.1.0', 'minimum shell version'), target,
    backend: checkedBackend(options.backendOrigin ?? 'https://193.112.96.168', Number(options.backendRevision ?? 1)), entry: 'out/main/index.js' };
  const source = resolve(root, options.source ?? (target.electronMajor === 22 ? 'out-win7' : 'out'));
  assert(inside(source, root) && !excludedPath(relative(root, source).replaceAll('\\', '/')), 'Business source must be inside the project');
  for (const name of ['main/index.js', 'preload/index.js', 'renderer/index.html']) await ordinary(join(source, name));
  const output = resolve(root, options.outputRoot ?? join('release', version, 'business'), laneForTarget(target));
  assert(inside(output, root) && !inside(output, source), 'Output must stay in the project outside source');
  const stagingRoot = join(root, '.tmp/business-payload'); await mkdir(stagingRoot, { recursive: true }); await ordinary(stagingRoot, true);
  const stage = await mkdtemp(join(stagingRoot, laneForTarget(target) + '-'));
  const sourceFiles = await copyTree(source, join(stage, 'out'));
  const dependencies = target.electronMajor === 22 ? [] : await productionPackages(root, sourcePackage.dependencies ?? {});
  for (const [directory] of dependencies) await copyTree(directory, join(stage, relative(root, directory)), { skipNodeModules: true });
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: sourcePackage.name, productName: sourcePackage.productName,
    version, main: metadata.entry, author: sourcePackage.author, description: sourcePackage.description,
    license: sourcePackage.license, private: true, dependencies: target.electronMajor === 22 ? {} : sourcePackage.dependencies }, null, 2) + '\n');
  await writeFile(join(stage, 'business.json'), JSON.stringify(metadata, null, 2) + '\n');
  await mkdir(output, { recursive: true }); await ordinary(output, true);
  const temporary = join(output, `business-${version}.${Date.now()}.asar.tmp`), file = join(output, `business-${version}.asar`);
  await createPackage(stage, temporary);
  const bytes = (await ordinary(temporary)).size, sha256 = await digestFile(temporary);
  assert(bytes > 0 && bytes <= 256 * 1024 * 1024, 'Business payload exceeds 256 MB');
  const entries = listPackage(temporary).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
  assert(!entries.some(name => excludedPath(name) || name.includes('app.asar.unpacked')), 'Unexpected private/debug payload entry');
  try { await ordinary(file); assert.equal(await digestFile(file), sha256, 'A different artifact already uses this business version; choose another version or output root'); await unlink(temporary); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await rename(temporary, file); }
  const receipt = { schema: 1, file, bytes, sha256, metadata, stage, sourceDirectory: source, sourceFiles,
    productionPackages: dependencies.map(([path, packageVersion]) => ({ path: relative(root, path).replaceAll('\\', '/'), version: packageVersion })), entries: entries.length };
  await writeFile(join(output, 'payload.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { ...receipt, receipt: join(output, 'payload.json') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2), ['version', 'platform', 'arch', 'variant', 'electron-major', 'min-shell-version', 'source', 'output-root', 'backend-origin', 'backend-revision']);
  const options = Object.fromEntries(Object.entries(args).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
  const receipt = await buildBusinessPayload(options);
  console.log(JSON.stringify({ file: receipt.file, bytes: receipt.bytes, sha256: receipt.sha256, target: receipt.metadata.target, receipt: receipt.receipt }));
}
