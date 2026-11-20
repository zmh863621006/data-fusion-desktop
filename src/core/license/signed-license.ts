import { createPublicKey, verify } from 'node:crypto';
import type { LicenseGrant } from './types';
import governmentMatters from '../../plugins/government-info/matter-catalog.json';

export interface SignedLicenseEnvelope {
  payload: string;
  signature: string;
  algorithm: 'RSA-SHA256';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(item));
}

function parseGrant(value: unknown): LicenseGrant {
  if (!isRecord(value) || typeof value.licenseId !== 'string' || value.licenseId.length > 128) {
    throw new Error('授权内容无效');
  }
  if (!Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= 0 || !validIds(value.allowedSystems)) {
    throw new Error('授权内容无效');
  }
  if (value.issuedAt !== undefined && (!Number.isSafeInteger(value.issuedAt) || Number(value.issuedAt) <= 0)) {
    throw new Error('授权签发时间无效');
  }
  if (value.notBefore !== undefined && (!Number.isSafeInteger(value.notBefore) || Number(value.notBefore) <= 0)) {
    throw new Error('授权生效时间无效');
  }
  if (value.maxDevices !== undefined && (!Number.isSafeInteger(value.maxDevices) || Number(value.maxDevices) < 1)) {
    throw new Error('授权设备数量无效');
  }
  if (value.allowExport !== undefined && typeof value.allowExport !== 'boolean') throw new Error('授权内容无效');
  if (value.allowAutoSync !== undefined && typeof value.allowAutoSync !== 'boolean') throw new Error('授权内容无效');
  if (value.allowAutoUpdate !== undefined && typeof value.allowAutoUpdate !== 'boolean') throw new Error('授权内容无效');
  if (value.activationMode !== undefined && value.activationMode !== 'online' && value.activationMode !== 'offline') throw new Error('授权激活模式无效');
  if (value.customerId !== undefined && (typeof value.customerId !== 'string' || value.customerId.length > 128)) throw new Error('授权客户标识无效');
  if (value.customerName !== undefined && (typeof value.customerName !== 'string' || value.customerName.length > 200)) {
    throw new Error('授权客户信息无效');
  }
  if (value.deviceId !== undefined && (typeof value.deviceId !== 'string' || !/^[a-f0-9]{64}$/.test(value.deviceId))) {
    throw new Error('授权设备信息无效');
  }
  if (value.allowedMatters != null) {
    if (!isRecord(value.allowedMatters) || Object.entries(value.allowedMatters).some(
      ([systemId, matters]) => !/^[a-z0-9][a-z0-9-]*$/.test(systemId) || (matters !== null && !validIds(matters)),
    )) throw new Error('授权事项范围无效');
  }
  if (value.allowedTools !== undefined && !validIds(value.allowedTools)) throw new Error('授权工具范围无效');
  // Older signed grants used null for all matters. An explicit empty list grants none.
  const allowedMatters = value.allowedMatters == null ? undefined
    : Object.fromEntries(Object.entries(value.allowedMatters).filter(([, ids]) => ids !== null));
  return { ...value, allowedMatters } as unknown as LicenseGrant;
}

export function verifySignedLicense(envelope: SignedLicenseEnvelope, publicKeyPem: string, options: { allowExpiredForRefresh?: boolean } = {}): LicenseGrant {
  if (!envelope || envelope.algorithm !== 'RSA-SHA256') throw new Error('不支持的授权签名算法');
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string' || envelope.payload.length > 32_768) {
    throw new Error('授权封装格式无效');
  }
  const valid = verify(
    'RSA-SHA256',
    Buffer.from(envelope.payload, 'base64url'),
    createPublicKey(publicKeyPem),
    Buffer.from(envelope.signature, 'base64url'),
  );
  if (!valid) throw new Error('授权签名无效');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('授权内容无法解析');
  }
  const grant = parseGrant(decoded);
  if (grant.notBefore && Date.now() < grant.notBefore) throw new Error('授权尚未生效');
  if (!options.allowExpiredForRefresh && Date.now() >= grant.expiresAt) throw new Error('授权已过期');
  // The signed legacy permission covered the former combined government module.
  // Expand only after signature verification, including already-issued offline keys.
  const legacy = grant.allowedMatters?.['government-info'];
  if (legacy?.includes('double-publicity-return')) return { ...grant, allowedMatters: {
    ...grant.allowedMatters,
    'government-info': [...new Set([...legacy.filter((id) => id !== 'double-publicity-return'), ...governmentMatters.map((matter) => matter.id)])],
  } };
  return grant;
}
