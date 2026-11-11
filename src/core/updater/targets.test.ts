import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateService, artifactMatchesTarget, validArtifact, type UpdateArtifact } from './service';
import { AutomaticUpdateController, type AutomaticUpdateDependencies } from './automatic';

const data = Buffer.from('isolated DEB fixture');
const linux: UpdateArtifact = { version: '1.0.22', url: 'https://updates.test/kylin.deb', bytes: data.length,
  sha256: createHash('sha256').update(data).digest('hex'), installer: 'deb', platform: 'linux', arch: 'x64' };
const windows: UpdateArtifact = { ...linux, url: 'https://updates.test/windows.exe', installer: 'nsis', platform: 'win32' };
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const envelope = (app: UpdateArtifact) => {
  const payload = Buffer.from(JSON.stringify({ app }));
  return { algorithm: 'RSA-SHA256', payload: payload.toString('base64url'), signature: sign('RSA-SHA256', payload, keys.privateKey).toString('base64url') };
};
afterEach(() => vi.unstubAllGlobals());
it('accepts only matching platform, extension, installer and architecture combinations', () => {
  expect(validArtifact(linux)).toBe(true); expect(validArtifact({ ...linux, arch: 'arm64' })).toBe(true);
  expect(validArtifact({ ...linux, platform: 'win32' })).toBe(false);
  expect(validArtifact({ ...linux, installer: 'nsis' })).toBe(false);
  expect(validArtifact({ ...linux, arch: undefined })).toBe(false);
  expect(artifactMatchesTarget(windows, { platform: 'linux', arch: 'x64' })).toBe(false);
  expect(artifactMatchesTarget({ ...linux, arch: 'arm64' }, { platform: 'linux', arch: 'x64' })).toBe(false);
});
it.each(['x64', 'arm64'] as const)('sends the Linux %s target with signed device proof and accepts only that feed', async arch => {
  const app = { ...linux, arch };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(envelope(app))); vi.stubGlobal('fetch', fetcher);
  const service = new UpdateService('https://updates.test/feed', publicKey, { platform: 'linux', arch });
  const proof = { algorithm: 'RSA-SHA256' as const, payload: 'proof', signature: 'signature' };
  expect((await service.check('1.0.20', { licenseId: 'test', deviceId: 'test', proof })).app).toEqual(app);
  expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toMatchObject({ platform: 'linux', arch, currentVersion: '1.0.20' });
  fetcher.mockResolvedValueOnce(Response.json(envelope(windows)));
  await expect(service.check('1.0.20')).rejects.toThrow('不匹配');
});
it('downloads Linux bytes with a .deb extension and rejects another platform before networking', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'fusion-linux-download-'));
  const service = new UpdateService(undefined, publicKey, { platform: 'linux', arch: 'x64' });
  const fetcher = vi.fn(async () => new Response(data)); vi.stubGlobal('fetch', fetcher);
  try {
    const path = await service.downloadApp(linux, folder); expect(path.endsWith('.deb')).toBe(true); expect(await readFile(path)).toEqual(data);
    await expect(service.downloadApp(windows, folder)).rejects.toThrow('不匹配'); expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it('downloads a Linux update in the background and opens its installer only after explicit confirmation', async () => {
  const deps: AutomaticUpdateDependencies = { version: '1.0.20', installMode: 'system', target: { platform: 'linux', arch: 'x64' },
    settings: async () => ({ autoCheckUpdates: true }), check: vi.fn(async () => ({ configured: true, checkedAt: 1, app: linux })),
    download: vi.fn(async () => '/private/cache.deb'), verify: vi.fn(async () => {}), install: vi.fn(async () => {}),
    busy: vi.fn(() => false), changed: vi.fn() };
  const controller = new AutomaticUpdateController(deps);
  await controller.check(); expect(controller.snapshot()).toMatchObject({ status: 'ready', installMode: 'system' });
  expect(deps.install).not.toHaveBeenCalled();
  await controller.install(); expect(deps.install).toHaveBeenCalledExactlyOnceWith('/private/cache.deb', linux);
});
it('refuses a cross-architecture replacement during the final live-publication check', async () => {
  const check = vi.fn(async () => ({ configured: true, checkedAt: 1, app: linux }));
  const install = vi.fn(async () => {});
  const controller = new AutomaticUpdateController({ version: '1.0.20', installMode: 'system', target: { platform: 'linux', arch: 'x64' },
    settings: async () => ({ autoCheckUpdates: true }), check, download: async () => '/private/cache.deb', verify: async () => {}, install,
    busy: () => false, changed: () => {} });
  await controller.check(); check.mockResolvedValueOnce({ configured: true, checkedAt: 2, app: { ...linux, arch: 'arm64' } });
  await expect(controller.install()).rejects.toThrow('尚未安装'); expect(install).not.toHaveBeenCalled();
});
