import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessFileError, businessReleasesForTarget, businessTargetLabel, defaultBusinessTarget, uploadBusinessRelease, type BusinessRelease } from './business-releases';

class FakeXHR {
  static instances: FakeXHR[] = []; method = ''; url = ''; withCredentials = false; timeout = 0; status = 0; responseText = ''; headers: Record<string, string> = {};
  upload = { onprogress: undefined as ((event: ProgressEvent) => void) | undefined }; onload?: () => void; onerror?: () => void; onabort?: () => void; ontimeout?: () => void;
  send = vi.fn((_body: unknown) => {}); constructor() { FakeXHR.instances.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; } setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  abort() { this.onabort?.(); } respond(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.(); }
}
const file = { name: 'business-1.1.0.asar', size: 100 } as File;
const row: BusinessRelease = { id: 'fixture', version: '1.1.0', target: { ...defaultBusinessTarget }, fileName: file.name, bytes: file.size, sha256: 'a'.repeat(64),
  notes: '合成测试', enabled: false, status: 'draft', publishedAt: 0, createdAt: 1, metadata: { minShellVersion: '1.1.0', backend: { origin: 'https://new-backend.example.invalid', revision: 2 } }, url: '/private/draft', feedUrl: 'https://updates.example.invalid/latest.json' };
beforeEach(() => { FakeXHR.instances = []; vi.stubGlobal('XMLHttpRequest', FakeXHR); }); afterEach(() => vi.unstubAllGlobals());
describe('business update management', () => {
  it('separates runtime lanes and validates payload names, version and size before upload', () => {
    expect(businessFileError(file, '1.1.0', defaultBusinessTarget)).toBe('');
    expect(businessFileError(file, '1.1.1', defaultBusinessTarget)).toContain('business-1.1.1.asar');
    expect(businessFileError(file, '01.1.0', defaultBusinessTarget)).toContain('正确业务版本');
    expect(businessFileError({ ...file, size: 256 * 1024 * 1024 + 1 }, '1.1.0', defaultBusinessTarget)).toContain('256 MB');
    expect(businessFileError(file, '1.1.0', { ...defaultBusinessTarget, arch: 'arm64' })).toContain('环境无效');
    const win7 = { ...row, id: 'win7', target: { ...row.target, electronMajor: 22 as const } };
    expect(businessReleasesForTarget([row, win7], defaultBusinessTarget).map(item => item.id)).toEqual(['fixture']);
    expect(businessTargetLabel(win7.target)).toContain('Windows 7');
  });
  it('freezes the target, preserves Chinese notes and accepts only a server-verified private draft acknowledgment', async () => {
    const target = { ...defaultBusinessTarget }, progress = vi.fn();
    const pending = uploadBusinessRelease(file, { version: '1.1.0', target, notes: '后台地址迁移 + 测试' }, { onProgress: progress }); target.electronMajor = 22;
    const xhr = FakeXHR.instances[0], query = new URL(xhr.url, 'https://backend.example.invalid').searchParams;
    expect(query.get('electronMajor')).toBe('44'); expect(query.get('variant')).toBe('standard'); expect(xhr.withCredentials).toBe(true);
    expect(Buffer.from(xhr.headers['x-release-notes-base64'], 'base64').toString('utf8')).toBe('后台地址迁移 + 测试');
    expect(xhr.send).toHaveBeenCalledExactlyOnceWith(file); xhr.respond(201, row);
    await expect(pending).resolves.toEqual(row); expect(progress).toHaveBeenLastCalledWith(100);
  });
  it.each([{ target: { ...defaultBusinessTarget, electronMajor: 22 } }, { enabled: true }, { status: 'published' }, { bytes: 1 }, { sha256: 'bad' }, { metadata: null }])('rejects inconclusive or cross-runtime acknowledgment %j', async patch => {
    const pending = uploadBusinessRelease(file, { version: '1.1.0', target: defaultBusinessTarget }); FakeXHR.instances[0].respond(201, { ...row, ...patch });
    await expect(pending).rejects.toMatchObject({ status: 502 });
  });
  it('supports cancellation without publishing or retaining a misleading success', async () => {
    const control = new AbortController(), pending = uploadBusinessRelease(file, { version: '1.1.0', target: defaultBusinessTarget }, { signal: control.signal });
    control.abort(); await expect(pending).rejects.toMatchObject({ code: 'UPLOAD_CANCELLED' }); FakeXHR.instances[0].respond(201, row);
    expect(FakeXHR.instances).toHaveLength(1);
  });
});
