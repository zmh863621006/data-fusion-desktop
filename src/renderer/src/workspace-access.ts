import type { LicenseStatus } from '../../core/license/types';
import { sourceTabOwner } from '../../core/publication/platforms';

export type AppPage = 'home' | 'workspace' | 'systems' | 'settings' | 'diagnostics' | 'tools';

// Presentation only. The main process remains responsible for enforcing every
// license check; this also hides stale UI immediately when a grant is reduced.
export function workspaceAccess(license: LicenseStatus, now = Date.now()) {
  const grant = license.state === 'active' && license.grant && license.grant.expiresAt > now ? license.grant : undefined;
  const systems = new Set(grant?.allowedSystems ?? []);
  const hasSystems = systems.size > 0;
  const hasHealthTool = Boolean(grant?.allowedTools?.includes('health-publicity'));
  const defaultPage: AppPage = hasSystems ? 'home' : hasHealthTool ? 'tools' : 'settings';
  const canOpenSystem = (id: string) => systems.has(id);
  const canOpenSourceTab = (id: string) => canOpenSystem(sourceTabOwner(id));
  const canOpenTool = (id: string) => Boolean(grant?.allowedTools?.includes(id));
  const canOpenMatter = (systemId: string, matterId: string) => canOpenSystem(systemId)
    && (!grant?.allowedMatters?.[systemId] || grant.allowedMatters[systemId].includes(matterId));
  const canOpenPage = (page: AppPage) => page === 'home' || page === 'workspace' ? hasSystems
    : page === 'tools' ? hasHealthTool : page === 'systems' ? hasSystems || hasHealthTool : true;
  const permissionKey = JSON.stringify([Boolean(grant), grant?.allowedSystems ?? [], grant?.allowedTools ?? [], grant?.allowedMatters ?? {}]);
  return { hasSystems, hasHealthTool, defaultPage, canOpenSystem, canOpenSourceTab, canOpenTool, canOpenMatter, canOpenPage, permissionKey,
    resolvePage: (page: AppPage) => canOpenPage(page) ? page : defaultPage };
}
