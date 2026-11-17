const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync, openSync, readSync, closeSync } = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');
const { listPackage, uncache } = require('@electron/asar');

const project = resolve(__dirname, '..');
const inside = (value, root) => { const rel = relative(root, value); return rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
function ordinary(file, directory = false) {
  const info = lstatSync(file); assert(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()), 'Invalid shell stage path');
  const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  assert.equal(canonical(realpathSync(file)), canonical(file), 'Shell stage may not use reparse paths');
}
function readStage() {
  assert(process.env.DATA_FUSION_SHELL_STAGE, 'Set DATA_FUSION_SHELL_STAGE to the generated stage.json');
  const file = resolve(process.env.DATA_FUSION_SHELL_STAGE);
  assert(inside(file, join(project, '.tmp/business-shell')) && file.endsWith(sep + 'stage.json'), 'Use a generated business-shell stage');
  ordinary(file);
  const stage = JSON.parse(readFileSync(file, 'utf8'));
  assert(stage.schema === 1 && stage.stage === dirname(file) && stage.appDirectory === join(stage.stage, 'app')
    && stage.resourceDirectory === join(stage.stage, 'resources') && inside(stage.outputDirectory, project), 'Invalid shell stage metadata');
  ordinary(stage.appDirectory, true); ordinary(stage.resourceDirectory, true);
  const shell = JSON.parse(readFileSync(join(stage.appDirectory, 'shell.json'), 'utf8'));
  assert.equal(shell.product, 'data-fusion-desktop');
  assert.deepEqual(stage.target, shell.target); assert.equal(stage.shellVersion, shell.shellVersion);
  const builtin = join(stage.resourceDirectory, 'business/builtin.asar'); ordinary(builtin);
  const bytes = readFileSync(builtin);
  assert.equal(bytes.length, shell.builtin.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), shell.builtin.sha256, 'Builtin business archive changed since staging');
  return stage;
}
function afterPack(stage) {
  return async context => {
    const root = resolve(context.appOutDir), expected = resolve(stage.outputDirectory,
      stage.target.platform === 'win32' ? 'win-unpacked' : stage.target.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked');
    assert.equal(root, expected, 'Unexpected shell output directory'); ordinary(root, true);
    ordinary(join(root, 'resources/app.asar'));
    uncache(join(root, 'resources/app.asar'));
    const entries = listPackage(join(root, 'resources/app.asar')).map(name => name.replaceAll('\\', '/').replace(/^\//, '')).sort();
    assert.deepEqual(entries, ['business-bootstrap.cjs', 'business-preload.cjs', 'business-startup.html', 'business-updater.cjs', 'package.json', 'shell.json'],
      'The fixed shell must not inherit production modules or business files from electron-builder fallback dependency collection');
    assert.deepEqual(readFileSync(join(root, 'resources/business/builtin.asar')), readFileSync(join(stage.resourceDirectory, 'business/builtin.asar')),
      'Builtin business archive was not copied intact');
    if (stage.target.platform !== 'win32') {
      const machine = stage.target.arch === 'arm64' ? 183 : 62;
      for (const name of readdirSync(root)) {
        assert(!/\.(?:exe|dll)$/i.test(name), 'Windows runtime files cannot enter a Linux shell');
        if (!['data-fusion', 'chrome-sandbox', 'chrome_crashpad_handler'].includes(name) && !/\.so(?:\.\d+)*$/.test(name)) continue;
        const file = join(root, name); ordinary(file); const descriptor = openSync(file, 'r'), header = Buffer.alloc(20);
        try { assert.equal(readSync(descriptor, header, 0, 20, 0), 20); } finally { closeSync(descriptor); }
        assert(header.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) && header.readUInt16LE(18) === machine,
          `Linux shell native architecture mismatch: ${name}`);
      }
      ordinary(join(root, 'data-fusion'));
      assert.equal(readFileSync(join(root, 'version'), 'utf8').trim(), stage.electronVersion);
      return;
    }
    ordinary(join(root, 'DataFusion.exe'));
    const compiler = join(root, 'd3dcompiler_47.dll'); ordinary(compiler);
    const bytes = readFileSync(compiler);
    assert.deepEqual(bytes, readFileSync(join(stage.electronDist, 'd3dcompiler_47.dll')), 'Keep the exact Electron-bundled graphics compiler');
    assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
    const offset = bytes.readUInt32LE(60);
    assert(offset >= 64 && offset + 6 <= bytes.length && bytes.readUInt32LE(offset) === 0x4550 && bytes.readUInt16LE(offset + 4) === 0x8664);
    writeFileSync(join(root, 'resources/graphics-runtime.json'), JSON.stringify({ schema: 1, library: 'd3dcompiler_47.dll', provider: 'electron-bundled',
      bundledCompiler: true, installerPreflight: true, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2), { flag: 'wx' });
  };
}
module.exports = { readStage, afterPack };
