import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newer, UpdateService, validArtifact, validVersion, artifactMatchesTarget, type UpdateArtifact } from './service';

afterEach(() => vi.unstubAllGlobals());

describe('UpdateService', () => {
  it('returns a newer signed application version', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const manifest = {
      app: { version: '1.1.0', url: 'https://updates.example/app.exe', sha256: 'a'.repeat(64) },
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const envelope = { algorithm: 'RSA-SHA256', payload: bytes.toString('base64url'), signature: sign('RSA-SHA256', bytes, privateKey).toString('base64url') };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(envelope), { status: 200 })));
    const service = new UpdateService('https://updates.example/manifest.json', publicKey.export({ type: 'spki', format: 'pem' }).toString());
    const result = await service.check('1.0.0');
    expect(result.app?.version).toBe('1.1.0');
  });

  it('rejects a manifest with an invalid signature', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const envelope = { algorithm: 'RSA-SHA256', payload: Buffer.from('{}').toString('base64url'), signature: Buffer.alloc(256).toString('base64url') };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(envelope), { status: 200 })));
    const service = new UpdateService('https://updates.example/manifest.json', publicKey.export({ type: 'spki', format: 'pem' }).toString());
    await expect(service.check('1.0.0')).rejects.toThrow('签名无效');
  });

  it('sends device proof in POST body without putting credentials in the URL', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const payload=Buffer.from(JSON.stringify({}));
    const envelope={algorithm:'RSA-SHA256' as const,payload:payload.toString('base64url'),signature:sign('RSA-SHA256',payload,privateKey).toString('base64url')};
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json(envelope)));
    const service=new UpdateService('https://updates.example/api/updates/manifest',publicKey.export({type:'spki',format:'pem'}).toString());
    const identity={licenseId:'fixture',deviceId:'a'.repeat(64),proof:envelope};
    await service.check('1.0.0',identity);
    const [url,options]=vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe('https://updates.example/api/updates/manifest');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(options?.body as string)).toEqual({ ...identity, platform: 'win32', arch: 'x64', currentVersion: '1.0.0' });
  });

  it('downloads an application installer after verifying its SHA256', async () => {
    const bytes = Buffer.from('signed application installer');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })));
    const directory = await mkdtemp(join(tmpdir(), 'data-fusion-update-'));
    try {
      const service = new UpdateService(undefined, 'unused');
      const path = await service.downloadApp({ version: '1.2.0', url: 'https://updates.example/data-fusion.msi', sha256 }, directory);
      expect(path.endsWith('.msi')).toBe(true);
      expect(await readFile(path)).toEqual(bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const signingKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = signingKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
function envelope(payload: unknown) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return { algorithm: 'RSA-SHA256', payload: bytes.toString('base64url'), signature: sign('RSA-SHA256', bytes, signingKeys.privateKey).toString('base64url') };
}
const installerBytes = Buffer.from('local isolated test package, never executable');
const sample: UpdateArtifact = { version: '1.0.3', url: 'https://updates.example/package.exe',
  sha256: createHash('sha256').update(installerBytes).digest('hex'), bytes: installerBytes.length, installer: 'nsis', platform: 'win32', arch: 'x64' };
const directories: string[] = [];
async function directory() { const value = await mkdtemp(join(tmpdir(), 'data-fusion-update-')); directories.push(value); return value; }
afterEach(async () => { for (const path of directories.splice(0)) {
  expect(dirname(resolve(path))).toBe(resolve(tmpdir())); expect(basename(path)).toMatch(/^data-fusion-update-/);
  await rm(path, { recursive: true, force: true });
} });

describe('update feed and version security', () => {
  it.each(['1.0.3-rc.1','01.0.3','1.0','1.0.3.4','1.0.3/evil','1000000.0.0','1.0.3 '])('rejects a malformed version %s', value => expect(validVersion(value)).toBe(false));
  it('compares exact release versions, without allowing a same-version update or downgrade', () => {
    expect(newer('1.10.0','1.2.9')).toBe(true); expect(newer('2.0.0','1.99.99')).toBe(true);
    expect(newer('1.0.3','1.0.3')).toBe(false); expect(newer('1.0.2','1.0.3')).toBe(false);
    expect(newer('1.0.3','broken')).toBe(false);
  });
  it.each(['http://updates.example/feed','https://user:password@updates.example/feed','https://updates.example/feed#secret'])('rejects insecure/credential-bearing update services before network: %s', async endpoint => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(new UpdateService(endpoint, publicPem).check('1.0.2')).rejects.toThrow('HTTPS'); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['http://updates.example/app.exe','https://user:password@updates.example/app.exe','https://updates.example/app.html','https://updates.example/app.exe#bad'])('rejects unsafe installer URLs: %s', url => expect(validArtifact({ ...sample, url })).toBe(false));
  it('limits every managed package to the supported Windows NSIS shape and a bounded signed size', () => {
    expect(validArtifact({ ...sample, url: 'https://updates.example/app.msi' })).toBe(false);
    expect(validArtifact({ ...sample, bytes: 0 })).toBe(false); expect(validArtifact({ ...sample, bytes: 500 * 1024 * 1024 + 1 })).toBe(false);
    expect(validArtifact({ ...sample, bytes: 1.5 })).toBe(false);
  });
  it('does not treat a malformed signed payload or unsigned metadata as a usable release', async () => {
    for (const payload of [null, [], { app: null }, { app: { ...sample, bytes: -1 } }, { app: { ...sample, sha256: 'b'.repeat(63) } }]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(envelope(payload))));
      await expect(new UpdateService('https://updates.example/feed', publicPem).check('1.0.2')).rejects.toThrow();
    }
  });
  it('bounds the feed while streaming, not after reading an arbitrarily large body', async () => {
    let pulls = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(60_000)); }, cancel() { cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    await expect(new UpdateService('https://updates.example/feed', publicPem).check('1.0.2')).rejects.toThrow('安全限制');
    expect(cancelled).toBe(true); expect(pulls).toBeLessThan(5);
  });
  it('rejects declared oversized feeds before consuming content and masks raw network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'content-length': '100001' } })));
    await expect(new UpdateService('https://updates.example/feed', publicPem).check('1.0.2')).rejects.toThrow('安全限制');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('private token URL'); }));
    await expect(new UpdateService('https://updates.example/feed', publicPem).check('1.0.2')).rejects.toThrow('连接失败');
  });
  it('only offers a signed newer release and disables redirects, cookies and caching for device-proof checks', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(envelope({ app: sample }))); vi.stubGlobal('fetch', fetcher);
    const service = new UpdateService('https://updates.example/feed', publicPem);
    expect((await service.check('1.0.3')).app).toBeUndefined(); expect((await service.check('1.0.4')).app).toBeUndefined();
    expect((await service.check('1.0.2')).app).toEqual(sample);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
  });
});

