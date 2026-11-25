import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminApi } from './api';

class FakeXHR {
  static instances: FakeXHR[] = [];
  method = ''; url = ''; withCredentials = false; timeout = 0; status = 0; responseText = '';
  headers: Record<string, string> = {};
  upload = { onprogress: undefined as ((event: ProgressEvent) => void) | undefined };
  onload?: () => void; onerror?: () => void; onabort?: () => void; ontimeout?: () => void;
  send = vi.fn((_body: unknown) => {});
  constructor() { FakeXHR.instances.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  abort() { this.onabort?.(); }
  respond(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.(); }
}
const file = { name: '数据融合助手-安装包-1.0.3-x64.exe', size: 4 } as File;
const result = { id: 'managed-release', version: '1.0.3', fileName: file.name, bytes: file.size,
  sha256: 'a'.repeat(64), url: 'https://updates.test/api/releases/managed-release/' + file.name, status: 'draft', enabled: false, managed: true };
const dispatchEvent = vi.fn();
beforeEach(() => { FakeXHR.instances = []; dispatchEvent.mockReset(); vi.stubGlobal('XMLHttpRequest', FakeXHR); vi.stubGlobal('window', { dispatchEvent }); });
afterEach(() => vi.unstubAllGlobals());

describe('binary managed-release upload API', () => {
  it('uploads the isolated Huizhou product with existing progress, target and draft confirmation semantics', async () => {
    const localFile = { name: '惠州数据融合助手-兼容通用安装包-1.2.0-x64.exe', size: 200 } as File;
    const progress = vi.fn(), values = { version: '1.2.0', platform: 'win32' as const, arch: 'x64' as const, deploymentProfile: 'huizhou' as 'huizhou' | 'standard' };
    const uploading = adminApi.uploadRelease(localFile, values, { onProgress: progress });
    values.deploymentProfile = 'standard';
    const xhr = FakeXHR.instances[0], query = new URL(xhr.url, 'https://fixture.example.invalid').searchParams;
    expect(query.get('filename')).toBe(localFile.name);
    expect(query.get('platform')).toBe('win32'); expect(query.get('arch')).toBe('x64');
    expect(query.has('deploymentProfile')).toBe(false);
    expect(xhr.withCredentials).toBe(true);
    xhr.upload.onprogress?.({ loaded: 100, total: 200, lengthComputable: true } as ProgressEvent);
    expect(progress).toHaveBeenLastCalledWith(50);
    const acknowledgment = { ...result, version: '1.2.0', fileName: localFile.name, bytes: localFile.size, platform: 'win32', arch: 'x64', installer: 'nsis' };
    xhr.respond(201, acknowledgment);
    await expect(uploading).resolves.toEqual(acknowledgment);
    expect(progress).toHaveBeenLastCalledWith(100);
    expect(FakeXHR.instances).toHaveLength(1);
  });
  it('rejects product or architecture mismatches before sending any isolated release bytes', async () => {
    await expect(adminApi.uploadRelease(file, { version: '1.0.3', deploymentProfile: 'huizhou' })).rejects.toThrow('惠州数据融合助手');
    const localFile = { name: '惠州数据融合助手-安装包-1.0.3-x64.exe', size: 200 } as File;
    await expect(adminApi.uploadRelease(localFile, { version: '1.0.3' })).rejects.toThrow('匹配当前平台与架构');
    const linuxFile = { name: '惠州数据融合助手-麒麟版-1.0.3-arm64.deb', size: 200 } as File;
    await expect(adminApi.uploadRelease(linuxFile, { version: '1.0.3', platform: 'linux', arch: 'x64', deploymentProfile: 'huizhou' })).rejects.toThrow('匹配当前平台与架构');
    expect(FakeXHR.instances).toHaveLength(0);
  });
  it('uses the fixed same-origin route, existing session cookies, binary body and encoded metadata, without auto-publishing', async () => {
    const progress = vi.fn(), notes = '修复 + 改进 & 测试';
    const uploading = adminApi.uploadRelease(file, { version: '1.0.3', notes }, { onProgress: progress });
    const xhr = FakeXHR.instances[0], query = new URL(xhr.url, 'http://127.0.0.1').searchParams;
    expect(xhr.url.startsWith('/api/admin/updates/upload?')).toBe(true);
    expect(xhr.method).toBe('POST'); expect(xhr.withCredentials).toBe(true); expect(xhr.timeout).toBe(600000);
    expect(xhr.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.from(xhr.headers['x-release-notes-base64'], 'base64').toString('utf8')).toBe(notes);
    expect(query.get('version')).toBe('1.0.3'); expect(query.get('filename')).toBe(file.name); expect(query.has('notes')).toBe(false);
    expect(query.get('platform')).toBe('win32'); expect(query.get('arch')).toBe('x64');
    expect(xhr.send).toHaveBeenCalledExactlyOnceWith(file); expect(xhr.url).not.toMatch(/sha256|password|enabled/);
    xhr.upload.onprogress?.({ loaded: 2, total: 4, lengthComputable: true } as ProgressEvent);
    expect(progress).toHaveBeenLastCalledWith(50);
    xhr.upload.onprogress?.({ loaded: 4, total: 4, lengthComputable: true } as ProgressEvent);
    expect(progress).toHaveBeenLastCalledWith(99);
    xhr.respond(201, result);
    await expect(uploading).resolves.toEqual(result); expect(progress).toHaveBeenLastCalledWith(100);
    expect(FakeXHR.instances).toHaveLength(1); expect(dispatchEvent).not.toHaveBeenCalled();
  });
  it.each([{ sha256: 'bad' }, { bytes: 1 }, { version: '1.0.4' }, { fileName: 'other.exe' }, { enabled: true }, { status: 'published' }])('refuses an inconclusive server acknowledgment: %j', async bad => {
    const uploading = adminApi.uploadRelease(file, { version: '1.0.3' });
    FakeXHR.instances[0].respond(201, { ...result, ...bad });
    await expect(uploading).rejects.toMatchObject({ status: 502 });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
  it('retains unauthorized/session and duplicate-version errors for the existing global error handler', async () => {
    const uploading = adminApi.uploadRelease(file, { version: '1.0.3' });
    FakeXHR.instances[0].respond(401, { error: '请重新登录', code: 'SESSION_EXPIRED' });
    await expect(uploading).rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const duplicate = adminApi.uploadRelease(file, { version: '1.0.3' }); FakeXHR.instances[1].respond(409, { error: '该版本已经存在' });
    await expect(duplicate).rejects.toThrow('已经存在');
  });
  it('can cancel before sending or while uploading without dispatching a misleading network error', async () => {
    const first = new AbortController(); first.abort();
    await expect(adminApi.uploadRelease(file, { version: '1.0.3' }, { signal: first.signal })).rejects.toMatchObject({ code: 'UPLOAD_CANCELLED' });
    expect(FakeXHR.instances).toHaveLength(0);
    const second = new AbortController();
    const uploading = adminApi.uploadRelease(file, { version: '1.0.3' }, { signal: second.signal });
    second.abort(); await expect(uploading).rejects.toMatchObject({ code: 'UPLOAD_CANCELLED' });
    FakeXHR.instances[0].respond(201, result);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
  it.each(['network', 'timeout', 'invalid-json'])('exposes a retryable failure for %s without pretending it published', async kind => {
    const uploading = adminApi.uploadRelease(file, { version: '1.0.3' }); const xhr = FakeXHR.instances[0];
    if (kind === 'network') xhr.onerror?.(); else if (kind === 'timeout') xhr.ontimeout?.(); else { xhr.responseText = 'bad response'; xhr.status = 201; xhr.onload?.(); }
    await expect(uploading).rejects.toBeInstanceOf(Error); expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid local input without starting a request', async () => {
    await expect(adminApi.uploadRelease({ ...file, size: 0 } as File, { version: '1.0.3' })).rejects.toThrow('为空');
    await expect(adminApi.uploadRelease(file, { version: '1.0.3', notes: 'a'.repeat(1001) })).rejects.toThrow('1000');
    expect(FakeXHR.instances).toHaveLength(0);
  });
  it('keeps 1000 Chinese characters out of the URL while preserving the UTF-8 note', async () => {
    const notes = '更'.repeat(1000), uploading = adminApi.uploadRelease(file, { version: '1.0.3', notes });
    const xhr = FakeXHR.instances[0];
    expect(xhr.url.length).toBeLessThan(200); expect(xhr.headers['x-release-notes-base64'].length).toBe(4000);
    expect(Buffer.from(xhr.headers['x-release-notes-base64'], 'base64').toString('utf8')).toBe(notes);
    xhr.respond(201, result); await uploading;
  });
  it('sends a frozen Kylin target and accepts the matching server-owned package metadata', async () => {
    const linuxFile = { name: '数据融合助手-麒麟版-1.0.3-arm64.deb', size: 200 } as File;
    const values = { version: '1.0.3', platform: 'linux' as const, arch: 'arm64' as 'x64' | 'arm64' };
    const uploading = adminApi.uploadRelease(linuxFile, values);
    values.arch = 'x64';
    const xhr = FakeXHR.instances[0];
    const query = new URL(xhr.url, 'https://updates.test').searchParams;
    expect(query.get('platform')).toBe('linux'); expect(query.get('arch')).toBe('arm64');
    const linuxResult = { ...result, platform: 'linux', arch: 'arm64', installer: 'deb', fileName: linuxFile.name, bytes: linuxFile.size };
    xhr.respond(201, linuxResult);
    await expect(uploading).resolves.toEqual(linuxResult);
    expect(xhr.send).toHaveBeenCalledExactlyOnceWith(linuxFile);
  });
  it.each([
    { platform: 'win32', arch: 'x64', installer: 'nsis' },
    { platform: 'linux', arch: 'x64', installer: 'deb' },
    { platform: 'linux', arch: 'arm64', installer: 'nsis' },
    {},
  ])('rejects a mismatched or missing explicit target acknowledgment: %j', async target => {
    const linuxFile = { name: '数据融合助手-麒麟版-1.0.3-arm64.deb', size: 200 } as File;
    const uploading = adminApi.uploadRelease(linuxFile, { version: '1.0.3', platform: 'linux', arch: 'arm64' });
    FakeXHR.instances[0].respond(201, { ...result, fileName: linuxFile.name, bytes: linuxFile.size, ...target });
    await expect(uploading).rejects.toMatchObject({ status: 502 });
  });
  it('rejects a cross-platform or cross-architecture selection before creating an upload request', async () => {
    await expect(adminApi.uploadRelease(file, { version: '1.0.3', platform: 'linux', arch: 'x64' })).rejects.toThrow('匹配当前平台与架构');
    const linuxFile = { name: '数据融合助手-麒麟版-1.0.3-x64.deb', size: 200 } as File;
    await expect(adminApi.uploadRelease(linuxFile, { version: '1.0.3', platform: 'linux', arch: 'arm64' })).rejects.toThrow('匹配当前平台与架构');
    expect(FakeXHR.instances).toHaveLength(0);
  });
  it.each([undefined, 'standard', 'kirin990'])('verifies the Kirin990 acknowledgment variant: %s', async variant => {
    const dedicated = { name: '数据融合助手-麒麟海思990版-1.0.3-arm64.deb', size: 200 } as File;
    const uploading = adminApi.uploadRelease(dedicated, { version: '1.0.3', platform: 'linux', arch: 'arm64', variant: 'kirin990' });
    const xhr = FakeXHR.instances[0];
    expect(new URL(xhr.url, 'https://updates.test').searchParams.get('variant')).toBe('kirin990');
    const acknowledgment = { ...result, fileName: dedicated.name, bytes: dedicated.size, platform: 'linux', arch: 'arm64', installer: 'deb', variant };
    xhr.respond(201, acknowledgment);
    if (variant === 'kirin990') await expect(uploading).resolves.toEqual(acknowledgment);
    else await expect(uploading).rejects.toMatchObject({ status: 502 });
  });
});
