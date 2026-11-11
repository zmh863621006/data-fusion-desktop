import { describe, expect, it } from 'vitest';
import { backendConfiguration, CLOUD_BACKEND_ORIGIN } from './backend';
import { assertSystemLicensed, assertToolLicensed } from '../license/gate';
describe('cloud backend and independently licensed tools', () => {
  it('defaults every desktop service to HTTPS without silently permitting HTTP', () => {
    const value = backendConfiguration();
    expect(value.activationUrl).toBe(`${CLOUD_BACKEND_ORIGIN}/api/activate`);
    expect(value.statusUrl).toBe(`${CLOUD_BACKEND_ORIGIN}/api/license/status`);
    expect(value.enterpriseUrl).toBe(`${CLOUD_BACKEND_ORIGIN}/api/enterprises/resolve`);
    expect(value.updateUrl).toBe('https://193.112.96.168/api/updates/manifest');
    expect(CLOUD_BACKEND_ORIGIN).toBe('https://193.112.96.168');
    expect(value.insecureHttpOrigin).toBeUndefined();
    expect(backendConfiguration({ DATA_FUSION_ALLOW_INSECURE_HTTP_ORIGIN: 'http://193.112.96.168:9087' }).insecureHttpOrigin).toBe('http://193.112.96.168:9087');
    expect(backendConfiguration({ DATA_FUSION_ACTIVATION_URL: 'https://custom.invalid/api/activate' }).activationUrl).toBe('https://custom.invalid/api/activate');
  });
  it('allows a tools-only license without granting any business system access', () => {
    const grant = { licenseId: 'tool-only', allowedSystems: [], allowedTools: ['health-publicity'], expiresAt: Date.now() + 60000 };
    expect(() => assertToolLicensed(grant, 'health-publicity')).not.toThrow();
    expect(() => assertSystemLicensed(grant, 'government-info')).toThrow('LICENSE_SYSTEM_DENIED');
    expect(() => assertToolLicensed({ ...grant, allowedTools: [] }, 'health-publicity')).toThrow('LICENSE_TOOL_DENIED');
    expect(() => assertToolLicensed({ ...grant, expiresAt: 1 }, 'health-publicity')).toThrow('LICENSE_EXPIRED');
  });
});
