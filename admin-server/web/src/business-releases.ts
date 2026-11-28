import { ApiError, request } from './api';
import { RELEASE_VERSION_PATTERN } from './releases';

export interface BusinessTarget { platform: 'win32' | 'linux'; arch: 'x64' | 'arm64'; variant: 'standard' | 'kirin990'; electronMajor: 22 | 44 }
export interface BusinessRelease {
  id: string; version: string; target: BusinessTarget; fileName: string; bytes: number; sha256: string; notes: string;
  enabled: boolean; status: 'uploading' | 'draft' | 'published' | 'disabled'; publishedAt: number; createdAt: number;
  metadata: { minShellVersion: string; backend: { origin: string; revision: number } } | null;
  url: string; feedUrl: string | null;
}
export interface BusinessReleaseList { rows: BusinessRelease[]; total?: number; configured: boolean; feedBase: string | null; storageMode?: 'oss' | 'local' }
export const BUSINESS_MAX_BYTES = 256 * 1024 * 1024;
export const defaultBusinessTarget: BusinessTarget = { platform: 'win32', arch: 'x64', variant: 'standard', electronMajor: 44 };
export function businessTargetLabel(target: BusinessTarget): string {
  return target.platform === 'win32' ? target.electronMajor === 22 ? 'Windows 7 · x64 · Electron 22' : 'Windows 10/11 · x64 · Electron 44'
    : `麒麟 V10 · ${target.variant === 'kirin990' ? '海思 990 · ARM64' : target.arch === 'arm64' ? 'ARM64' : 'x86_64'} · Electron 44`;
}
export function businessFileError(file: Pick<File, 'name' | 'size'> | null, version: string, target: BusinessTarget): string {
  if (!['win32', 'linux'].includes(target.platform) || !['x64', 'arm64'].includes(target.arch) || !['standard', 'kirin990'].includes(target.variant) || ![22, 44].includes(target.electronMajor)
    || target.platform === 'win32' && target.arch !== 'x64' || target.electronMajor === 22 && target.platform !== 'win32'
    || target.variant === 'kirin990' && (target.platform !== 'linux' || target.arch !== 'arm64')) return '业务包运行环境无效';
  if (!RELEASE_VERSION_PATTERN.test(version)) return '请输入正确业务版本，例如 1.1.0';
  if (!file) return '请选择业务 ASAR 包';
  if (file.name !== `business-${version}.asar`) return `请选择 business-${version}.asar，文件名必须与业务版本一致`;
  if (!Number.isSafeInteger(file.size) || file.size < 16 || file.size > BUSINESS_MAX_BYTES) return '业务包大小须在 16 字节至 256 MB 之间';
  return '';
}
export function businessReleasesForTarget(rows: BusinessRelease[], target: BusinessTarget) {
  return rows.filter(row => Object.keys(target).every(key => row.target[key as keyof BusinessTarget] === target[key as keyof BusinessTarget]));
}
export const businessApi = {
  list: (params?: Record<string, string>, signal?: AbortSignal) => request<BusinessReleaseList>(`/api/admin/business-releases${params ? `?${new URLSearchParams(params)}` : ''}`, { signal }),
  publish: (id: string, enabled: boolean, confirmPassword: string) => request<BusinessRelease>(`/api/admin/business-releases/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify({ enabled, confirmPassword }), signal: AbortSignal.timeout(180_000) }),
};
export function uploadBusinessRelease(file: File, values: { version: string; target: BusinessTarget; notes?: string }, options: { signal?: AbortSignal; onProgress?: (percent: number) => void } = {}): Promise<BusinessRelease> {
  values = { ...values, target: { ...values.target } };
  const invalid = businessFileError(file, values.version, values.target);
  if (invalid) return Promise.reject(new ApiError(invalid, 400));
  if ((values.notes?.length ?? 0) > 1000) return Promise.reject(new ApiError('更新说明不能超过 1000 字', 400));
  if (options.signal?.aborted) return Promise.reject(new ApiError('上传已取消', 0, 'UPLOAD_CANCELLED'));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(), target = values.target; let settled = false;
    const abort = () => xhr.abort();
    const finish = (error?: ApiError, row?: BusinessRelease) => { if (settled) return; settled = true; options.signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(row!); };
    const query = new URLSearchParams({ version: values.version, filename: file.name, platform: target.platform, arch: target.arch, variant: target.variant, electronMajor: String(target.electronMajor) });
    xhr.open('POST', '/api/admin/business-releases/upload?' + query); xhr.withCredentials = true; xhr.timeout = 600_000;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-release-notes-base64', btoa(Array.from(new TextEncoder().encode(values.notes?.trim() ?? ''), byte => String.fromCharCode(byte)).join('')));
    xhr.upload.onprogress = event => { if (event.lengthComputable && event.total > 0 && !settled) options.onProgress?.(Math.min(99, Math.round(event.loaded / event.total * 100))); };
    xhr.onload = () => {
      let row: BusinessRelease & { error?: string }; try { row = JSON.parse(xhr.responseText); } catch { finish(new ApiError('服务器未返回有效上传结果，请刷新业务版本列表核对草稿', 502)); return; }
      if (xhr.status < 200 || xhr.status >= 300) { finish(new ApiError(row?.error || '业务包上传失败', xhr.status)); return; }
      if (!row || typeof row.id !== 'string' || !row.id || row.version !== values.version || row.fileName !== file.name || row.bytes !== file.size || !/^[a-f0-9]{64}$/.test(row.sha256)
        || row.status !== 'draft' || row.enabled !== false || Object.keys(target).some(key => row.target?.[key as keyof BusinessTarget] !== target[key as keyof BusinessTarget])
        || !row.metadata || !RELEASE_VERSION_PATTERN.test(row.metadata.minShellVersion) || !Number.isSafeInteger(row.metadata.backend?.revision) || row.metadata.backend.revision < 1) {
        finish(new ApiError('服务器返回的业务版本、运行环境或摘要不一致，未发布', 502)); return;
      }
      options.onProgress?.(100); finish(undefined, row);
    };
    xhr.onerror = () => finish(new ApiError('业务包上传连接失败，请刷新列表核对后重试', 0));
    xhr.ontimeout = () => finish(new ApiError('业务包上传等待超时，请刷新列表核对草稿', 0));
    xhr.onabort = () => finish(new ApiError('上传已取消', 0, 'UPLOAD_CANCELLED'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { finish(new ApiError('上传已取消', 0, 'UPLOAD_CANCELLED')); return; }
    try { xhr.send(file); } catch { finish(new ApiError('无法发送业务包，请重试', 0)); }
  });
}