describe('bounded atomic update package downloads', () => {
  it('deduplicates concurrent downloads and reuses a verified completed package without another network request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(installerBytes)); vi.stubGlobal('fetch', fetcher);
    const service = new UpdateService(undefined, publicPem), folder = await directory(), progress = vi.fn();
    const [first, second] = await Promise.all([service.downloadApp(sample, folder, progress), service.downloadApp(sample, folder)]);
    expect(first).toBe(second); expect(fetcher).toHaveBeenCalledTimes(1); expect(progress).toHaveBeenLastCalledWith({ downloaded: sample.bytes, total: sample.bytes, percent: 100 });
    expect(await service.downloadApp(sample, folder)).toBe(first); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(await readdir(folder)).toEqual([basename(first)]);
  });
  it('a corrupted cache is not executed/reused, and is replaced only by another verified package', async () => {
    const fetcher = vi.fn(async () => new Response(installerBytes)); vi.stubGlobal('fetch', fetcher);
    const service = new UpdateService(undefined, publicPem), folder = await directory();
    const path = await service.downloadApp(sample, folder); await writeFile(path, Buffer.from('corrupt'));
    expect(await service.downloadApp(sample, folder)).toBe(path); expect(fetcher).toHaveBeenCalledTimes(2); expect(await readFile(path)).toEqual(installerBytes);
  });
  it('does not let a concurrent caller bypass its own signed size constraint', async () => {
    const fetcher = vi.fn(async () => new Response(installerBytes)); vi.stubGlobal('fetch', fetcher);
    const folder = await directory(), service = new UpdateService(undefined, publicPem);
    const first = service.downloadApp(sample, folder), wrongSize = service.downloadApp({ ...sample, bytes: sample.bytes! + 1 }, folder);
    await first; await expect(wrongSize).rejects.toThrow('大小'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not replace a previous completed file when a repair download has a bad digest', async () => {
    const service = new UpdateService(undefined, publicPem), folder = await directory();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(installerBytes))); const path = await service.downloadApp(sample, folder);
    await writeFile(path, Buffer.from('previous file, not executable'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.alloc(installerBytes.length, 0))));
    await expect(service.downloadApp(sample, folder)).rejects.toThrow('摘要');
    expect((await readFile(path)).toString()).toBe('previous file, not executable'); expect(await readdir(folder)).toEqual([basename(path)]);
  });
  it.each(['oversized-header','mismatched-size','truncated','extra-bytes','empty','http-error','partial-response'])('rejects unsafe/incomplete downloads and cleans only its own temporary file: %s', async kind => {
    const folder = await directory(), service = new UpdateService(undefined, publicPem);
    await writeFile(join(folder, 'unrelated.txt'), 'must preserve');
    vi.stubGlobal('fetch', vi.fn(async () => kind === 'oversized-header' ? new Response('x', { headers: { 'content-length': String(500 * 1024 * 1024 + 1) } })
      : kind === 'mismatched-size' ? new Response(installerBytes, { headers: { 'content-length': '1' } })
      : kind === 'truncated' ? new Response(installerBytes.subarray(0, 2))
      : kind === 'extra-bytes' ? new Response(Buffer.concat([installerBytes, Buffer.from('x')]))
      : kind === 'empty' ? new Response(null)
      : kind === 'http-error' ? new Response('not allowed', { status: 403 })
      : new Response(installerBytes, { status: 206 })));
    await expect(service.downloadApp(sample, folder)).rejects.toThrow();
    expect(await readdir(folder)).toEqual(['unrelated.txt']); expect((await readFile(join(folder, 'unrelated.txt'))).toString()).toBe('must preserve');
  });
  it('enforces the size limit during unknown-length streaming, before buffering a whole response', async () => {
    const folder = await directory(), service = new UpdateService(undefined, publicPem); let pulls = 0, cancelled = false;
    // The signed size is deliberately small, so the same stream limit can be exercised without a 500MB allocation.
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(50)); }, cancel() { cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    await expect(service.downloadApp(sample, folder)).rejects.toThrow('大小'); expect(pulls).toBeLessThan(4); expect(cancelled).toBe(true); expect(await readdir(folder)).toEqual([]);
  });
  it('aborts a blocked reader immediately without depending on a mocked fetch abort implementation', async () => {
    const folder = await directory(), service = new UpdateService(undefined, publicPem), controller = new AbortController(); let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(installerBytes.subarray(0, 5)); }, cancel() { cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body))); const progress = vi.fn();
    const work = service.downloadApp(sample, folder, progress, controller.signal);
    await vi.waitFor(() => expect(progress).toHaveBeenCalled()); controller.abort();
    await expect(work).rejects.toThrow('取消'); expect(cancelled).toBe(true); expect(await readdir(folder)).toEqual([]);
  });
  it('rejects a pre-aborted download before network or temporary files', async () => {
    const folder = await directory(), controller = new AbortController(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); controller.abort();
    await expect(new UpdateService(undefined, publicPem).downloadApp(sample, folder, undefined, controller.signal)).rejects.toThrow('取消');
    expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(folder)).toEqual([]);
  });
  it('masks native network error details and leaves no half package', async () => {
    const folder = await directory(); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('https://secret.invalid?token=private'); }));
    await expect(new UpdateService(undefined, publicPem).downloadApp(sample, folder)).rejects.toThrow('检查网络'); expect(await readdir(folder)).toEqual([]);
  });
});
