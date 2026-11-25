const { resolve, join } = require('node:path');
const linux = require('./electron-builder.linux.cjs');
const { readStage, afterPack } = require('./scripts/business-shell-config.cjs');
const stage = readStage();
const huizhou = stage.deployment === 'huizhou-intranet';
if (stage.target.platform !== 'linux') throw Error('Linux shell config requires a Linux business target');
module.exports = {
  appId: huizhou ? 'cn.zzkj.datafusion.huizhou.desktop' : linux.appId, productName: huizhou ? '惠州数据融合助手' : linux.productName, executableName: linux.executableName,
  directories: { app: stage.appDirectory, buildResources: resolve(__dirname, 'resources'), output: stage.outputDirectory },
  electronVersion: stage.electronVersion, ...(stage.electronDist ? { electronDist: stage.electronDist } : {}), npmRebuild: false,
  asar: true, compression: linux.compression,
  files: ['package.json', 'shell.json', 'business-bootstrap.cjs', 'business-preload.cjs', 'business-startup.html', 'business-updater.cjs', '!**/node_modules/**'],
  extraResources: [...linux.extraResources, { from: join(stage.resourceDirectory, 'business/builtin.asar'), to: 'business/builtin.asar' }],
  electronFuses: linux.electronFuses, afterPack: afterPack(stage),
  linux: { ...linux.linux, target: [{ target: 'dir', arch: [stage.target.arch] }],
    artifactName: linux.linux.artifactName },
  deb: linux.deb,
};
