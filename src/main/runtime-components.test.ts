import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));
import { AppRuntime } from './runtime';
import type { LicenseGrant } from '../core/license/types';
import tools from '../core/tools/catalog.json';
import { catalogOnlySystems, createCatalogOnlySystem } from '../plugins/catalog-only-systems';
import { createShenzhenIntegratedPlugin } from '../plugins/shenzhen-integrated-services';
import { createHousingRentalPlugin } from '../plugins/shenzhen-housing-rental';
import { createOneWindowPlugin } from '../plugins/shenzhen-one-window';
import { shortSystemName } from '../renderer/src/ui-format';

const grant = (systems: string[], allowedTools: string[] = []): LicenseGrant => ({
  licenseId: 'catalog-fixture', expiresAt: Date.now() + 60_000, allowedSystems: systems, allowedTools,
});
afterEach(() => vi.restoreAllMocks());
describe('licensed component discovery', () => {
  it('uses the client names consistently for source plugins, component cards, module lists and navigation', async () => {
    const runtime = new AppRuntime();
    const plugins = [createHousingRentalPlugin(), createOneWindowPlugin()];
    for (const plugin of plugins) runtime.plugins.register(plugin);
    vi.spyOn(runtime, 'currentGrant').mockResolvedValue(grant(plugins.map(plugin => plugin.id)));
    const names = ['深圳市房屋租赁', '深圳市一窗综合'];
    expect(plugins.map(plugin => plugin.name)).toEqual(names);
    expect((await runtime.listComponents()).map(item => item.name)).toEqual(names);
    expect((await runtime.listSystemModules()).map(item => item.name)).toEqual(names);
    expect(plugins.map(plugin => shortSystemName(plugin.id, plugin.name))).toEqual(names);
  });
  it('returns systems and tools in one snapshot with their maintained versions and descriptions', async () => {
    const runtime = new AppRuntime();
    vi.spyOn(runtime, 'currentGrant').mockResolvedValue(grant(['government-info'], ['health-publicity']));
    const result = await runtime.listComponents();
    expect(result.map(item => [item.id, item.kind])).toEqual([['government-info','system'],['health-publicity','tool']]);
    expect(result[1]).toMatchObject({ ...tools[0], authorized: true, kind: 'tool' });
    expect(result.every(item => /^\d+\.\d+\.\d+$/.test(item.version) && Boolean(item.description))).toBe(true);
  });
  it('discovers a tool-only grant without exposing or implicitly granting any business system', async () => {
    const runtime = new AppRuntime();
    vi.spyOn(runtime, 'currentGrant').mockResolvedValue(grant([], ['health-publicity','unknown-tool']));
    expect((await runtime.listComponents()).map(item => item.id)).toEqual(['health-publicity']);
    await expect(runtime.requireLicense('government-info')).rejects.toThrow();
  });
  it('never infers a tool grant from a system grant', async () => {
    const runtime = new AppRuntime();
    vi.spyOn(runtime, 'currentGrant').mockResolvedValue(grant(['government-info']));
    expect((await runtime.listComponents()).map(item => item.kind)).toEqual(['system']);
    await expect(runtime.healthTool()).rejects.toThrow('LICENSE_TOOL_DENIED');
  });
  it('lists each new portal as a standalone component only when it is granted', async () => {
    const runtime = new AppRuntime();
    for (const system of catalogOnlySystems) runtime.plugins.register(createCatalogOnlySystem(system));
    const [population] = catalogOnlySystems;
    const shenzhen = createShenzhenIntegratedPlugin();
    runtime.plugins.register(shenzhen);
    vi.spyOn(runtime, 'currentGrant').mockResolvedValueOnce(grant([population.id])).mockResolvedValueOnce(grant([shenzhen.id]));
    expect(await runtime.listComponents()).toMatchObject([{ id: population.id, name: population.name, workspaceMode: 'list-ledger' }]);
    expect(await runtime.listComponents()).toMatchObject([{ id: shenzhen.id, name: shenzhen.name, workspaceMode: 'list-ledger' }]);
  });
  it.each([null, { ...grant(['government-info'], ['health-publicity']), expiresAt: 0 }])('hides every component for absent or expired credentials', async value => {
    const runtime = new AppRuntime();vi.spyOn(runtime, 'currentGrant').mockResolvedValue(value);
    expect(await runtime.listComponents()).toEqual([]);
  });
  it('loads metadata without waiting for any remote authentication probe', async () => {
    const runtime = new AppRuntime(), probe = vi.fn(() => new Promise<never>(() => {}));
    runtime.plugins.register({ id:'government-info', name:'Fixture', version:'1.0.0', workspaceMode:'return-ledger',
      supportsCredentialConfiguration:true, loginMode:'automatic', getSessionState:probe, initialize:async()=>{}, matters:[],
      auth:{getState:probe,login:probe,logout:async()=>{},getSessionForRequest:probe} });
    vi.spyOn(runtime,'currentGrant').mockResolvedValue(grant(['government-info'],['health-publicity']));
    expect(await runtime.listComponents()).toHaveLength(2);expect(probe).not.toHaveBeenCalled();
  });
  it('re-evaluates both scopes on every request after authorization changes', async () => {
    const runtime=new AppRuntime();vi.spyOn(runtime,'currentGrant').mockResolvedValueOnce(grant(['government-info']))
      .mockResolvedValueOnce(grant([],['health-publicity'])).mockResolvedValueOnce(null);
    expect((await runtime.listComponents()).map(item=>item.kind)).toEqual(['system']);
    expect((await runtime.listComponents()).map(item=>item.kind)).toEqual(['tool']);expect(await runtime.listComponents()).toEqual([]);
  });
});
