import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtins = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)]);
const normal = value => value.split(sep).join('/');
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (path, root) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const forbidden = path => path.split('/').some(part => /^\.|^(?:data|private|tests?|fixtures?|examples?|coverage|__tests__|__fixtures__|\.git)$/i.test(part))
  || /(?:\.secure\.json|\.(?:har|db|sqlite\d*|pem|key|pfx|p12|log|map)|(?:^|\/)credentials[^/]*)$/i.test(path);
const deploymentFiles = ['data-fusion-admin.service.example', 'nginx.conf.example', 'runtime-image.env.example', 'huizhou-intranet.env.example'];
const dependencyExtensions = new Set(['.js', '.cjs', '.mjs', '.json', '.xml', '.txt']);
const publicExtensions = new Set(['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.json']);

async function absent(path) { try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }
async function safeAncestors(path) {
  for (let current = resolve(path);; current = dirname(current)) {
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    assert(!info?.isSymbolicLink(), 'Symbolic links are forbidden in package paths');
    if (dirname(current) === current) break;
  }
}
async function ordinary(path, directory = false) {
  await safeAncestors(path); const info = await lstat(path);
  assert(directory ? info.isDirectory() : info.isFile(), 'Expected an ordinary package file/directory'); return info;
}
async function entries(root, skip = () => false, prefix = '') {
  await ordinary(root, true); const result = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    assert(!entry.isSymbolicLink(), 'Symbolic links are forbidden in package inputs');
    if (skip(path, entry)) continue;
    if (entry.isDirectory()) result.push(...await entries(join(root, entry.name), skip, path));
    else { await ordinary(join(root, entry.name)); result.push(path); }
  }
  return result;
}
function safeSource(bytes, path) {
  const text = bytes.toString('utf8');
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text), `Private key material in ${path}`);
  // IP-shaped SVG path coordinates are not deployment addresses. Require a
  // host/literal/configuration context instead of searching arbitrary digits.
  for (const match of text.matchAll(/https?:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?=[:/'"\s]|$)|(?:^|[='"])(\d{1,3}(?:\.\d{1,3}){3})(?=[,'"\s]|$)/gm)) {
    const parts = (match[1] ?? match[2]).split('.').map(Number); if (parts.some(part => part > 255)) continue;
    const safe = parts[0] === 127 || parts.every(part => part === 0) || parts.every(part => part === 255)
      || parts.slice(0, 3).join('.') === '192.0.2' || parts.slice(0, 3).join('.') === '198.51.100' || parts.slice(0, 3).join('.') === '203.0.113';
    assert(safe, `Deployment address must be external configuration, not packaged in ${path}`);
  }
  if (path.endsWith('.env.example')) for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|APPCODE)[A-Z0-9_]*)=(.*)$/.exec(line);
    assert(!match || match[2].trim() === '' || /^<?(?:CHANGE_ME|YOUR_|EXAMPLE|PLACEHOLDER)/i.test(match[2]), `Credential value in ${path}`);
  }
}
function imports(text) {
  const values = [];
  for (const match of text.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?(['"])([^'"\r\n]+)\1/g)) values.push(match[2]);
  for (const match of text.matchAll(/\bimport\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g)) values.push(match[2]);
  return values;
}
function dependencyName(specifier) {
  const match = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+/i.exec(specifier);
  assert(match && (specifier === match[0] || specifier.startsWith(match[0] + '/')), 'Unsupported runtime dependency import'); return match[0];
}

export async function packageHuizhouServer(options = {}) {
  const root = resolve(options.projectRoot ?? PROJECT), output = resolve(root, options.output ?? 'release/huizhou-server');
  await ordinary(root, true);
  assert(inside(output, root) && !['admin-server', 'src', 'scripts', 'node_modules', 'private'].includes(normal(relative(root, output)).split('/')[0]), 'Output must be inside the project outside source/private directories');
  await safeAncestors(output); await mkdir(dirname(output), { recursive: true }); await ordinary(dirname(output), true);
  const lockPath = output + '.packaging.lock', lock = await open(lockPath, 'wx', 0o600);
  let stage;
  try {
    const files = new Map(), packageRoots = new Map(), visited = new Set(), runtimeDependencies = new Set();
    async function addFile(path, destination = normal(relative(root, path)), sourceCheck = true, generated) {
      assert(destination && !destination.startsWith('/') && !destination.split('/').includes('..'), 'Unsafe package destination');
      if (path !== null) await ordinary(path);
      const bytes = generated ?? await readFile(path);
      if (sourceCheck) safeSource(bytes, destination);
      assert(!files.has(destination), `Duplicate package destination ${destination}`); files.set(destination, bytes);
    }
    async function visitModule(path) {
      path = resolve(path); if (visited.has(path)) return; visited.add(path);
      const destination = normal(relative(root, path));
      assert(inside(path, root) && !forbidden(destination), 'Module dependency escaped the approved source roots');
      assert(destination.startsWith('admin-server/') && extname(path) === '.mjs' || destination.startsWith('src/') && extname(path) === '.json', 'Only backend modules and referenced catalog JSON may be packaged');
      await ordinary(path); const bytes = await readFile(path); await addFile(path, destination, true, bytes);
      if (extname(path) === '.json') { JSON.parse(bytes); return; }
      for (const specifier of imports(bytes.toString('utf8'))) {
        if (builtins.has(specifier)) continue;
        if (specifier.startsWith('.')) await visitModule(resolve(dirname(path), specifier));
        else runtimeDependencies.add(dependencyName(specifier));
      }
    }
    const backend = join(root, 'admin-server'); await ordinary(backend, true);
    const modules = (await readdir(backend, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.mjs'));
    assert(modules.some(entry => entry.name === 'server.mjs') && modules.some(entry => entry.name === 'app.mjs'), 'Backend entry modules are missing');
    for (const module of modules) await visitModule(join(backend, module.name));
    const publicRoot = join(backend, 'public'); await ordinary(join(publicRoot, 'index.html'));
    const publicFiles = await entries(publicRoot, (path, entry) => forbidden(path) || !entry.isDirectory() && !publicExtensions.has(extname(path).toLowerCase()));
    for (const path of publicFiles) {
      assert(path === 'index.html' || path.startsWith('assets/') || path.startsWith('system-icons/'), 'Unrecognized file in built admin public directory');
      await addFile(join(publicRoot, path), 'admin-server/public/' + path, ['.html', '.js', '.css', '.svg', '.json'].includes(extname(path)));
    }
    const html = (await readFile(join(publicRoot, 'index.html'), 'utf8'));
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const path = match[1].replace(/^\//, ''); if (path.startsWith('assets/')) assert(files.has('admin-server/public/' + path), 'Built admin HTML references a missing asset');
    }
    for (const name of deploymentFiles) {
      const path = join(backend, 'deploy', name); if (!await absent(path)) await addFile(path, 'admin-server/deploy/' + name);
    }
    async function visitPackage(name, parent, optional = false) {
      assert(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name), 'Invalid dependency name');
      // Older CSV packages declare TS declarations as production dependencies.
      // They have no JS entry and cannot be part of the Node runtime closure.
      if (name.startsWith('@types/')) return;
      const loader = createRequire(join(parent, 'package.json')); let manifestPath;
      // Some third-party packages deliberately shadow builtins (notably
      // string_decoder/); asking for package.json avoids Node's builtin fast path.
      for (const directory of loader.resolve.paths(name + '/package.json') ?? []) {
        const candidate = join(directory, name, 'package.json'); if (!await absent(candidate)) { manifestPath = candidate; break; }
      }
      if (!manifestPath) { assert(optional, `Missing production dependency: ${name}`); return; }
      assert(inside(manifestPath, join(root, 'node_modules')), `Dependency ${name} escaped project node_modules`);
      await ordinary(manifestPath); const directory = dirname(manifestPath);
      if (packageRoots.has(directory)) return;
      const metadata = JSON.parse(await readFile(manifestPath, 'utf8'));
      assert(metadata.name === name && typeof metadata.version === 'string', `Dependency identity mismatch: ${name}`);
      packageRoots.set(directory, { name, version: metadata.version, path: normal(relative(root, directory)) });
      for (const [child] of Object.entries(metadata.dependencies ?? {})) await visitPackage(child, directory, Object.hasOwn(metadata.optionalDependencies ?? {}, child));
      for (const child of Object.keys(metadata.optionalDependencies ?? {})) if (!Object.hasOwn(metadata.dependencies ?? {}, child)) await visitPackage(child, directory, true);
      for (const child of Object.keys(metadata.peerDependencies ?? {})) await visitPackage(child, directory, metadata.peerDependenciesMeta?.[child]?.optional === true);
      const paths = await entries(directory, (path, entry) => path.split('/').includes('node_modules') || forbidden(path)
        || entry.isDirectory() && !path.includes('/') && /^(?:docs?|benchmark|spec|examples?|testdata|typings)$/i.test(path));
      for (const path of paths) {
        assert(!/\.(?:node|dll|so(?:\.\d+)*|dylib|exe|wasm)$/i.test(path), `Native runtime dependency is not permitted: ${name}`);
        if (path === 'package.json') continue;
        if (dependencyExtensions.has(extname(path)) || /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[.-].*)?$/i.test(basename(path)))
          await addFile(join(directory, path), normal(relative(root, join(directory, path))), false);
      }
      const portable = Object.fromEntries(Object.entries(metadata).filter(([key]) => !['scripts', 'devDependencies', '_where', '_resolved', '_integrity', '_from', 'repository', 'homepage', 'bugs', 'funding', 'author', 'contributors', 'maintainers'].includes(key)));
      for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) if (portable[key]) portable[key] = Object.fromEntries(Object.entries(portable[key]).filter(([name]) => !name.startsWith('@types/')));
      await addFile(manifestPath, normal(relative(root, manifestPath)), false, Buffer.from(JSON.stringify(portable, null, 2) + '\n'));
      const entry = builtins.has(name) ? loader.resolve(directory) : loader.resolve(name); assert(inside(entry, directory), `Runtime entry escaped ${name}`);
      assert(files.has(normal(relative(root, entry))), `Runtime entry excluded for ${name}`);
    }
    for (const name of [...runtimeDependencies].sort()) await visitPackage(name, root);
    const sourcePackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const dependencies = [...packageRoots.values()].sort((a, b) => a.path.localeCompare(b.path));
    const direct = Object.fromEntries([...runtimeDependencies].sort().map(name => [name, dependencies.find(item => item.path === 'node_modules/' + name)?.version]));
    await addFile(null, 'package.json', false, Buffer.from(JSON.stringify({ name: 'data-fusion-huizhou-server', version: sourcePackage.version,
      private: true, type: 'module', engines: { node: '>=24 <25' }, scripts: { start: 'node admin-server/server.mjs' }, dependencies: direct }, null, 2) + '\n'));
    const manifest = { schema: 1, product: 'data-fusion-huizhou-server', sourcePackageVersion: sourcePackage.version,
      runtime: { node: '24.x', command: 'node admin-server/server.mjs' }, dependencies,
      files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'); files.set('server-package.json', manifestBytes);
    stage = await mkdtemp(join(dirname(output), '.huizhou-server-'));
    for (const [path, bytes] of files) { const destination = join(stage, path); assert(inside(destination, stage), 'Staging path escaped'); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes, { flag: 'wx', mode: 0o644 }); }
    if (!await absent(output)) {
      const existing = await entries(output); assert.deepEqual(existing.sort(), [...files.keys()].sort(), 'A different package already exists at output');
      for (const [path, bytes] of files) assert.equal(hash(await readFile(join(output, path))), hash(bytes), 'A different or modified package already exists at output');
      return { output, reused: true, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), dependencies: dependencies.length, manifest: join(output, 'server-package.json') };
    }
    await safeAncestors(output); await rename(stage, output); stage = undefined;
    return { output, reused: false, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), dependencies: dependencies.length, manifest: join(output, 'server-package.json') };
  } finally {
    if (stage) { assert(inside(stage, dirname(output)) && basename(stage).startsWith('.huizhou-server-'), 'Refusing unsafe staging cleanup'); await safeAncestors(stage); await rm(stage, { recursive: true, force: true }); }
    await lock.close(); await unlink(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); assert(args.length === 0 || args.length === 2 && args[0] === '--output', 'Usage: node scripts/package-huizhou-server.mjs [--output release/name]');
  console.log(JSON.stringify(await packageHuizhouServer({ output: args[1] })));
}
