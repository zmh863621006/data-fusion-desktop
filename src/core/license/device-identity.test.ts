import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDeviceIdentity } from './device-identity';
import { createDeviceId, LocalLicenseService } from './local-license-service';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-identity-test-')); directories.push(directory);
  return { directory, storagePath: join(directory, 'license.json'), publicKeyPem: publicKey };
}
function signed(deviceId: string, expiresAt = Date.now() + 60_000) {
  const bytes = Buffer.from(JSON.stringify({ licenseId: 'migration-fixture', deviceId, expiresAt, allowedSystems: ['market-access'] }));
  return { algorithm: 'RSA-SHA256', payload: bytes.toString('base64url'), signature: sign('RSA-SHA256', bytes, keys.privateKey).toString('base64url') };
}

describe('persistent installation identity and license recovery', () => {
  it('creates distinct identities on same-name fresh profiles and survives renaming and license replacement', async () => {
    const a = await fixture(), b = await fixture(), oldId = createDeviceId('same-host');
    const identity = loadDeviceIdentity(a.storagePath, publicKey, oldId);
    expect(identity.error).toBeUndefined(); expect(identity.deviceId).toMatch(/^[a-f0-9]{64}$/);
    expect(loadDeviceIdentity(b.storagePath, publicKey, oldId).deviceId).not.toBe(identity.deviceId);
    await writeFile(a.storagePath, '{broken replacement');
    expect(loadDeviceIdentity(a.storagePath, publicKey, createDeviceId('renamed')).deviceId).toBe(identity.deviceId);
    expect((await readdir(a.directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each([false, true])('pins a legitimate legacy binding even when expired=%s', async expired => {
    const f = await fixture(), legacyId = createDeviceId();
    await writeFile(f.storagePath, JSON.stringify({ activatedAt: Date.now(), envelope: signed(legacyId, Date.now() + (expired ? -60_000 : 60_000)) }));
    const service = new LocalLicenseService(f);
    expect(service.deviceId).toBe(legacyId);
    expect((await service.getStatus()).state).toBe(expired ? 'expired' : 'active');
    expect(loadDeviceIdentity(f.storagePath, publicKey, createDeviceId('renamed')).deviceId).toBe(legacyId);
    expect(JSON.parse(await readFile(join(f.directory, 'device-identity.json'), 'utf8')).kind).toBe('legacy');
  });

  it('does not adopt another device from a copied signed grant or silently replace an unreadable identity', async () => {
    const f = await fixture(), foreignId = createDeviceId('foreign');
    await writeFile(f.storagePath, JSON.stringify({ activatedAt: Date.now(), envelope: signed(foreignId) }));
    const service = new LocalLicenseService(f);
    expect(service.deviceId).toBe(''); expect((await service.getStatus()).state).toBe('invalid');
    expect(await service.getCurrent()).toBeNull(); expect(await service.clientAuthorization()).toBeNull();
    expect(await readdir(f.directory)).not.toContain('device-identity.json');
    await writeFile(join(f.directory, 'device-identity.json'), 'broken identity');
    expect(new LocalLicenseService(f).deviceId).toBe('');
    expect(await readFile(join(f.directory, 'device-identity.json'), 'utf8')).toBe('broken identity');
  });

  it.each(['{broken', 'null', '[]'])('returns an actionable invalid status and exact recovery copy for %s', async bytes => {
    const f = await fixture(); await writeFile(f.storagePath, bytes);
    const service = new LocalLicenseService(f);
    expect(service.deviceId).toBe(createDeviceId());
    expect(await service.getStatus()).toMatchObject({ state: 'invalid', message: expect.stringContaining('license-recovery') });
    expect(await service.getCurrent()).toBeNull(); expect(await service.refreshOnline()).toBeNull();
    expect(await service.clientAuthorization()).toBeNull();
    const copies = await readdir(join(f.directory, 'license-recovery'));
    expect(copies).toHaveLength(1); expect(await readFile(join(f.directory, 'license-recovery', copies[0]), 'utf8')).toBe(bytes);
    expect(await readFile(f.storagePath, 'utf8')).toBe(bytes);
    // Reactivation must work without discarding the diagnostic copy or identity.
    const envelope = signed(service.deviceId);
    await service.activate(`DFL1.${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`);
    expect((await service.getStatus()).state).toBe('active');
    expect(new LocalLicenseService(f).deviceId).toBe(service.deviceId);
    expect(await readFile(join(f.directory, 'license-recovery', copies[0]), 'utf8')).toBe(bytes);
  });

  it('reports failed diagnostic copying accurately and keeps the original', async () => {
    const f = await fixture(); await writeFile(f.storagePath, '{broken');
    await writeFile(join(f.directory, 'license-recovery'), 'not-a-directory');
    const status = await new LocalLicenseService(f).getStatus();
    expect(status.message).toContain('恢复副本未能保存'); expect(status.message).not.toContain('副本保存在');
    expect(await readFile(f.storagePath, 'utf8')).toBe('{broken');
  });

  it('does not throw or generate a replacement identity when the original license cannot be read', async () => {
    const f = await fixture(); await mkdir(f.storagePath);
    const service = new LocalLicenseService(f);
    expect(await service.getStatus()).toMatchObject({ state: 'invalid', message: expect.stringContaining('不可读') });
    expect(service.deviceId).toBe(''); expect(await service.getCurrent()).toBeNull();
    expect(await readdir(f.directory)).not.toContain('device-identity.json');
  });

  it('preserves legacy development binding only when development mode is explicitly enabled', async () => {
    const f = await fixture(), legacyId = createDeviceId();
    await writeFile(f.storagePath, JSON.stringify({ activatedAt: Date.now(), developmentGrant: {
      licenseId: 'development-local', deviceId: legacyId, expiresAt: Date.now() + 60_000, allowedSystems: ['market-access'],
    } }));
    const service = new LocalLicenseService({ ...f, allowDevelopmentLicense: true });
    expect(service.deviceId).toBe(legacyId); expect((await service.getStatus()).state).toBe('active');
    expect(await new LocalLicenseService(f).getCurrent()).toBeNull();
  });
});
