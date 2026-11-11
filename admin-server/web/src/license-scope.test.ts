import { describe, expect, it } from 'vitest';
import { legacyScopeSystems, licenseScopeSnapshot, scopeEditorValues, scopeMatterCatalog, scopeUpdatePayload } from './license-scope';
import type { LicenseRecord, MatterRecord, SystemRecord } from './types';

const license: LicenseRecord = {
  id: 'license-a', customer_id: 'customer-a', customer_name: '测试客户', mode: 'online', expires_at: 1000,
  allowed_systems_json: '["system-a"]', allowed_tools_json: '["tool-a"]', allowed_matters_json: '{"system-a":["matter-a"]}',
  max_devices: 2, allow_export: 1, allow_auto_sync: 0, allow_auto_update: 1, status: 'active', created_at: 1,
};
const systems: SystemRecord[] = [
  { id: 'system-a', name: '系统 A', enabled: 1, version: '1', created_at: 1 },
  { id: 'system-b', name: '系统 B', enabled: 1, version: '1', created_at: 1 },
];
const matters: MatterRecord[] = [
  { id: 'matter-a', system_id: 'system-a', name: '事项 A', enabled: 1, created_at: 1 },
  { id: 'matter-disabled', system_id: 'system-a', name: '停用事项', enabled: 0, created_at: 1 },
  { id: 'matter-b', system_id: 'system-b', name: '事项 B', enabled: 1, created_at: 1 },
];

describe('license scope editor', () => {
  it('preserves the opened scope separately from editable values', () => {
    const snapshot = licenseScopeSnapshot(license);
    const values = scopeEditorValues(snapshot, matters);
    values.allowedSystems.push('system-b');
    values.allowedMatters['system-a'].push('matter-disabled');
    expect(snapshot).toEqual({ allowedSystems: ['system-a'], allowedTools: ['tool-a'], allowedMatters: { 'system-a': ['matter-a'] } });
    expect(values.allowedMatters['system-b']).toBeUndefined();
  });

  it('expands legacy missing and null maps to current catalog only, including disabled matters', () => {
    for (const raw of [undefined, 'null', '{}', '{"system-a":null}']) {
      const snapshot = licenseScopeSnapshot({ ...license, allowed_matters_json: raw });
      expect(legacyScopeSystems(snapshot)).toEqual(['system-a']);
      const values = scopeEditorValues(snapshot, matters);
      expect(values.allowedMatters).toEqual({ 'system-a': ['matter-a', 'matter-disabled'] });
      expect(scopeUpdatePayload(values, snapshot).expectedScope.allowedMatters).toEqual(raw === undefined || raw === 'null' ? null : {});
    }
  });

  it('does not mistake an explicit empty matter array for all matters', () => {
    const snapshot = licenseScopeSnapshot({ ...license, allowed_matters_json: '{"system-a":[]}' });
    expect(legacyScopeSystems(snapshot)).toEqual([]);
    expect(scopeEditorValues(snapshot, matters).allowedMatters).toEqual({ 'system-a': [] });
  });

  it('normalizes null system/tool arrays without inventing access', () => {
    const snapshot = licenseScopeSnapshot({ ...license, allowed_systems_json: 'null', allowed_tools_json: 'null' });
    expect(snapshot.allowedSystems).toEqual([]);
    expect(snapshot.allowedTools).toEqual([]);
  });

  it('refuses malformed historical scopes rather than silently expanding access', () => {
    for (const patch of [
      { allowed_systems_json: '{"bad":true}' }, { allowed_tools_json: '[1]' },
      { allowed_matters_json: '[]' }, { allowed_matters_json: '{"system-a":"all"}' },
      { allowed_matters_json: '{"system-a":[1]}' }, { allowed_matters_json: 'invalid-json' },
    ]) expect(() => licenseScopeSnapshot({ ...license, ...patch })).toThrow('现有授权数据异常');
  });

  it('drops removed systems and never auto-selects matters for a newly selected system', () => {
    const expectedScope = licenseScopeSnapshot(license);
    const values = { allowedSystems: ['system-b', 'system-b'], allowedTools: ['tool-a'], allowedMatters: { 'system-a': ['matter-a'] } };
    const payload = scopeUpdatePayload(values, expectedScope);
    expect(payload).toEqual({ allowedSystems: ['system-b'], allowedTools: ['tool-a'], allowedMatters: { 'system-b': [] }, expectedScope });
    expect(Object.keys(payload)).toEqual(['allowedSystems', 'allowedTools', 'allowedMatters', 'expectedScope']);
  });

  it('supports a tool-only scope without stale business matter keys', () => {
    const expectedScope = licenseScopeSnapshot(license);
    const payload = scopeUpdatePayload({ allowedSystems: [], allowedTools: ['tool-a'], allowedMatters: { 'system-a': ['matter-a'] } }, expectedScope);
    expect(payload.allowedSystems).toEqual([]);
    expect(payload.allowedTools).toEqual(['tool-a']);
    expect(payload.allowedMatters).toEqual({});
  });

  it('retains already granted disabled or unknown matters and never adds disabled choices', () => {
    const snapshot = licenseScopeSnapshot({ ...license, allowed_matters_json: '{"system-a":["matter-a","matter-disabled","matter-removed"]}' });
    const values = scopeEditorValues(snapshot, matters);
    expect(values.allowedMatters['system-a']).toEqual(['matter-a', 'matter-disabled', 'matter-removed']);
    expect(scopeMatterCatalog('system-a', values, { systems, matters }).map(item => item.id)).toEqual(['matter-a', 'matter-disabled']);
    const narrow = scopeEditorValues(licenseScopeSnapshot(license), matters);
    expect(scopeMatterCatalog('system-a', narrow, { systems, matters }).map(item => item.id)).toEqual(['matter-a']);
  });

  it('does not offer new matters within a disabled or removed system', () => {
    const values = scopeEditorValues(licenseScopeSnapshot({ ...license, allowed_matters_json: '{"system-a":["matter-disabled"]}' }), matters);
    const disabledSystems = systems.map(item => ({ ...item, enabled: 0 }));
    expect(scopeMatterCatalog('system-a', values, { systems: disabledSystems, matters }).map(item => item.id)).toEqual(['matter-disabled']);
    expect(scopeMatterCatalog('system-a', values, { systems: [], matters }).map(item => item.id)).toEqual(['matter-disabled']);
  });
});
