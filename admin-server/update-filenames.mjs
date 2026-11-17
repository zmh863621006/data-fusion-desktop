export const RELEASE_VERSION_PATTERN = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;

export function releaseTarget(platform = 'win32', arch = 'x64', variant = 'standard') {
  if (!['win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch) || platform === 'win32' && arch !== 'x64'
    || !['standard', 'kirin990'].includes(variant) || variant === 'kirin990' && (platform !== 'linux' || arch !== 'arm64')) return null;
  return { platform, arch, installer: platform === 'win32' ? 'nsis' : 'deb', ...(variant === 'kirin990' ? { variant } : {}) };
}
export const installerName = (version, platform = 'win32', arch = 'x64', variant = 'standard') => platform === 'linux'
  ? `数据融合助手-麒麟${variant === 'kirin990' ? '海思990' : ''}版-${version}-${arch}.deb` : `数据融合助手-安装包-${version}-x64.exe`;
export const legacyInstallerName = version => `DataFusion-Setup-${version}-x64.exe`;
export function isInstallerName(name, version, platform = 'win32', arch = 'x64', variant = 'standard') {
  if (!releaseTarget(platform, arch, variant) || !RELEASE_VERSION_PATTERN.test(version)) return false;
  if (variant === 'kirin990') return name === installerName(version, platform, arch, variant);
  return (platform === 'linux' ? [installerName(version, platform, arch), `数据融合助手-麒麟测试版-${version}-${arch}.deb`]
    : [installerName(version), legacyInstallerName(version), `数据融合助手-兼容通用安装包-${version}-x64.exe`]).includes(name);
}
export function installerVersion(name) {
  const match = /^(?:数据融合助手-(?:安装包|兼容通用安装包)-|DataFusion-Setup-)([0-9.]+)-x64\.exe$/.exec(name);
  if (match && isInstallerName(name, match[1])) return match[1];
  const kirin = /^数据融合助手-麒麟海思990版-([0-9.]+)-arm64\.deb$/.exec(name);
  if (kirin && isInstallerName(name, kirin[1], 'linux', 'arm64', 'kirin990')) return kirin[1];
  const linux = /^数据融合助手-麒麟(?:测试)?版-([0-9.]+)-(x64|arm64)\.deb$/.exec(name);
  return linux && isInstallerName(name, linux[1], 'linux', linux[2]) ? linux[1] : null;
}
export function installerDisposition(name, version) {
  const linux = /-(x64|arm64)\.deb$/.exec(name);
  return `attachment; filename="${linux ? `DataFusion-Kylin-${version}-${linux[1]}.deb` : legacyInstallerName(version)}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
