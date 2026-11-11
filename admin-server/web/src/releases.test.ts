import { describe, expect, it } from 'vitest';
import { RELEASE_MAX_BYTES, RELEASE_STATUS_LABELS, releaseFileError, releaseFileSize, releaseStatus, releaseTargetLabel, releasesForTarget } from './releases';
import type { UpdateRecord } from './types';

const file = { name: 'DataFusion-Setup-1.0.3-x64.exe', size: 117414503 };
const row: UpdateRecord = { id: 'version-1', target_type: 'app', version: '1.0.3', url: 'https://updates.test/example.exe', sha256: 'a'.repeat(64), enabled: 0, published_at: 1 };
describe('managed release presentation and local preflight', () => {
  it('requires a complete matching installer filename, a stable version and a nonempty bounded file', () => {
    expect(releaseFileError(file, '1.0.3')).toBe('');
    expect(releaseFileError({ ...file, name: '数据融合助手-安装包-1.0.3-x64.exe' }, '1.0.3')).toBe('');
    expect(releaseFileError({ ...file, name: '数据融合助手-安装包-1.0.4-x64.exe' }, '1.0.3')).toContain('名称需与版本号一致');
    expect(releaseFileError(null, '1.0.3')).toContain('请选择');
    expect(releaseFileError({ ...file, name: 'example.exe' }, '1.0.3')).toContain('名称需与版本号一致');
    expect(releaseFileError(file, '1.0.4')).toContain('1.0.4');
    expect(releaseFileError(file, '1.0.3/../x')).toContain('正确版本号');
    expect(releaseFileError(file, '1.0.3-beta')).toContain('正确版本号');
    expect(releaseFileError(file, '01.0.3')).toContain('正确版本号');
    expect(releaseFileError(file, '1000000.0.3')).toContain('正确版本号');
    expect(releaseFileError({ ...file, size: 0 }, '1.0.3')).toContain('为空');
    expect(releaseFileError({ ...file, size: RELEASE_MAX_BYTES + 1 }, '1.0.3')).toContain('500 MB');
  });
  it('distinguishes uploading/draft/published/disabled and preserves older release records', () => {
    expect(releaseStatus({ ...row, status: 'uploading' })).toBe('uploading');
    expect(releaseStatus({ ...row, status: 'draft' })).toBe('draft');
    expect(releaseStatus({ ...row, enabled: 1 })).toBe('published');
    expect(releaseStatus(row)).toBe('disabled');
    expect(RELEASE_STATUS_LABELS.draft).toBe('待发布');
  });
  it('shows a useful file size without inventing size for historical external links', () => {
    expect(releaseFileSize(file.size)).toBe('112.0 MB');
    expect(releaseFileSize(1024)).toBe('1.0 KB');
    expect(releaseFileSize(4)).toBe('4 B');
    expect(releaseFileSize(undefined)).toBe('—');
    expect(releaseFileSize(-1)).toBe('—');
  });
  it('keeps the same version independent across Windows and both Kylin architectures, including historical Windows rows', () => {
    const rows: UpdateRecord[] = [row, { ...row, id: 'linux-x64', platform: 'linux', arch: 'x64', installer: 'deb' },
      { ...row, id: 'linux-arm64', platform: 'linux', arch: 'arm64', installer: 'deb' },
      { ...row, id: 'plugin', target_type: 'plugin', platform: 'win32', arch: 'x64' }];
    expect(releasesForTarget(rows, { platform: 'win32', arch: 'x64' }).map(value => value.id)).toEqual(['version-1']);
    expect(releasesForTarget(rows, { platform: 'linux', arch: 'x64' }).map(value => value.id)).toEqual(['linux-x64']);
    expect(releasesForTarget(rows, { platform: 'linux', arch: 'arm64' }).map(value => value.id)).toEqual(['linux-arm64']);
    expect(releaseTargetLabel(row)).toContain('Windows');
    expect(releaseTargetLabel(rows[1])).toContain('x86_64');
    expect(releaseTargetLabel(rows[2])).toContain('ARM64');
  });
  it('accepts the universal Windows package and only the matching Kylin version and architecture', () => {
    expect(releaseFileError({ ...file, name: '数据融合助手-兼容通用安装包-1.0.3-x64.exe' }, '1.0.3')).toBe('');
    const target = { platform: 'linux', arch: 'arm64' } as const;
    const arm = { ...file, name: '数据融合助手-麒麟版-1.0.3-arm64.deb' };
    expect(releaseFileError(arm, '1.0.3', target)).toBe('');
    expect(releaseFileError({ ...arm, name: '数据融合助手-麒麟测试版-1.0.3-arm64.deb' }, '1.0.3', target)).toBe('');
    expect(releaseFileError(arm, '1.0.3')).toContain('匹配当前平台与架构');
    expect(releaseFileError(file, '1.0.3', target)).toContain('arm64.deb');
    expect(releaseFileError({ ...arm, name: '数据融合助手-麒麟版-1.0.3-x64.deb' }, '1.0.3', target)).toContain('匹配当前平台与架构');
    expect(releaseFileError(arm, '1.0.4', target)).toContain('1.0.4');
    expect(releaseFileError(file, '1.0.3', { platform: 'win32', arch: 'arm64' })).toContain('无效');
  });
});
