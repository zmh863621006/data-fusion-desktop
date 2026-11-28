import { createHash } from 'node:crypto';
import { hostname, platform, arch } from 'node:os';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { verifySignedLicense, type SignedLicenseEnvelope } from './signed-license';
import type { LicenseGrant, LicenseService, LicenseStatus } from './types';
import { loadDeviceIdentity, licenseFileDigest } from './device-identity';

interface StoredLicense {
  envelope?: SignedLicenseEnvelope;
  developmentGrant?: LicenseGrant;
  activatedAt: number;
  lastCheckedAt?: number;
  revokedAt?: number;
}

export interface LocalLicenseOptions {
  storagePath: string;
  publicKeyPem: string;
  activationEndpoint?: string;
  statusEndpoint?: string;
  allowDevelopmentLicense?: boolean;
}

export function createDeviceId(seed = `${hostname()}|${platform()}|${arch()}`): string {
  return createHash('sha256').update(`data-fusion-desktop|${seed}`).digest('hex');
}

function decodeOfflineKey(key: string): SignedLicenseEnvelope {
  if (!key.startsWith('DFL1.')) throw new Error('激活密钥格式无效');
  try {
    const value = JSON.parse(Buffer.from(key.slice(5), 'base64url').toString('utf8')) as SignedLicenseEnvelope;
    if (!value || value.algorithm !== 'RSA-SHA256') throw new Error();
    return value;
  } catch {
    throw new Error('激活密钥格式无效');
  }
}

export class LocalLicenseService implements LicenseService {
  readonly deviceId: string;
  private readonly identityError?: string;
  private revision = 0;
  private writes: Promise<void> = Promise.resolve();
  private refreshInFlight?: { revision: number; result: Promise<LicenseGrant | null> };

  constructor(private readonly options: LocalLicenseOptions) {
    const identity = loadDeviceIdentity(options.storagePath, options.publicKeyPem, createDeviceId(), options.allowDevelopmentLicense);
    this.deviceId = identity.deviceId; this.identityError = identity.error;
  }

  async activate(key: string): Promise<LicenseGrant> {
    if (this.identityError) throw new Error(this.identityError);
    const revision = ++this.revision;
    const normalized = key.trim();
    if (this.options.allowDevelopmentLicense && normalized === 'DF-DEV-LOCAL') {
      const grant: LicenseGrant = {
        licenseId: 'development-local',
        activationMode: 'offline',
        customerName: '本机开发授权',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
        allowedSystems: ['market-access', 'government-info', 'transport-practitioner', 'oversize-transport', 'online-car-permit', 'guangdong-hrss', 'shenzhen-hazardous-chemicals'],
        allowedTools: ['health-publicity'],
        deviceId: this.deviceId,
        allowExport: true,
        allowAutoSync: true,
        allowAutoUpdate: false,
      };
      await this.persist({ developmentGrant: grant, activatedAt: Date.now() }, revision);
      return grant;
    }

    const envelope = normalized.startsWith('DFL1.')
      ? decodeOfflineKey(normalized)
      : this.options.activationEndpoint
        ? await this.activateOnline(normalized)
        : decodeOfflineKey(normalized);
    const grant = verifySignedLicense(envelope, this.options.publicKeyPem);
    if (grant.deviceId && grant.deviceId !== this.deviceId) throw new Error('该授权密钥未绑定当前设备');
    await this.persist({ envelope, activatedAt: Date.now(), lastCheckedAt: grant.activationMode === 'online' ? Date.now() : undefined }, revision);
    return grant;
  }

  async getCurrent(): Promise<LicenseGrant | null> {
    if (this.identityError) return null;
    const { stored } = await this.readStored();
    if (!stored) return null;
    if (stored.revokedAt) return null;
    if (stored.developmentGrant && this.options.allowDevelopmentLicense) {
      return Date.now() < stored.developmentGrant.expiresAt ? this.currentDevelopmentGrant(stored.developmentGrant) : null;
    }
    if (!stored.envelope) return null;
    try {
      const grant = verifySignedLicense(stored.envelope, this.options.publicKeyPem);
      if (grant.deviceId && grant.deviceId !== this.deviceId) return null;
      return grant;
    } catch {
      return null;
    }
  }

  async validate(): Promise<boolean> {
    return (await this.getCurrent()) !== null;
  }

  /** Main-process only: never return signed proof to the renderer or diagnostic logs. */
  async enterpriseAuthorization(): Promise<{ proof: SignedLicenseEnvelope; deviceId: string } | null> {
    return this.clientAuthorization();
  }

  async clientAuthorization(): Promise<{ proof: SignedLicenseEnvelope; deviceId: string } | null> {
    if (this.identityError) return null;
    const { stored } = await this.readStored();
    if (!stored?.envelope || stored.revokedAt) return null;
    let grant: LicenseGrant;
    try { grant = verifySignedLicense(stored.envelope, this.options.publicKeyPem); } catch { return null; }
    if (grant.deviceId !== this.deviceId) return null;
    return { proof: stored.envelope, deviceId: this.deviceId };
  }

