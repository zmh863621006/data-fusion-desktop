import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusinessSystemPlugin } from '../core/plugins/types';

const fixtures = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<unknown>>(),
  plugins: new Map<string, BusinessSystemPlugin>(),
  requireLicense: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: class {}, session: {},
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => fixtures.handlers.set(channel, handler) },
}));
vi.mock('./runtime', () => ({ appRuntime: {
  plugins: { get: (id: string) => fixtures.plugins.get(id) }, requireLicense: fixtures.requireLicense,
} }));
import { registerIpcHandlers } from './ipc';
import { IPC_CHANNELS } from '../core/ipc/channels';
import { governmentInfoPlugin } from '../plugins/government-info';
import { marketAccessPlugin } from '../plugins/market-access';
import { transportPractitionerPlugin } from '../plugins/transport-practitioner';
import { oversizeTransportPlugin } from '../plugins/oversize-transport';
import { onlineCarPermitPlugin } from '../plugins/online-car-permit';

const plugins = [governmentInfoPlugin, marketAccessPlugin, transportPractitionerPlugin, oversizeTransportPlugin, onlineCarPermitPlugin];
const frame = {};
const trustedEvent = { sender: { id: 7, mainFrame: frame }, senderFrame: frame };
const list = (id: string, event = trustedEvent) => fixtures.handlers.get(IPC_CHANNELS.mattersList)!(event, id) as Promise<Array<Record<string, unknown>>>;

describe('matter menu IPC serialization boundary', () => {
  beforeEach(() => {
    fixtures.handlers.clear(); fixtures.plugins.clear(); fixtures.requireLicense.mockReset();
    plugins.forEach((plugin) => fixtures.plugins.set(plugin.id, plugin));
    fixtures.requireLicense.mockResolvedValue({ allowedSystems: plugins.map((plugin) => plugin.id) });
    registerIpcHandlers(() => 7);
  });

  it.each(plugins)('returns a cloneable menu for $id with the real plugin definitions', async (plugin) => {
    const payload = await list(plugin.id);
    expect(payload).toHaveLength(plugin.matters.length);
    expect(() => structuredClone(payload)).not.toThrow();
    expect(JSON.parse(JSON.stringify(payload)).map((matter: { id: string }) => matter.id)).toEqual(plugin.matters.map((matter) => matter.id));
    for (const matter of payload) {
      for (const key of ['query', 'getDetail', 'createDefaultContext', 'mergeRecord']) expect(matter).not.toHaveProperty(key);
    }
  });

  it('retains all 18 government matters, department groups and default filters', async () => {
    const payload = await list('government-info');
    expect(payload).toHaveLength(18);
    expect(['水务局', '城管局', '其他'].map((name) => payload.filter((matter) => matter.departmentName === name).length)).toEqual([8, 2, 8]);
    expect(payload[0]).toMatchObject({ defaultFilters: expect.objectContaining({ startDate: expect.any(String), endDate: expect.any(String) }),
      uniqueKey: ['cityLsh'], executionMode: 'one-click-return' });
    expect(governmentInfoPlugin.matters.filter((matter) => matter.mergeRecord)).toHaveLength(5);
    for (const matter of payload) expect(matter.querySchema).toEqual([
      { key: 'startDate', label: '办结开始日期', type: 'date', required: true },
      { key: 'endDate', label: '办结截止日期', type: 'date', required: true },
    ]);
  });

  it('does not leak any future main-process implementation properties into menu metadata', async () => {
    fixtures.plugins.set('government-info', { ...governmentInfoPlugin, matters: [
      { ...governmentInfoPlugin.matters[0], privateHelper: () => 'main-only' } as typeof governmentInfoPlugin.matters[number],
    ] });
    const payload = await list('government-info');
    expect(payload[0]).not.toHaveProperty('privateHelper');
    expect(() => structuredClone(payload)).not.toThrow();
  });

  it('preserves license filtering', async () => {
    const allowed = 'precursor-chemicals-filing-cancellation';
    fixtures.requireLicense.mockResolvedValue({ allowedMatters: { 'government-info': [allowed] } });
    expect((await list('government-info')).map((matter) => matter.id)).toEqual([allowed]);
  });

  it('continues to reject untrusted page requests', async () => {
    await expect(list('government-info', { ...trustedEvent, senderFrame: {} })).rejects.toThrow('非受信');
    expect(fixtures.requireLicense).not.toHaveBeenCalled();
  });

  it('passes manual force detection to the plugin and rejects invalid force arguments', async () => {
    const getSessionState = vi.fn(async () => ({ status: 'authenticated' as const, systemId: 'market-access' }));
    fixtures.plugins.set('market-access', { ...marketAccessPlugin, getSessionState });
    const handler = fixtures.handlers.get(IPC_CHANNELS.systemSession)!;
    await handler(trustedEvent, 'market-access', true);
    expect(getSessionState).toHaveBeenCalledExactlyOnceWith({ force: true });
    await expect(handler(trustedEvent, 'market-access', 'true')).rejects.toThrow('参数无效');
  });
});
