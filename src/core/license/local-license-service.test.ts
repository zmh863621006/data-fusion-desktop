import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalLicenseService } from './local-license-service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals(); vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('LocalLicenseService', () => {
  async function onlineFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'data-fusion-license-'));
    temporaryDirectories.push(directory);
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const service = new LocalLicenseService({ storagePath: join(directory, 'license.json'), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), statusEndpoint: 'https://license.invalid/status' });
    const envelope = (expiresAt: number) => {
      const payload = Buffer.from(JSON.stringify({ licenseId: 'online', activationMode: 'online', deviceId: service.deviceId,
        expiresAt, allowedSystems: ['government-info'], allowedMatters: { 'government-info': ['double-publicity-return'] } }));
      return { payload: payload.toString('base64url'), signature: sign('RSA-SHA256', payload, privateKey).toString('base64url'), algorithm: 'RSA-SHA256' };
    };
    await service.activate(`DFL1.${Buffer.from(JSON.stringify(envelope(Date.now()+1000))).toString('base64url')}`);
    return { service, envelope };
  }

  it('migrates signed legacy government permissions and refreshes a renewed expired online license', async () => {
    const { service, envelope } = await onlineFixture();
    expect((await service.getCurrent())?.allowedMatters?.['government-info']).toHaveLength(18);
    vi.useFakeTimers(); vi.setSystemTime(Date.now()+2000);
    expect(await service.getCurrent()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(envelope(Date.now()+60_000))));
    expect((await service.refreshOnline())?.licenseId).toBe('online');
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(sent.proof.algorithm).toBe('RSA-SHA256');
    expect(sent.deviceId).toBe(service.deviceId);
  });

  it('keeps a valid grant when offline, revokes on explicit 403, and can recover after re-enabling', async () => {
    const { service, envelope } = await onlineFixture();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(service.refreshOnline()).rejects.toThrow('offline'); expect(await service.getCurrent()).not.toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    await expect(service.refreshOnline()).rejects.toThrow('停用'); expect(await service.getCurrent()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(envelope(Date.now()+60_000))));
    expect(await service.refreshOnline()).not.toBeNull();
  });

  it('does not resurrect a locally deactivated license from an in-flight heartbeat', async () => {
    const { service, envelope } = await onlineFixture(); let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const pending = service.refreshOnline(); await vi.waitFor(() => expect(finish).toBeDefined());
    await service.deactivate(); finish(Response.json(envelope(Date.now()+60_000))); await pending;
    expect(await service.getCurrent()).toBeNull();
  });

  it('does not overwrite a newly activated license with an older heartbeat response', async () => {
    const { service, envelope } = await onlineFixture(); let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const pending = service.refreshOnline(); await vi.waitFor(() => expect(finish).toBeDefined());
    const newExpiry = Date.now()+120_000;
    await service.activate(`DFL1.${Buffer.from(JSON.stringify(envelope(newExpiry))).toString('base64url')}`);
    finish(Response.json(envelope(Date.now()+30_000))); await pending;
    expect((await service.getCurrent())?.expiresAt).toBe(newExpiry);
  });
  it('activates and reloads a signed offline license', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'data-fusion-license-'));
    temporaryDirectories.push(directory);
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const grant = { licenseId: 'test-license', expiresAt: Date.now() + 60_000, allowedSystems: ['market-access'] };
    const payload = Buffer.from(JSON.stringify(grant), 'utf8').toString('base64url');
    const envelope = {
      payload,
      signature: sign('RSA-SHA256', Buffer.from(payload, 'base64url'), privateKey).toString('base64url'),
      algorithm: 'RSA-SHA256',
    };
    const key = `DFL1.${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}`;
    const options = { storagePath: join(directory, 'license.json'), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    const service = new LocalLicenseService(options);
    expect((await service.activate(key)).licenseId).toBe('test-license');
    expect((await new LocalLicenseService(options).getStatus()).state).toBe('active');
    expect((await new LocalLicenseService(options).getCurrent())?.allowedSystems).toEqual(['market-access']);
  });

  it('only accepts the development key when explicitly enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'data-fusion-license-'));
    temporaryDirectories.push(directory);
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const base = { storagePath: join(directory, 'license.json'), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    await expect(new LocalLicenseService(base).activate('DF-DEV-LOCAL')).rejects.toThrow('格式无效');
    const service = new LocalLicenseService({ ...base, allowDevelopmentLicense: true });
    const grant = await service.activate('DF-DEV-LOCAL');
    expect(grant.licenseId).toBe('development-local');
    expect(grant.allowedSystems).toContain('shenzhen-hazardous-chemicals');
  });

  it('adds new built-ins to an existing development grant only in development mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'data-fusion-license-'));
    temporaryDirectories.push(directory);
    const options = { storagePath: join(directory, 'license.json'), publicKeyPem: '', allowDevelopmentLicense: true };
    await writeFile(options.storagePath, JSON.stringify({ activatedAt: Date.now(), developmentGrant: {
      licenseId: 'development-local', expiresAt: Date.now() + 60_000, allowedSystems: ['market-access'],
    } }));
    const service = new LocalLicenseService(options);
    expect((await service.getCurrent())?.allowedSystems).toContain('shenzhen-hazardous-chemicals');
    expect((await service.getStatus()).grant?.allowedSystems).toContain('shenzhen-hazardous-chemicals');
    expect(await new LocalLicenseService({ ...options, allowDevelopmentLicense: false }).getCurrent()).toBeNull();
  });
});
