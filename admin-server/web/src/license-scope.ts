import type { BootstrapData, LicenseRecord } from './types';

export type LicenseScopeSnapshot = {
  allowedSystems: string[];
  allowedTools: string[];
  allowedMatters: Record<string, string[]> | null;
};
export type LicenseScopeValues = {
  allowedSystems: string[];
  allowedTools: string[];
  allowedMatters: Record<string, string[]>;
};

function arrayValue(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('现有授权数据异常，请联系管理员核查后再调整');
  return [...new Set(value)];
}

/** Keep legacy missing/null matter maps distinct from explicit empty lists. */
export function licenseScopeSnapshot(license: LicenseRecord): LicenseScopeSnapshot {
  try {
    const systems = JSON.parse(license.allowed_systems_json ?? '[]') as unknown;
    const tools = JSON.parse(license.allowed_tools_json ?? '[]') as unknown;
    const matters = JSON.parse(license.allowed_matters_json ?? 'null') as unknown;
    if (matters !== null && (typeof matters !== 'object' || Array.isArray(matters))) throw new Error();
    return {
      allowedSystems: systems === null ? [] : arrayValue(systems),
      allowedTools: tools === null ? [] : arrayValue(tools),
      allowedMatters: matters === null ? null : Object.fromEntries(Object.entries(matters).filter(([, ids]) => ids !== null).map(([systemId, ids]) => [systemId, arrayValue(ids)])),
    };
  } catch { throw new Error('现有授权数据异常，请联系管理员核查后再调整'); }
}

export function legacyScopeSystems(scope: LicenseScopeSnapshot): string[] {
  return scope.allowedSystems.filter(id => !scope.allowedMatters || !Object.hasOwn(scope.allowedMatters, id));
}

export function scopeEditorValues(scope: LicenseScopeSnapshot, matters: BootstrapData['matters']): LicenseScopeValues {
  return {
    allowedSystems: [...scope.allowedSystems],
    allowedTools: [...scope.allowedTools],
    allowedMatters: Object.fromEntries(scope.allowedSystems.map(systemId => [systemId,
      scope.allowedMatters && Object.hasOwn(scope.allowedMatters, systemId)
        ? [...scope.allowedMatters[systemId]]
        : matters.filter(matter => matter.system_id === systemId).map(matter => matter.id),
    ])),
  };
}

export function scopeMatterCatalog(systemId: string, initial: LicenseScopeValues, data: Pick<BootstrapData, 'systems' | 'matters'>) {
  const initialIds = initial.allowedMatters[systemId] ?? [];
  const systemEnabled = Boolean(data.systems.find(system => system.id === systemId)?.enabled);
  return data.matters.filter(matter => matter.system_id === systemId && (initialIds.includes(matter.id) || (systemEnabled && matter.enabled)));
}

/** Drop stale form fields for removed systems; never grant unselected matters. */
export function scopeUpdatePayload(values: LicenseScopeValues, expectedScope: LicenseScopeSnapshot) {
  const allowedSystems = [...new Set(values.allowedSystems ?? [])];
  return {
    allowedSystems,
    allowedTools: [...new Set(values.allowedTools ?? [])],
    allowedMatters: Object.fromEntries(allowedSystems.map(systemId => [systemId, [...new Set(values.allowedMatters?.[systemId] ?? [])]])),
    expectedScope,
  };
}
