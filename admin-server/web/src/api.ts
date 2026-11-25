import type { BootstrapData, AdminUser, AuditRecord } from './types';
import type { LicenseScopeSnapshot, LicenseScopeValues } from './license-scope';
import { releaseFileError, releaseTarget, type UploadedRelease, type UploadReleaseValues } from './releases';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string, public readonly retryAfterSeconds = 0) { super(message); }
}
const localError = (path: string) => ['/api/admin/login','/api/admin/captcha','/api/admin/bootstrap'].includes(path);

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(path, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json', ...options.headers },
  }); } catch {
    if (options.signal?.aborted && options.signal.reason?.name !== 'TimeoutError') throw new ApiError('请求已取消', 0, 'REQUEST_CANCELLED');
    const error = new ApiError('网络请求失败或超时，请稍后重试', 0);
    if (!localError(path)) window.dispatchEvent(new CustomEvent('admin-api-error', { detail: error }));
    throw error;
  }
  const value = await response.json().catch(() => ({})) as { error?: string; code?: string; retryAfterSeconds?: number } & T;
  if (!response.ok) {
    const error = new ApiError(value.error || `请求失败 ${response.status}`, response.status, value.code, value.retryAfterSeconds ?? (Number(response.headers.get('retry-after')) || 0));
    if (!localError(path)) window.dispatchEvent(new CustomEvent('admin-api-error', { detail: error }));
    throw error;
  }
  return value;
}

/** Same-origin, cookie-authenticated binary upload. It never publishes or sends an administrator password. */
export function uploadRelease(file: File, values: UploadReleaseValues, options: { signal?: AbortSignal; onProgress?: (percent: number) => void } = {}): Promise<UploadedRelease> {
  // Snapshot the target before the asynchronous request. A later page switch
  // cannot change which release this upload is acknowledged as.
  values = { ...values };
  const target = releaseTarget(values);
  const validation = releaseFileError(file, values.version, target, values.deploymentProfile);
  if (validation) return Promise.reject(new ApiError(validation, 400));
  if ((values.notes?.length ?? 0) > 1000) return Promise.reject(new ApiError('更新说明不能超过 1000 字', 400));
  if (options.signal?.aborted) return Promise.reject(new ApiError('上传已取消', 0, 'UPLOAD_CANCELLED'));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const abort = () => xhr.abort();
    const finish = (error?: ApiError, result?: UploadedRelease) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      if (error) {
        if (error.code !== 'UPLOAD_CANCELLED') window.dispatchEvent(new CustomEvent('admin-api-error', { detail: error }));
        reject(error);
      } else resolve(result!);
    };
    const query = new URLSearchParams({ version: values.version, filename: file.name, platform: target.platform, arch: target.arch });
    if (target.variant === 'kirin990') query.set('variant', target.variant);
    xhr.open('POST', `/api/admin/updates/upload?${query}`);
    xhr.withCredentials = true;
    xhr.timeout = 10 * 60_000;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    // Keep a 1000-character Chinese note out of the request line (percent encoding could exceed 8 KiB).
    const encodedNotes = new TextEncoder().encode(values.notes?.trim() ?? '');
    xhr.setRequestHeader('x-release-notes-base64', btoa(Array.from(encodedNotes, byte => String.fromCharCode(byte)).join('')));
    xhr.upload.onprogress = event => { if (!settled && event.lengthComputable && event.total > 0) options.onProgress?.(Math.min(99, Math.round(event.loaded / event.total * 100))); };
    xhr.onload = () => {
      let body: Record<string, unknown>;
      try { body = JSON.parse(xhr.responseText) as Record<string, unknown>; }
      catch { finish(new ApiError('服务器未返回有效上传结果，请刷新版本列表确认草稿', 502)); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { finish(new ApiError('上传结果格式无效，请刷新版本列表确认草稿', 502)); return; }
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(new ApiError(typeof body.error === 'string' ? body.error : `上传失败 ${xhr.status}`, xhr.status, typeof body.code === 'string' ? body.code : undefined)); return;
      }
      if (typeof body.id !== 'string' || !body.id || body.version !== values.version || body.fileName !== file.name
        || typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha256) || body.bytes !== file.size
        || typeof body.url !== 'string' || body.status !== 'draft' || ![false, 0].includes(body.enabled as boolean | number)) {
        finish(new ApiError('服务器返回的版本、摘要或文件大小不一致，未执行发布，请刷新列表核对', 502)); return;
      }
      const hasTarget = values.platform !== undefined || values.arch !== undefined || body.platform !== undefined || body.arch !== undefined || body.installer !== undefined;
      if (hasTarget && (body.platform !== target.platform || body.arch !== target.arch || body.installer !== (target.platform === 'linux' ? 'deb' : 'nsis')
        || (body.variant ?? 'standard') !== target.variant)) {
        finish(new ApiError('服务器返回的发布平台、架构或安装格式不一致，未执行发布，请刷新列表核对', 502)); return;
      }
      options.onProgress?.(100);
      finish(undefined, { ...body, enabled: false } as unknown as UploadedRelease);
    };
    xhr.onerror = () => finish(new ApiError('安装包上传失败，请检查网络后重试', 0));
    xhr.ontimeout = () => finish(new ApiError('安装包上传超时，请刷新列表确认后重试', 0));
    xhr.onabort = () => finish(new ApiError('上传已取消，未发布版本', 0, 'UPLOAD_CANCELLED'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { finish(new ApiError('上传已取消', 0, 'UPLOAD_CANCELLED')); return; }
    try { xhr.send(file); } catch { finish(new ApiError('无法上传安装包，请稍后重试', 0)); }
  });
}

