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
export const emptyScope: LicenseScopeValues = { allowedSystems: [], allowedTools: [], allowedMatters: {} };

export function scopeValidationError(value: LicenseScopeValues, matters: BootstrapData['matters']) {
  if (!value.allowedSystems.length && !value.allowedTools.length) return '请至少选择一个业务系统或工具';
  if (value.allowedSystems.some(id => !value.allowedMatters[id]?.length && matters.some(m => m.system_id === id))) {
    return '请为已选系统选择至少一个业务事项，或取消该系统';
  }
  return '';
}

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

export type ScopeItem = { systemId: string; matterId?: string; name: string; department: string; available: boolean };

export function scopeDirectory(data: Pick<BootstrapData, 'systems' | 'matters'>, initial = emptyScope) {
  const systems = new Map(data.systems.filter(s => s.enabled || initial.allowedSystems.includes(s.id)).map(s => [s.id, s]));
  return [...new Set([...systems.keys(), ...initial.allowedSystems])].map(systemId => {
    const system = systems.get(systemId);
    const enabled = Boolean(system?.enabled);
    const catalog = scopeMatterCatalog(systemId, initial, data);
    const items: ScopeItem[] = catalog.map(m => ({
      systemId, matterId: m.id, name: m.name, department: m.department_name || '业务事项', available: enabled && Boolean(m.enabled),
    }));
    for (const id of initial.allowedMatters[systemId] ?? []) {
      if (!catalog.some(m => m.id === id)) items.push({ systemId, matterId: id, name: id, department: '已下线事项', available: false });
    }
    if (items.length && initial.allowedSystems.includes(systemId) && !initial.allowedMatters[systemId]?.length) {
      items.push({ systemId, name: '历史系统授权（无已选事项）', department: '历史授权', available: false });
    } else if (!items.length) {
      const noCatalog = !data.matters.some(m => m.system_id === systemId);
      items.push({ systemId, name: system?.name ?? systemId, department: '', available: enabled && noCatalog });
    }
    return { id: systemId, name: system?.name ?? systemId, enabled, items };
  });
}

export function filterScopeDirectory(directory: ReturnType<typeof scopeDirectory>, search: string) {
  const query = search.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(query);
  return directory.map(system => matches(system.name) || matches(system.id) ? system : {
    ...system, items: system.items.filter(item => [item.name, item.department, item.matterId ?? ''].some(matches)),
  }).filter(system => system.items.length);
}

export function scopeItemSelected(value: LicenseScopeValues, item: ScopeItem) {
  return item.matterId === undefined ? value.allowedSystems.includes(item.systemId) && !value.allowedMatters[item.systemId]?.length : Boolean(value.allowedMatters[item.systemId]?.includes(item.matterId));
}

/** Only touch explicitly visible entries. Retired entries can be removed but never granted. */
export function selectScopeItems(value: LicenseScopeValues, items: ScopeItem[], select: boolean): LicenseScopeValues {
  const systems = new Set(value.allowedSystems);
  const allowedMatters = { ...value.allowedMatters };
  for (const item of items) {
    if (select ? !item.available : !scopeItemSelected(value, item)) continue;
    const ids = new Set(allowedMatters[item.systemId] ?? []);
    if (item.matterId !== undefined) {
      if (select) ids.add(item.matterId);
      else ids.delete(item.matterId);
    }
    if (select || ids.size) {
      systems.add(item.systemId);
      allowedMatters[item.systemId] = [...ids];
    } else {
      systems.delete(item.systemId);
      delete allowedMatters[item.systemId];
    }
  }
  return { ...value, allowedSystems: [...systems], allowedMatters };
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
