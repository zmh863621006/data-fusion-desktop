import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));
import { AppRuntime } from './runtime';
import type { LicenseGrant } from '../core/license/types';
import tools from '../core/tools/catalog.json';

const grant = (systems: string[], allowedTools: string[] = []): LicenseGrant => ({
  licenseId: 'catalog-fixture', expiresAt: Date.now() + 60_000, allowedSystems: systems, allowedTools,
});
afterEach(() => vi.restoreAllMocks());
describe('licensed component discovery', () => {
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