export const adminApi = {
  captcha: () => request<{ id: string; image: string; expiresAt: number }>('/api/admin/captcha'),
  bootstrap: () => request<BootstrapData>('/api/admin/bootstrap'),
  users: () => request<AdminUser[]>('/api/admin/users'),
  createUser: (body: Record<string, unknown>) => request('/api/admin/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id: string, body: Record<string, unknown>) => request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  password: (body: { oldPassword: string; newPassword: string }) => request('/api/admin/password', { method: 'POST', body: JSON.stringify(body) }),
  audits: (page: number, username = '', action = '') => request<{ rows: AuditRecord[]; total: number }>(`/api/admin/audits?${new URLSearchParams({ page: String(page), username, action })}`),
  issueCode: (id: string) => request<{ activationCode: string }>(`/api/admin/licenses/${encodeURIComponent(id)}/codes`, { method: 'POST' }),
  offlineKey: (id: string) => request<{ offlineKey: string }>(`/api/admin/licenses/${encodeURIComponent(id)}/offline-key`, { method: 'POST' }),
  renewLicense: (id: string, expiresAt: number) => request(`/api/admin/licenses/${encodeURIComponent(id)}/renew`, { method: 'POST', body: JSON.stringify({ expiresAt }) }),
  updateLicenseScope: (id: string, body: LicenseScopeValues & { expectedScope: LicenseScopeSnapshot }) => request<{ ok: true; changed: boolean; requiresOfflineReissue: boolean }>(`/api/admin/licenses/${encodeURIComponent(id)}/scope`, { method: 'POST', body: JSON.stringify(body) }),
  login: (body: { username: string; password: string; captchaId: string; captcha: string }) => request<{ username: string }>('/api/admin/login', { method: 'POST', body: JSON.stringify(body) }),
  unlockUser: (id: string) => request(`/api/admin/users/${encodeURIComponent(id)}/unlock`, { method:'POST' }),
  sessions: () => request<import('./types').AdminSession[]>('/api/admin/sessions'),
  revokeOtherSessions: () => request('/api/admin/sessions/revoke-others', {method:'POST'}),
  securityEvents: (page: number) => request<{rows: import('./types').SecurityEvent[]; total:number}>(`/api/admin/security-events?page=${page}`),
  logout: () => request<{ ok: boolean }>('/api/admin/logout', { method: 'POST' }),
  createCustomer: (body: { name: string; contact?: string }) => request<{ id: string }>('/api/admin/customers', { method: 'POST', body: JSON.stringify(body) }),
  updateCustomer: (id: string, body: Record<string, unknown>) => request<{ ok: boolean }>(`/api/admin/customers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  updateSystem: (id: string, body: Record<string, unknown>) => request<{ ok: boolean }>(`/api/admin/systems/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  createLicense: (body: Record<string, unknown>) => request<{ id: string; activationCode?: string; offlineKey?: string }>('/api/admin/licenses', { method: 'POST', body: JSON.stringify(body) }),
  revokeLicense: (id: string) => request<{ ok: boolean }>(`/api/admin/licenses/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  revokeDevice: (id: string) => request<{ ok: boolean }>(`/api/admin/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  createUpdate: (body: Record<string, unknown>) => request<{ ok: boolean }>('/api/admin/updates', { method: 'POST', body: JSON.stringify(body) }),
  updateRelease: (id: string, body: Record<string, unknown>) => request<{ ok: boolean }>(`/api/admin/updates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  uploadRelease,
};

let loadingSession: Promise<BootstrapData> | null = null;
// Share one check across StrictMode effects. Expired sessions return to the login
// form; only the browser's password manager may retain and autofill credentials.
export function loadAdminSession(): Promise<BootstrapData> {
  if (!loadingSession) {
    loadingSession = adminApi.bootstrap().finally(() => { loadingSession = null; });
  }
  return loadingSession;
}
