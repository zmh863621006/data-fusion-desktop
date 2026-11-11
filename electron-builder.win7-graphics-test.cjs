const legacy = require('./electron-builder.win7.cjs');

// A targeted diagnostic distribution: the existing Electron22 app and its
// official graphics compiler, without the OS/.NET prerequisite bootstrap.
module.exports = {
  ...legacy,
  directories: { ...legacy.directories, output: 'release/${version}/win7-graphics-test' },
  nsis: { ...legacy.nsis, artifactName: '数据融合助手-Win7安装修复版-${version}-${arch}.${ext}' },
};
