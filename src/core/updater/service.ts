import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SignedLicenseEnvelope } from '../license/signed-license';

export interface UpdateTarget { platform: 'win32' | 'linux'; arch: 'x64' | 'arm64' }
export function runtimeUpdateTarget(platform: string, arch: string): UpdateTarget | undefined {
  return platform === 'win32' && arch === 'x64' || platform === 'linux' && ['x64', 'arm64'].includes(arch)
    ? { platform, arch } as UpdateTarget : undefined;
}

export interface UpdateArtifact {
  version: string;
  url: string;
  sha256: string;
  notes?: string;
  id?: string;
  bytes?: number;
  fileName?: string;
  installer?: 'nsis' | 'deb';
  platform?: UpdateTarget['platform'];
  arch?: UpdateTarget['arch'];
}

interface UpdateManifestPayload {
  app?: UpdateArtifact;
}

interface SignedUpdateManifest {
  payload: string;
  signature: string;
  algorithm: 'RSA-SHA256';
}

export interface UpdateCheckResult {
  configured: boolean;
  checkedAt: number;
  app?: UpdateArtifact;
  message?: string;
}

const MAX_BYTES = 500 * 1024 * 1024;
export const validVersion = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value);
export function newer(candidate: string, current: string): boolean {
  if (!validVersion(candidate) || !validVersion(current)) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

export function validArtifact(value: UpdateArtifact): boolean {
  if (!value || !validVersion(value.version) || typeof value.url !== 'string' || value.url.length > 2048
    || !/^[a-f0-9]{64}$/.test(value.sha256) || (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 10_000))) return false;
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_BYTES)) return false;
    if (value.platform === 'linux') return value.installer === 'deb' && ['x64', 'arm64'].includes(value.arch ?? '')
      && typeof value.bytes === 'number' && value.bytes > 0 && /\.deb$/i.test(url.pathname);
    return (value.platform === undefined || value.platform === 'win32') && (value.arch === undefined || value.arch === 'x64')
      && (value.installer === undefined || value.installer === 'nsis') && /\.(?:exe|msi)$/i.test(url.pathname)
      && (value.installer !== 'nsis' || /\.exe$/i.test(url.pathname));
  } catch { return false; }
}

export function artifactMatchesTarget(artifact: UpdateArtifact, target: UpdateTarget): boolean {
  if (!validArtifact(artifact)) return false;
  if (target.platform === 'linux') return artifact.platform === 'linux' && artifact.arch === target.arch && artifact.installer === 'deb';
  // Historical records without target metadata are Windows-only, never Linux.
  return target.arch === 'x64' && (artifact.platform === undefined || artifact.platform === 'win32')
    && (artifact.arch === undefined || artifact.arch === 'x64');
}

export interface DownloadProgress { downloaded: number; total?: number; percent?: number }

const stopReader = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  // A hostile or stalled stream must not keep application shutdown waiting for cancel().
  void reader.cancel().catch(() => {});
  try { reader.releaseLock(); } catch { /* Native fetch closes the pending read on abort. */ }
};
function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new Error('更新下载已取消或超时'));
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(new Error('更新下载已取消或超时')); };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}
async function boundedManifest(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > 100_000) { void response.body?.cancel().catch(() => {}); throw new Error('更新清单超过安全限制'); }
  if (!response.body) throw new Error('更新清单格式无效');
  const reader = response.body.getReader(), chunks: Buffer[] = []; let total = 0;
  try {
    for (;;) {
      const { value, done } = await readChunk(reader, signal);
      if (done) break;
      total += value.byteLength;
      if (total > 100_000) throw new Error('更新清单超过安全限制');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
    catch { throw new Error('更新清单格式无效'); }
  } finally { stopReader(reader); }
}

export class UpdateService {
  private readonly downloads = new Map<string, Promise<string>>();
  constructor(private readonly endpoint: string | undefined, private readonly publicKeyPem: string,
    private readonly target: UpdateTarget = { platform: 'win32', arch: 'x64' }) {}

  async check(appVersion: string, identity?: { licenseId: string; deviceId: string; proof: SignedLicenseEnvelope }): Promise<UpdateCheckResult> {
    if (!this.endpoint) return { configured: false, checkedAt: Date.now(), message: '尚未配置更新服务地址' };
    const endpoint = new URL(this.endpoint);
    if (endpoint.username || endpoint.password || endpoint.hash || !(endpoint.protocol === 'https:'
      || endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('更新服务必须使用HTTPS地址');
    const signal = AbortSignal.timeout(15_000);
    let response: Response;
    try { response = await fetch(endpoint, { signal, redirect: 'error', cache: 'no-store', credentials: 'omit', headers: { accept: 'application/json', ...(identity ? {'content-type':'application/json'} : {}) },
      ...(identity ? { method:'POST', body:JSON.stringify({ ...identity, ...this.target, currentVersion: appVersion }) } : {}) }); }
    catch { throw new Error('更新服务连接失败，请检查网络后重试'); }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`更新服务返回 ${response.status}`); }
    const envelope = await boundedManifest(response, signal) as SignedUpdateManifest;
    if (!envelope || envelope.algorithm !== 'RSA-SHA256' || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('更新清单格式无效');
    const payloadBytes = Buffer.from(envelope.payload, 'base64url');
    if (!verify('RSA-SHA256', payloadBytes, createPublicKey(this.publicKeyPem), Buffer.from(envelope.signature, 'base64url'))) throw new Error('更新清单签名无效');
    const payload = JSON.parse(payloadBytes.toString('utf8')) as UpdateManifestPayload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.app !== undefined && !validArtifact(payload.app)) throw new Error('主程序更新信息无效');
    if (payload.app && !artifactMatchesTarget(payload.app, this.target)) throw new Error('更新包与当前系统或芯片架构不匹配');
    return {
      configured: true,
      checkedAt: Date.now(),
      app: payload.app && newer(payload.app.version, appVersion) ? payload.app : undefined,
    };
  }

