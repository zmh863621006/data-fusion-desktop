import type { LicenseGrant } from '../core/license/types';
import type { LocalRecordQuery } from '../core/storage/platform-store';
import { SHENZHEN_INSURANCE_MATTER, SHENZHEN_POST_MATTER, SHENZHEN_SYSTEM_ID, shenzhenRecordMatterId } from '../plugins/shenzhen-integrated-services/catalog';

const sharedMatter = (value: string | undefined) => value === SHENZHEN_POST_MATTER || value === SHENZHEN_INSURANCE_MATTER;

/** Resolve an explicitly selected alias before authorization, never from a renderer-provided storage id. */
export function localRecordQuerySystem(query: LocalRecordQuery): string | undefined {
  return query.systemId ?? (sharedMatter(query.matterId) ? SHENZHEN_SYSTEM_ID : undefined);
}

export function canonicalRecordQuery(query: LocalRecordQuery, grant: LicenseGrant): LocalRecordQuery {
  const systemId = localRecordQuerySystem(query);
  const matterId = systemId && query.matterId ? shenzhenRecordMatterId(systemId, query.matterId) : query.matterId;
  return {
    ...query,
    ...(systemId ? { systemId } : {}),
    ...(matterId ? { matterId } : {}),
    ...(Array.isArray(grant.allowedSystems) ? {
      accessScopes: grant.allowedSystems.map(id => ({ systemId: id,
        matterIds: grant.allowedMatters?.[id] ? [...new Set(grant.allowedMatters[id].map(matter => shenzhenRecordMatterId(id, matter)))] : undefined })),
    } : {}),
  };
}

/** The canonical row is projected into an actually licensed entry; the grant itself stays unchanged. */
export function visibleRecordMatter<T extends { systemId: string; matterId: string }>(row: T, query: LocalRecordQuery, grant: LicenseGrant): T {
  if (row.systemId !== SHENZHEN_SYSTEM_ID || row.matterId !== SHENZHEN_INSURANCE_MATTER) return row;
  if (!grant.allowedSystems?.includes(SHENZHEN_SYSTEM_ID)) throw new Error('LICENSE_SYSTEM_DENIED: 当前授权不包含该业务系统');
  const allowed = grant.allowedMatters?.[SHENZHEN_SYSTEM_ID];
  const requested = localRecordQuerySystem(query) === SHENZHEN_SYSTEM_ID && sharedMatter(query.matterId) ? query.matterId : undefined;
  const visible = requested && (!allowed || allowed.includes(requested)) ? requested
    : !allowed || allowed.includes(SHENZHEN_INSURANCE_MATTER) ? SHENZHEN_INSURANCE_MATTER
      : allowed.includes(SHENZHEN_POST_MATTER) ? SHENZHEN_POST_MATTER : undefined;
  if (!visible) throw new Error('LICENSE_MATTER_DENIED: 当前授权不包含该业务事项');
  return visible === row.matterId ? row : { ...row, matterId: visible };
}
