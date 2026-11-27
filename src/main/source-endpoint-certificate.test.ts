import { describe, expect, it } from 'vitest';
import { approvedSourceEndpointCertificate as approved } from './source-endpoint-certificate';
import { REVIEWED_CERTIFICATE, DIFFERENT_CERTIFICATE } from './source-endpoint-certificate.test-fixture';

const system = 'shenzhen-integrated-services';
const page = { partition: 'persist:' + system, allowedOrigin: 'https://61.144.226.148:8001' };
const url = page.allowedOrigin + '/cas/login';
const error = 'ERR_CERT_COMMON_NAME_INVALID';
const now = Date.parse('2026-11-27T00:00:00Z');

describe('reviewed source endpoint certificate', () => {
  it('accepts only the reviewed public certificate during its validity for the configured IP login', () => {
    for (const value of [error, 'net::' + error]) expect(approved(system, page, url, value, REVIEWED_CERTIFICATE, now)).toBe(true);
    expect(approved(system, page, page.allowedOrigin + '/TRANS/zhsl/home', error, REVIEWED_CERTIFICATE, now)).toBe(true);
  });

  it.each([
    'https://61.144.226.148/cas/login', 'https://61.144.226.148:8002/cas/login',
    'http://61.144.226.148:8001/cas/login', 'https://61.144.226.149:8001/cas/login',
    'https://61.144.226.148.evil.test:8001/cas/login', 'https://user:password@61.144.226.148:8001/cas/login',
    'file:///cas/login', 'invalid-url',
  ])('keeps other ports, hosts, schemes and malformed targets rejected: %s', target => {
    expect(approved(system, page, target, error, REVIEWED_CERTIFICATE, now)).toBe(false);
  });

  it('does not extend trust to other systems, browser partitions or configured origins', () => {
    expect(approved('government-info', page, url, error, REVIEWED_CERTIFICATE, now)).toBe(false);
    expect(approved(system, { ...page, partition: 'persist:other' }, url, error, REVIEWED_CERTIFICATE, now)).toBe(false);
    expect(approved(system, { ...page, allowedOrigin: 'https://other.test' }, url, error, REVIEWED_CERTIFICATE, now)).toBe(false);
  });

  it.each(['ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_REVOKED', 'ERR_CERT_INVALID', 'ERR_SSL_PROTOCOL_ERROR', 'OK'])(
    'does not approve unrelated TLS failures: %s', value => expect(approved(system, page, url, value, REVIEWED_CERTIFICATE, now)).toBe(false),
  );

  it('rejects a changed or malformed certificate and never trusts a display-name claim', () => {
    for (const value of [DIFFERENT_CERTIFICATE, 'CN=*.sz.gov.cn', '', 'malformed']) {
      expect(approved(system, page, url, error, value, now)).toBe(false);
    }
  });

  it.each([Date.parse('2025-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z'), NaN])(
    'does not accept a certificate outside its validity or with an invalid clock', clock => {
      expect(approved(system, page, url, error, REVIEWED_CERTIFICATE, clock)).toBe(false);
    },
  );
});
