import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignedLicense, type SignedLicenseEnvelope } from './signed-license';
import { assertSystemLicensed } from './gate';

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

  it.each([null, {}, { 'demo-system': null }])('restores an old all-matters grant and keeps the signed system boundary', allowedMatters => {
    const { envelope, publicKey } = signedEnvelope({ allowedMatters });
    const grant = verifySignedLicense(envelope, publicKey);
    expect(grant.allowedMatters?.['demo-system']).toBeUndefined();
    expect(() => assertSystemLicensed(grant, 'demo-system', 'existing-matter')).not.toThrow();
    expect(() => assertSystemLicensed(grant, 'other-system', 'existing-matter')).toThrow('LICENSE_SYSTEM_DENIED');
  });

  it('keeps an explicit empty list next to a legacy wildcard and rejects a malformed list', () => {
    const { envelope, publicKey } = signedEnvelope({ allowedSystems: ['demo-system', 'other-system'],
      allowedMatters: { 'demo-system': null, 'other-system': [] } });
    const grant = verifySignedLicense(envelope, publicKey);
    expect(() => assertSystemLicensed(grant, 'other-system', 'existing-matter')).toThrow('LICENSE_MATTER_DENIED');
    const malformed = signedEnvelope({ allowedMatters: { 'demo-system': [null] } });
    expect(() => verifySignedLicense(malformed.envelope, malformed.publicKey)).toThrow('授权事项范围无效');
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
