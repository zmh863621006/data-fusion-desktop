import type { UpdateRecord } from './types';

export const RELEASE_MAX_BYTES = 500 * 1024 * 1024;
export const RELEASE_VERSION_PATTERN = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
export type ReleaseStatus = 'uploading' | 'draft' | 'published' | 'disabled';
export type ReleasePlatform = 'win32' | 'linux';
export type ReleaseArch = 'x64' | 'arm64';
export type ReleaseVariant = 'standard' | 'kirin990';
export interface ReleaseTarget { platform: ReleasePlatform; arch: ReleaseArch; variant?: ReleaseVariant }
export const WINDOWS_RELEASE_TARGET: ReleaseTarget = { platform: 'win32', arch: 'x64' };
export interface UploadReleaseValues { version: string; notes?: string; platform?: ReleasePlatform; arch?: ReleaseArch; variant?: ReleaseVariant }
export interface UploadedRelease {
  id: string; version: string; sha256: string; bytes: number; fileName: string; url: string;
  status: 'draft'; enabled: false; managed?: boolean; notes?: string;
  platform?: ReleasePlatform; arch?: ReleaseArch; variant?: ReleaseVariant; installer?: 'nsis' | 'deb';
}

/** Existing records predate target fields and always belong to Windows x64. */
export function releaseTarget(value: Partial<ReleaseTarget>): ReleaseTarget {
  return { platform: value.platform ?? 'win32', arch: value.arch ?? 'x64', variant: value.variant ?? 'standard' };
}
export function releaseTargetLabel(value: Partial<ReleaseTarget>): string {
  const target = releaseTarget(value);
  return target.platform === 'win32' ? 'Windows · 64 位通用版'
    : target.variant === 'kirin990' ? '信创 · 麒麟 V10 · 海思 990 · ARM64'
      : `信创 · 麒麟 V10 · ${target.arch === 'arm64' ? 'ARM64' : 'x86_64'}`;
}
export function releasesForTarget(rows: UpdateRecord[], target: ReleaseTarget): UpdateRecord[] {
  return rows.filter(row => {
    const actual = releaseTarget(row);
    return row.target_type === 'app' && actual.platform === target.platform && actual.arch === target.arch
      && actual.variant === (target.variant ?? 'standard');
  });
}
export function releaseInstallerName(version: string, value: Partial<ReleaseTarget> = WINDOWS_RELEASE_TARGET): string {
  const target = releaseTarget(value);
  return target.platform === 'linux'
    ? `数据融合助手-麒麟${target.variant === 'kirin990' ? '海思990' : ''}版-${version}-${target.arch}.deb`
    : `数据融合助手-安装包-${version}-x64.exe`;
}

export function releaseStatus(row: UpdateRecord): ReleaseStatus {
  if (row.status === 'uploading') return 'uploading';
  if (row.enabled) return 'published';
  return row.status === 'draft' ? 'draft' : 'disabled';
}
export const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  uploading: '上传中', draft: '待发布', published: '已发布', disabled: '已下线',
};
export function releaseFileError(file: Pick<File, 'name' | 'size'> | null, version: string, value: Partial<ReleaseTarget> = WINDOWS_RELEASE_TARGET): string {
  const target = releaseTarget(value);
  if (!['win32', 'linux'].includes(target.platform) || !['x64', 'arm64'].includes(target.arch)
    || target.platform === 'win32' && target.arch !== 'x64'
    || !['standard', 'kirin990'].includes(target.variant ?? '')
    || target.variant === 'kirin990' && (target.platform !== 'linux' || target.arch !== 'arm64')) return '发布平台或芯片架构无效';
  if (!RELEASE_VERSION_PATTERN.test(version) || version.length > 32) return '请输入正确版本号，例如 1.0.3';
  if (!file) return `请选择${target.platform === 'linux' ? '对应架构的麒麟 DEB' : ' Windows 64 位'}安装包`;
  const expected = releaseInstallerName(version, target);
  const names = target.platform === 'linux'
    ? target.variant === 'kirin990' ? [expected] : [expected, `数据融合助手-麒麟测试版-${version}-${target.arch}.deb`]
    : [expected, `DataFusion-Setup-${version}-x64.exe`, `数据融合助手-兼容通用安装包-${version}-x64.exe`];
  if (!names.includes(file.name)) return `请选择 ${expected}，安装包名称需与版本号一致，并匹配当前平台与架构`;
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return '安装包为空，请重新选择';
  if (file.size > RELEASE_MAX_BYTES) return '安装包不能超过 500 MB';
  return '';
}
export function releaseFileSize(bytes?: number | null): string {
  if (!Number.isSafeInteger(bytes) || !bytes || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
