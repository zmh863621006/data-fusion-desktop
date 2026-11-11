import type { LicenseGrant } from './types';

export function assertToolLicensed(grant: LicenseGrant | null, toolId: string): void {
  if (!grant) throw new Error('LICENSE_REQUIRED: 请先激活软件');
  if (Date.now() >= grant.expiresAt) throw new Error('LICENSE_EXPIRED: 授权已过期');
  if (!grant.allowedTools?.includes(toolId)) throw new Error('LICENSE_TOOL_DENIED: 当前授权不包含该工具，请联系管理员单独授权');
}

export function assertSystemLicensed(grant: LicenseGrant | null, systemId: string, matterId?: string): void {
  if (!grant) throw new Error('LICENSE_REQUIRED: 请先激活软件');
  if (Date.now() >= grant.expiresAt) throw new Error('LICENSE_EXPIRED: 授权已过期');
  if (!grant.allowedSystems.includes(systemId)) throw new Error('LICENSE_SYSTEM_DENIED: 当前授权不包含该业务系统');
  const matters = grant.allowedMatters?.[systemId];
  if (matterId && matters && !matters.includes(matterId)) {
    throw new Error('LICENSE_MATTER_DENIED: 当前授权不包含该业务事项');
  }
}

export function assertFeatureLicensed(grant: LicenseGrant | null, feature: 'export' | 'auto-sync'): void {
  if (!grant) throw new Error('LICENSE_REQUIRED: 请先激活软件');
  if (feature === 'export' && !grant.allowExport) throw new Error('LICENSE_FEATURE_DENIED: 当前授权不包含导出功能');
  if (feature === 'auto-sync' && !grant.allowAutoSync) throw new Error('LICENSE_FEATURE_DENIED: 当前授权不包含自动同步功能');
}
