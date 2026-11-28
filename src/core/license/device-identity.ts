import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifySignedLicense } from './signed-license';

export interface DeviceIdentity { schema: 1; deviceId: string; kind: 'installation' | 'legacy'; createdAt: number }
export interface DeviceIdentityResult { deviceId: string; error?: string }
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** One installation keeps its identity through hostname changes and license replacement. */
export function loadDeviceIdentity(storagePath: string, publicKey: string, legacyId: string, allowDevelopmentLicense = false): DeviceIdentityResult {
  const file = join(dirname(storagePath), 'device-identity.json');
  const read = (): DeviceIdentity => {
    const bytes = readFileSync(file);
    if (bytes.length > 4096) throw new Error('identity size');
    const value = JSON.parse(bytes.toString('utf8')) as DeviceIdentity;
    if (value?.schema !== 1 || !validId(value.deviceId) || !['installation', 'legacy'].includes(value.kind)
      || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) throw new Error('identity invalid');
    return value;
  };
  try { return { deviceId: read().deviceId }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { deviceId: '', error: '设备身份文件无法读取，已保留原文件；请恢复该文件或联系管理员处理后重新启动，未生成新的设备身份' };
  }
  let legacy = false;
  try {
    const bytes = readFileSync(storagePath);
    let stored: { envelope?: Parameters<typeof verifySignedLicense>[0]; developmentGrant?: { deviceId?: string } };
    try {
      if (bytes.length > 262_144) throw new Error('license size');
      stored = JSON.parse(bytes.toString('utf8'));
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('license structure');
    }
    catch { legacy = true; stored = {}; }
    if (stored.envelope) {
      try {
        const grant = verifySignedLicense(stored.envelope, publicKey, { allowExpiredForRefresh: true });
        if (grant.deviceId && grant.deviceId !== legacyId) return { deviceId: '', error: '已有授权与本机旧设备标识不一致，请恢复原设备身份文件或联系管理员换机' };
        legacy = grant.deviceId === legacyId;
      } catch { legacy = true; }
    } else if (allowDevelopmentLicense && stored.developmentGrant?.deviceId === legacyId) legacy = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { deviceId: '', error: '本地授权文件暂不可读，无法安全确定原设备身份；请恢复文件访问后重试' };
    }
  }
  const identity: DeviceIdentity = { schema: 1, deviceId: legacy ? legacyId : randomBytes(32).toString('hex'),
    kind: legacy ? 'legacy' : 'installation', createdAt: Date.now() };
  let temporary: string | undefined;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(identity)); fsyncSync(fd); } finally { closeSync(fd); }
    // Atomic no-replace publication: simultaneous initializers all use the winning identity.
    try { linkSync(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return { deviceId: read().deviceId };
  } catch {
    return { deviceId: '', error: '设备身份未能安全保存，请检查资料目录的写入权限后重试；未使用临时设备身份' };
  } finally { if (temporary && existsSync(temporary)) try { unlinkSync(temporary); } catch { /* A private incomplete candidate is never selected. */ } }
}

/** Stable non-secret fingerprint used only for naming local recovery evidence. */
export const licenseFileDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
