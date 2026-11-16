import { describe, expect, it } from 'vitest';
import type { LicenseStatus } from '../../core/license/types';
import { workspaceAccess } from './workspace-access';

const now = Date.now();
const status = (systems: string[], tools: string[] = []): LicenseStatus => ({ state: 'active', deviceId: 'test-device',
  grant: { licenseId: 'test-license', expiresAt: now + 60_000, allowedSystems: systems, allowedTools: tools } });

describe('licensed desktop navigation', () => {
  it('ties publication tabs to the government grant without adding business-system entitlements', () => {
    const access = workspaceAccess(status(['government-info']), now);
    expect(access.canOpenSourceTab('nanshan-publicity')).toBe(true);
    expect(access.canOpenSourceTab('guangdong-law-publicity')).toBe(true);
    expect(access.canOpenSystem('nanshan-publicity')).toBe(false);
    expect(access.canOpenSourceTab('market-access')).toBe(false);
    expect(workspaceAccess(status(['market-access']), now).canOpenSourceTab('nanshan-publicity')).toBe(false);
    expect(workspaceAccess(status([], ['health-publicity']), now).canOpenSourceTab('guangdong-law-publicity')).toBe(false);
    expect(workspaceAccess(status(['government-info']), now + 60_000).canOpenSourceTab('nanshan-publicity')).toBe(false);
  });
  it('shows only the signed system and matter scope', () => {
    const license = status(['government-info']);
    license.grant!.allowedMatters = { 'government-info': ['water'] };
    const access = workspaceAccess(license, now);
    expect(access.defaultPage).toBe('home');
    expect(access.canOpenSystem('government-info')).toBe(true);
    expect(access.canOpenSystem('market-access')).toBe(false);
    expect(access.canOpenMatter('government-info', 'water')).toBe(true);
    expect(access.canOpenMatter('government-info', 'city')).toBe(false);
    expect(access.resolvePage('tools')).toBe('home');
  });
  it('allows hazardous-chemicals publication tabs only with that source grant', () => {
    const hazardous = workspaceAccess(status(['shenzhen-hazardous-chemicals']), now);
    expect(hazardous.canOpenSourceTab('hazchem-nanshan-publicity')).toBe(true);
    expect(hazardous.canOpenSourceTab('hazchem-guangdong-law-publicity')).toBe(true);
    expect(hazardous.canOpenSourceTab('nanshan-publicity')).toBe(false);
    expect(workspaceAccess(status(['government-info']), now).canOpenSourceTab('hazchem-nanshan-publicity')).toBe(false);
    expect(workspaceAccess(status(['market-access']), now).canOpenSourceTab('hazchem-guangdong-law-publicity')).toBe(false);
  });
  it('opens the tool directly without business navigation', () => {
    const access = workspaceAccess(status([], ['health-publicity']), now);
    expect(access.defaultPage).toBe('tools');
    expect(access.hasSystems).toBe(false);
    expect(access.canOpenPage('home')).toBe(false);
    expect(access.canOpenPage('workspace')).toBe(false);
    expect(access.canOpenPage('systems')).toBe(true);
    expect(access.resolvePage('workspace')).toBe('tools');
  });
  it('leaves only settings and hidden support when no installed feature is licensed', () => {
    const access = workspaceAccess(status([], ['unknown-future-tool']), now);
    expect(access.defaultPage).toBe('settings');
    expect(access.canOpenPage('systems')).toBe(false);
    expect(access.canOpenPage('tools')).toBe(false);
    expect(access.canOpenPage('diagnostics')).toBe(true);
  });
  it.each(['missing', 'expired', 'invalid'] as const)('does not trust a stale grant in %s state', state => {
    const access = workspaceAccess({ ...status(['market-access'], ['health-publicity']), state }, now);
    expect(access.hasSystems).toBe(false);
    expect(access.hasHealthTool).toBe(false);
  });
  it('hides an expired active grant and switches away from a revoked current page', () => {
    expect(workspaceAccess(status(['market-access']), now + 60_000).hasSystems).toBe(false);
    expect(workspaceAccess(status([], ['health-publicity']), now).resolvePage('home')).toBe('tools');
    expect(workspaceAccess(status([]), now).resolvePage('tools')).toBe('settings');
  });
  it('does not reset the current workspace when a renewal changes dates but not feature scope', () => {
    const license = status(['market-access']);
    const original = workspaceAccess(license, now).permissionKey;
    const renewed = { ...license, grant: { ...license.grant!, expiresAt: now + 120_000, issuedAt: now, customerName: 'Renewed customer' } };
    expect(workspaceAccess(renewed, now).permissionKey).toBe(original);
    expect(workspaceAccess(status([], ['health-publicity']), now).permissionKey).not.toBe(original);
  });
});
