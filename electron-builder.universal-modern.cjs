const common = require('./electron-builder.cjs');
module.exports = {
  ...common,
  win: { ...common.win, target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: { ...common.nsis, artifactName: 'DataFusion-Modern-Component-${version}-${arch}.${ext}' },
};
