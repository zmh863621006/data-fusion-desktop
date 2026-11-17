const { resolve, join } = require('node:path');
const { execFileSync } = require('node:child_process');
const common = require('./electron-builder.cjs');
const legacy = require('./electron-builder.win7.cjs');
const { readStage, afterPack } = require('./scripts/business-shell-config.cjs');
const stage = readStage();
if (stage.target.platform !== 'win32') throw Error('Windows shell config requires a Windows business target');
const win7 = stage.target.electronMajor === 22;
module.exports = {
  appId: common.appId, productName: common.productName, executableName: common.executableName,
  directories: { app: stage.appDirectory, buildResources: resolve(__dirname, 'resources'), output: stage.outputDirectory },
  electronVersion: stage.electronVersion, electronDist: stage.electronDist, npmRebuild: false,
  beforePack: async () => {
    for (const name of ['build-export-preserver.mjs', 'build-windows-update-host.mjs']) execFileSync(process.execPath,
      [resolve(__dirname, 'scripts', name), ...(win7 ? ['--legacy'] : [])], { cwd: __dirname, windowsHide: true, stdio: 'inherit' });
  },
  asar: true, compression: common.compression,
  files: ['package.json', 'shell.json', 'business-bootstrap.cjs', 'business-preload.cjs', 'business-startup.html', 'business-updater.cjs', '!**/node_modules/**'],
  extraResources: [...(win7 ? legacy.extraResources : common.extraResources),
    { from: join(stage.resourceDirectory, 'business/builtin.asar'), to: 'business/builtin.asar' }],
  electronFuses: win7 ? legacy.electronFuses : common.electronFuses,
  afterPack: afterPack(stage),
  win: { ...common.win, target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }],
    artifactName: `数据融合助手-免安装版${win7 ? '-Win7' : ''}-` + '${version}-${arch}.${ext}' },
  nsis: { ...common.nsis, include: win7 ? legacy.nsis.include : common.nsis.include,
    artifactName: win7 ? 'DataFusion-Win7-Component-${version}-${arch}.${ext}' : common.nsis.artifactName },
};
