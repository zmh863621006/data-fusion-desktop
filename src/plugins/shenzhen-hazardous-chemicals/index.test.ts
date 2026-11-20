import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }));
import { validatePluginContract } from '../../core/plugins/types';
import { createShenzhenHazardousPlugin } from './index';
it('registers five grouped matters with optional explicit decision-date filters and portal session storage capture', () => {
  const p = createShenzhenHazardousPlugin(); expect(() => validatePluginContract(p)).not.toThrow(); expect(p.matters).toHaveLength(5);
  expect(p.name).toBe('危化品管理');
  expect(p.loginPage?.browserAuth?.sessionStorageKeys).toEqual(['Authorization', 'userId']); expect(p.loginPage?.url).toBe('https://szwh.yjgl.sz.gov.cn/iHome/#/login');
  expect(p.matters.every(m => m.uniqueKey.join() === 'sourceSerial')).toBe(true); expect(p.matters.every(m => !m.getDetail)).toBe(true);
});
it('detects portal login, validates it, and exposes only a session-status DTO', async () => {
  const p = createShenzhenHazardousPlugin({ minimumIntervalMs: 0, fetcher: async () => new Response(JSON.stringify({ SYS_HEAD: { RET_STATUS: 'S', RET: [{ RET_CODE: '000000' }] }, BODY: { status: 'success', data: [], total: 0 } })) });
  expect((await p.getSessionState()).status).toBe('logged-out'); p.loginPage!.browserAuth!.accept({ Authorization: 'fixture-secret', userId: 'fixture-user' });
  const state = await p.getSessionState(); expect(state.status).toBe('authenticated'); expect(JSON.stringify(state)).not.toContain('fixture-secret');
  expect(await p.auth.getSessionForRequest()).toEqual({ metadata: { auth: 'portal-session' } });
});
