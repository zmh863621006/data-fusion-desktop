export const RELEASE_VERSION_PATTERN = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;

export function releaseTarget(platform = 'win32', arch = 'x64', variant = 'standard') {
  if (!['win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch) || platform === 'win32' && arch !== 'x64'
    || !['standard', 'kirin990'].includes(variant) || variant === 'kirin990' && (platform !== 'linux' || arch !== 'arm64')) return null;
  return { platform, arch, installer: platform === 'win32' ? 'nsis' : 'deb', ...(variant === 'kirin990' ? { variant } : {}) };
}
export function installerProfile(value = 'shenzhen') {
  if (!['shenzhen', 'huizhou'].includes(value)) throw new Error('安装器部署配置无效');
  return value;
}
export const installerName = (version, platform = 'win32', arch = 'x64', variant = 'standard', profile = 'shenzhen') => {
  const name = installerProfile(profile) === 'huizhou' ? '惠州数据融合助手' : '数据融合助手';
  return platform === 'linux' ? `${name}-麒麟${variant === 'kirin990' ? '海思990' : ''}版-${version}-${arch}.deb` : `${name}-安装包-${version}-x64.exe`;
};
export const legacyInstallerName = version => `DataFusion-Setup-${version}-x64.exe`;
export function isInstallerName(name, version, platform = 'win32', arch = 'x64', variant = 'standard', profile = 'shenzhen') {
  if (!['shenzhen', 'huizhou'].includes(profile) || !releaseTarget(platform, arch, variant) || !RELEASE_VERSION_PATTERN.test(version)) return false;
  if (profile === 'huizhou') return [installerName(version, platform, arch, variant, profile),
    ...(platform === 'win32' ? [`惠州数据融合助手-兼容通用安装包-${version}-x64.exe`] : [])].includes(name);
  if (variant === 'kirin990') return name === installerName(version, platform, arch, variant);
  return (platform === 'linux' ? [installerName(version, platform, arch), `数据融合助手-麒麟测试版-${version}-${arch}.deb`]
    : [installerName(version), legacyInstallerName(version), `数据融合助手-兼容通用安装包-${version}-x64.exe`]).includes(name);
}
export function installerVersion(name, profile = 'shenzhen') {
  if (profile === 'huizhou') {
    const match = /^惠州数据融合助手-(?:安装包|兼容通用安装包)-([0-9.]+)-x64\.exe$/.exec(name);
    if (match && isInstallerName(name, match[1], 'win32', 'x64', 'standard', profile)) return match[1];
    const linux = /^惠州数据融合助手-麒麟(海思990)?版-([0-9.]+)-(x64|arm64)\.deb$/.exec(name);
    return linux && isInstallerName(name, linux[2], 'linux', linux[3], linux[1] ? 'kirin990' : 'standard', profile) ? linux[2] : null;
  }
  if (profile !== 'shenzhen') return null;
  const match = /^(?:数据融合助手-(?:安装包|兼容通用安装包)-|DataFusion-Setup-)([0-9.]+)-x64\.exe$/.exec(name);
  if (match && isInstallerName(name, match[1])) return match[1];
  const kirin = /^数据融合助手-麒麟海思990版-([0-9.]+)-arm64\.deb$/.exec(name);
  if (kirin && isInstallerName(name, kirin[1], 'linux', 'arm64', 'kirin990')) return kirin[1];
  const linux = /^数据融合助手-麒麟(?:测试)?版-([0-9.]+)-(x64|arm64)\.deb$/.exec(name);
  return linux && isInstallerName(name, linux[1], 'linux', linux[2]) ? linux[1] : null;
}
export function installerDisposition(name, version, profile = 'shenzhen') {
  if (installerProfile(profile) === 'huizhou') {
    const linux = /-(x64|arm64)\.deb$/.exec(name);
    return `attachment; filename="${linux ? `HuizhouDataFusion-Kylin-${version}-${linux[1]}.deb` : `HuizhouDataFusion-Setup-${version}-x64.exe`}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  const linux = /-(x64|arm64)\.deb$/.exec(name);
  return `attachment; filename="${linux ? `DataFusion-Kylin-${version}-${linux[1]}.deb` : legacyInstallerName(version)}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