  async getStatus(): Promise<LicenseStatus> {
    if (this.identityError) return { state: 'invalid', deviceId: this.deviceId, message: this.identityError };
    const { stored, error: readError } = await this.readStored();
    if (readError) return { state: 'invalid', deviceId: this.deviceId, message: readError };
    if (!stored) return { state: 'missing', deviceId: this.deviceId, message: '尚未激活' };
    try {
      const grant = stored.developmentGrant && this.options.allowDevelopmentLicense
        ? this.currentDevelopmentGrant(stored.developmentGrant)
        : stored.envelope
          ? verifySignedLicense(stored.envelope, this.options.publicKeyPem, { allowExpiredForRefresh: true })
          : undefined;
      if (!grant) return { state: 'invalid', deviceId: this.deviceId, message: '本地授权内容无效' };
      if (grant.deviceId && grant.deviceId !== this.deviceId) {
        return { state: 'invalid', deviceId: this.deviceId, message: '授权设备不匹配' };
      }
      const { licenseId, customerName, activationMode, expiresAt } = grant;
      const identity = { licenseId, customerName, activationMode, expiresAt };
      if (stored.revokedAt) return { state: 'invalid', identity, deviceId: this.deviceId, message: '在线授权已被管理员停用' };
      if (Date.now() >= expiresAt) return { state: 'expired', identity, deviceId: this.deviceId, message: '授权已过期' };
      return {
        state: 'active', grant, deviceId: this.deviceId,
        development: Boolean(stored.developmentGrant),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '授权校验失败';
      return { state: message.includes('过期') ? 'expired' : 'invalid', deviceId: this.deviceId, message };
    }
  }

  async deactivate(): Promise<void> {
    ++this.revision;
    const work = this.writes.then(() => unlink(this.options.storagePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    }));
    this.writes = work.catch(() => {}); await work;
  }

  refreshOnline(): Promise<LicenseGrant | null> {
    const revision = this.revision;
    if (this.refreshInFlight?.revision === revision) return this.refreshInFlight.result;
    const result = this.refreshStoredOnline(revision).finally(() => {
      if (this.refreshInFlight?.result === result) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = { revision, result };
    return result;
  }

  private async refreshStoredOnline(revision: number): Promise<LicenseGrant | null> {
    if (this.identityError) return null;
    const { stored } = await this.readStored();
    if (!stored?.envelope || !this.options.statusEndpoint) return this.getCurrent();
    let current: LicenseGrant;
    try { current = verifySignedLicense(stored.envelope, this.options.publicKeyPem, { allowExpiredForRefresh: true }); }
    catch { return null; }
    if (current.activationMode !== 'online') return this.getCurrent();
    if (current.deviceId !== this.deviceId) throw new Error('该在线授权不属于当前设备');
    const response = await fetch(this.options.statusEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licenseId: current.licenseId, deviceId: this.deviceId, proof: stored.envelope }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      if (response.status === 403) {
        await this.persist({ ...stored, revokedAt: Date.now(), lastCheckedAt: Date.now() }, revision);
        throw new Error('在线授权已被停用或过期');
      }
      throw new Error(`授权校验服务返回 ${response.status}`);
    }
    const envelope = await response.json() as SignedLicenseEnvelope;
    const grant = verifySignedLicense(envelope, this.options.publicKeyPem);
    if (grant.activationMode !== 'online' || grant.deviceId !== this.deviceId || grant.licenseId !== current.licenseId) throw new Error('在线授权服务返回内容不匹配');
    await this.persist({ envelope, activatedAt: stored.activatedAt, lastCheckedAt: Date.now() }, revision);
    return this.getCurrent();
  }

  private async activateOnline(key: string): Promise<SignedLicenseEnvelope> {
    const response = await fetch(this.options.activationEndpoint!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, deviceId: this.deviceId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`激活服务返回 ${response.status}`);
    return response.json() as Promise<SignedLicenseEnvelope>;
  }

  /** Development licenses follow built-in modules so an existing local grant survives module additions. */
  private currentDevelopmentGrant(grant: LicenseGrant): LicenseGrant {
    const allowedSystems = [...new Set([...grant.allowedSystems, 'market-access', 'government-info', 'transport-practitioner', 'oversize-transport', 'online-car-permit', 'guangdong-hrss', 'shenzhen-hazardous-chemicals'])];
    return { ...grant, allowedSystems, allowedTools: [...new Set([...(grant.allowedTools ?? []), 'health-publicity'])] };
  }

  private async readStored(): Promise<{ stored: StoredLicense | null; error?: string }> {
    let bytes: Buffer | undefined;
    try {
      bytes = await readFile(this.options.storagePath);
      if (bytes.length > 262_144) throw new Error('license size');
      const stored = JSON.parse(bytes.toString('utf8')) as StoredLicense;
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)
        || !Number.isSafeInteger(stored.activatedAt) || stored.activatedAt <= 0
        || (!stored.envelope && !stored.developmentGrant)) throw new Error('license structure');
      return { stored };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stored: null };
      let recoverySaved = false;
      if (bytes && bytes.length <= 262_144) {
        const directory = join(dirname(this.options.storagePath), 'license-recovery');
        const recoveryFile = join(directory, `invalid-${licenseFileDigest(bytes)}.json`);
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeFile(recoveryFile, bytes, { flag: 'wx', mode: 0o600 });
          recoverySaved = true;
        } catch (copyError) {
          if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') {
            const previous = await readFile(recoveryFile).catch(() => undefined);
            recoverySaved = Boolean(previous?.equals(bytes));
          }
        }
      }
      return { stored: null, error: bytes
        ? `本地授权文件损坏，原文件已保留；请重新激活${recoverySaved ? '，恢复副本保存在资料目录的 license-recovery 中' : '；恢复副本未能保存，请先备份原文件'}`
        : '本地授权文件无法读取，原文件已保留；请检查资料目录的访问权限后重试' };
    }
  }

  private async persist(value: StoredLicense, expectedRevision = this.revision): Promise<void> {
    const work = this.writes.then(async () => {
    if (expectedRevision !== this.revision) return;
    await mkdir(dirname(this.options.storagePath), { recursive: true });
    const temporary = `${this.options.storagePath}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.options.storagePath);
    });
    this.writes = work.catch(() => {}); await work;
  }
}