  static verifyDownload(data: Buffer, sha256: string): void {
    if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('更新包摘要校验失败');
  }

  async downloadApp(artifact: UpdateArtifact, directory: string, progress?: (value: DownloadProgress) => void, signal?: AbortSignal): Promise<string> {
    if (!artifactMatchesTarget(artifact, this.target)) throw new Error('更新包与当前系统或芯片架构不匹配');
    if (signal?.aborted) throw new Error('更新下载已取消');
    const key = `${resolve(directory)}:${artifact.version}:${artifact.sha256}`;
    const existing = this.downloads.get(key);
    if (existing) {
      const path = await existing;
      if (signal?.aborted) throw new Error('更新下载已取消');
      await this.verifyFile(path, artifact);
      return path;
    }
    const work = this.performDownload(artifact, directory, progress, signal);
    this.downloads.set(key, work);
    try { return await work; } finally { if (this.downloads.get(key) === work) this.downloads.delete(key); }
  }

  private async performDownload(artifact: UpdateArtifact, directory: string, progress?: (value: DownloadProgress) => void, signal?: AbortSignal): Promise<string> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const extension = artifact.installer === 'deb' ? '.deb' : new URL(artifact.url).pathname.toLowerCase().endsWith('.msi') ? '.msi' : '.exe';
    const finalPath = join(directory, `data-fusion-${this.target.platform}-${this.target.arch}-${artifact.version}-${artifact.sha256.slice(0, 16)}${extension}`);
    if (signal?.aborted) throw new Error('更新下载已取消');
    try {
      await this.verifyFile(finalPath, artifact);
      if (signal?.aborted) throw new Error('更新下载已取消');
      progress?.({ downloaded: (await lstat(finalPath)).size, total: artifact.bytes, percent: 100 });
      return finalPath;
    } catch { /* A stale/corrupt cache is never executable; replace it only after a verified new download. */ }
    if (signal?.aborted) throw new Error('更新下载已取消');
    const temporaryPath = `${finalPath}.${randomUUID()}.download`;
    const timeout = AbortSignal.timeout(10 * 60_000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let file: Awaited<ReturnType<typeof open>> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, response: Response | undefined;
    try {
      response = await fetch(artifact.url, { signal: combined, redirect: 'error', credentials: 'omit' });
      if (response.status !== 200) throw new Error(`更新包下载失败（${response.status}）`);
      const header = response.headers.get('content-length');
      if (header !== null && (!/^\d+$/.test(header) || !Number.isSafeInteger(Number(header)) || Number(header) > MAX_BYTES)) throw new Error('更新包大小超过限制或响应无效');
      const declaredSize = header === null ? undefined : Number(header), total = artifact.bytes ?? declaredSize;
      if (artifact.bytes !== undefined && declaredSize !== undefined && artifact.bytes !== declaredSize) throw new Error('更新包大小与已签名清单不符');
      if (!response.body) throw new Error('更新包内容为空');
      reader = response.body.getReader(); file = await open(temporaryPath, 'wx', 0o600);
      const hash = createHash('sha256'); let downloaded = 0, reportedAt = 0;
      for (;;) {
        if (combined.aborted) throw new Error('更新下载已取消或超时');
        const { value, done } = await readChunk(reader, combined);
        if (done) break;
        downloaded += value.byteLength;
        if (downloaded > MAX_BYTES || total !== undefined && downloaded > total) throw new Error('更新包大小超过限制或清单大小');
        hash.update(value); await file.writeFile(value);
        if (Date.now() - reportedAt > 200) { reportedAt = Date.now(); progress?.({ downloaded, total, percent: total ? Math.min(99, Math.floor(downloaded / total * 100)) : undefined }); }
      }
      if (!downloaded || total !== undefined && downloaded !== total) throw new Error('更新包下载不完整');
      if (hash.digest('hex') !== artifact.sha256) throw new Error('更新包摘要校验失败');
      if (combined.aborted) throw new Error('更新下载已取消或超时');
      await file.sync(); await file.close(); file = undefined;
      await rename(temporaryPath, finalPath);
      progress?.({ downloaded, total, percent: 100 });
      return finalPath;
    } catch (error) {
      // Native fetch failures may contain credential-bearing URLs; retain only our fixed messages.
      if (error instanceof Error && /^(更新包|更新下载)/.test(error.message)) throw error;
      throw new Error('更新包下载失败，请检查网络后重试');
    } finally {
      if (reader) stopReader(reader);
      else void response?.body?.cancel().catch(() => {});
      await file?.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async verifyFile(path: string, artifact: UpdateArtifact): Promise<void> {
    if (!artifactMatchesTarget(artifact, this.target)) throw new Error('更新包与当前系统或芯片架构不匹配');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_BYTES || artifact.bytes !== undefined && info.size !== artifact.bytes) throw new Error('更新包大小校验失败');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== artifact.sha256) throw new Error('更新包摘要校验失败');
  }
}
