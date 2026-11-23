import { expect, it, vi } from 'vitest';
import { validatePluginContract } from '../core/plugins/types';
import { validateFilters } from '../core/query/validation';
import { catalogOnlySystems, createCatalogOnlySystem } from './catalog-only-systems';

const { cookies, fromPartition } = vi.hoisted(() => {
  const cookies = vi.fn();
  return { cookies, fromPartition: vi.fn(() => ({ cookies: { get: cookies } })) };
});
vi.mock('electron', () => ({ session: { fromPartition } }));

it('opens each configured portal on its own origin and exposes 1 and 10 list matters', () => {
  const systems = catalogOnlySystems.map(createCatalogOnlySystem);
  expect(systems.map(plugin => [plugin.name, plugin.loginPage?.url, plugin.matters.length])).toEqual([
    ['广东全员人口统筹管理统一登录平台', 'http://19.16.44.169/login', 1],
    ['深圳市一体化经办平台', 'https://61.144.226.148:8001/TRANS/zhsl/home', 10],
  ]);
  expect(new Set(systems.map(plugin => plugin.loginPage?.partition)).size).toBe(2);
  for (const plugin of systems) {
    expect(() => validatePluginContract(plugin)).not.toThrow();
    expect(plugin.workspaceMode).toBe('list-ledger');
    for (const matter of plugin.matters) {
      expect(matter.querySchema.map(field => field.type)).toEqual(['date', 'date']);
      expect(() => validateFilters(matter.querySchema, matter.createDefaultContext!().filters)).not.toThrow();
    }
  }
});

it('reads only the portal partition and does not treat a cookie as verified login', async () => {
  const plugin = createCatalogOnlySystem(catalogOnlySystems[0]);
  cookies.mockResolvedValueOnce([]).mockResolvedValueOnce([{}]).mockRejectedValueOnce(new Error('unavailable'));
  expect((await plugin.getSessionState()).status).toBe('logged-out');
  expect((await plugin.getSessionState()).status).toBe('unverified');
  expect((await plugin.getSessionState()).status).toBe('unverified');
  expect(fromPartition).toHaveBeenCalledWith('persist:guangdong-population');
  expect(cookies.mock.calls).toEqual(Array(3).fill([{ url: 'http://19.16.44.169/login' }]));
  await expect(plugin.auth.getSessionForRequest()).rejects.toThrow('当前事项暂时无法回流');
});
