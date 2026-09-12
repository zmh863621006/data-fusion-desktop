import { createPublicKey, verify } from 'node:crypto';
import type { LicenseGrant } from './types';

export interface SignedLicenseEnvelope {
  payload: string;
  signature: string;
  algorithm: 'RSA-SHA256';
}

export function verifySignedLicense(envelope: SignedLicenseEnvelope, publicKeyPem: string): LicenseGrant {
  const valid = verify(
    'RSA-SHA256',
    Buffer.from(envelope.payload, 'base64url'),
    createPublicKey(publicKeyPem),
    Buffer.from(envelope.signature, 'base64url'),
  );
  if (!valid) throw new Error('授权签名无效');
  const grant = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8')) as LicenseGrant;
  if (!grant.licenseId || !grant.expiresAt || !Array.isArray(grant.allowedSystems)) throw new Error('授权内容无效');
  if (Date.now() >= grant.expiresAt) throw new Error('授权已过期');
  return grant;
}
