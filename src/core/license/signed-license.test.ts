import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignedLicense, type SignedLicenseEnvelope } from './signed-license';

function signedEnvelope(overrides: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const grant = {
    licenseId: 'license-1',
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    allowedSystems: ['demo-system'],
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
  const envelope: SignedLicenseEnvelope = {
    payload,
    signature: sign('RSA-SHA256', Buffer.from(payload, 'base64url'), privateKey).toString('base64url'),
    algorithm: 'RSA-SHA256',
  };
  return { envelope, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

describe('verifySignedLicense', () => {
  it('accepts a valid signed grant', () => {
    const { envelope, publicKey } = signedEnvelope();
    expect(verifySignedLicense(envelope, publicKey).licenseId).toBe('license-1');
  });

  it('rejects payload tampering', () => {
    const { envelope, publicKey } = signedEnvelope();
    envelope.payload = Buffer.from(JSON.stringify({ licenseId: 'stolen' })).toString('base64url');
    expect(() => verifySignedLicense(envelope, publicKey)).toThrow('授权签名无效');
  });

  it('rejects expired grants', () => {
    const { envelope, publicKey } = signedEnvelope({ expiresAt: Date.now() - 1 });
    expect(() => verifySignedLicense(envelope, publicKey)).toThrow('授权已过期');
  });
});
