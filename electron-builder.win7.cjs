const { resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const common = require('./electron-builder.cjs');

// This is an internal component of the universal installer, not a user-selected
// distribution channel. The modern Electron installation remains independent.
module.exports = {
  appId: common.appId, productName: common.productName, executableName: 'DataFusion',
  directories: { app: '.tmp/win7-app', buildResources: 'resources', output: 'release/${version}/win7-component' },
  electronVersion: '22.3.27', electronDist: resolve('.tmp/win7-runtime/22.3.27/x64'),
  beforePack: async () => {
    execFileSync(process.execPath, [resolve('scripts/build-export-preserver.mjs'), '--legacy'], { windowsHide: true, stdio: 'inherit' });
    execFileSync(process.execPath, [resolve('scripts/build-windows-update-host.mjs'), '--legacy'], { windowsHide: true, stdio: 'inherit' });
  },
  npmRebuild: false, asar: true, compression: 'normal',
  files: ['out/**/*', 'package.json', '!out/**/*.map', '!out/**/*.test.*', '!**/*.pem', '!**/*.sqlite*', '!**/*.secure.json'],
  extraResources: [
    { from: 'resources/app-icon.png', to: 'icons/app-icon.png' },
    { from: 'resources/app-icon.ico', to: 'icons/app-icon.ico' },
    { from: 'resources/win7-compat/DataFusion.UpdateHost.exe', to: 'update/DataFusion.UpdateHost.exe' },
    { from: 'resources/win7-compat/DataFusion.UpdateHost.exe.config', to: 'update/DataFusion.UpdateHost.exe.config' },
    { from: 'compat/win7/node_modules', to: 'legacy-runtime/node_modules',
      filter: ['**/*', '!**/test/**', '!**/tests/**', '!**/*.map', '!**/*.pem', '!**/benchmark/**', '!**/benchmarks/**'] },
  ],
  electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true },
  win: { icon: 'resources/app-icon.ico', target: [{ target: 'nsis', arch: ['x64'] }],
    signAndEditExecutable: true, verifyUpdateCodeSignature: true },
  nsis: { ...common.nsis, include: 'resources/nsis-win7-include.nsh',
    artifactName: 'DataFusion-Win7-Component-${version}-${arch}.${ext}' },
};
