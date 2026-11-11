const { resolve } = require('node:path');
const common = require('./electron-builder.cjs');

// Internal Linux packages use their own runtime and output directory. Never copy
// the Windows Electron runtime or native update helper into a Linux application.
module.exports = {
  appId: common.appId,
  productName: common.productName,
  executableName: 'data-fusion',
  directories: { buildResources: 'resources', output: 'release/${version}/kylin' },
  ...(process.env.DATA_FUSION_LINUX_ELECTRON_DIST
    ? { electronDist: resolve(process.env.DATA_FUSION_LINUX_ELECTRON_DIST) } : {}),
  asar: common.asar,
  asarUnpack: common.asarUnpack,
  compression: common.compression,
  files: common.files,
  extraResources: [{ from: 'resources/app-icon.png', to: 'icons/app-icon.png' }],
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
  },
  linux: {
    target: [{ target: 'deb', arch: ['x64', 'arm64'] }],
    artifactName: '数据融合助手-麒麟版-${version}-${arch}.${ext}',
    icon: 'resources/app-icon.png',
    category: 'Office',
    synopsis: '数据回流与双公示工具',
    description: '数据融合助手麒麟版，支持业务数据回流、双公示导出及本地统计展示。',
    desktop: { entry: { Name: '数据融合助手', Comment: '数据回流与双公示工具', StartupWMClass: 'data-fusion' } },
    maintainer: '数据融合助手 <support@datafusion.local>',
  },
  deb: {
    depends: ['libgtk-3-0', 'libnss3', 'libgbm1', 'libasound2', 'libsecret-1-0', 'gnome-keyring', 'libnotify4', 'libxtst6', 'libxss1', 'libatspi2.0-0', 'libuuid1', 'libdrm2', 'libxcb1'],
    priority: 'optional',
  },
};
