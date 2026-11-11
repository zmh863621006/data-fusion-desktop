import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));

import { AppRuntime } from './runtime';
import type { LicenseGrant } from '../core/license/types';

describe('authorized system module listing', () => {
  let runtime: AppRuntime;
  const now = new Date('2026-10-19T04:00:00Z');
  const grant = (allowedSystems: string[], patch: Partial<LicenseGrant> = {}): LicenseGrant => ({
    licenseId: 'module-list-fixture', expiresAt: now.getTime() + 60_000, allowedSystems, ...patch,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    runtime = new AppRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns no modules when no current license is available', async () => {
    expect(await runtime.listSystemModules()).toEqual([]);
  });

  it('only returns authorized systems and preserves the public module metadata', async () => {
    vi.spyOn(runtime, 'currentGrant').mockResolvedValue(grant(['government-info']));
    expect(await runtime.listSystemModules()).toEqual([{
      id: 'government-info', name: '政务综合信息平台', version: '1.0.0', publisher: '数据融合助手',
      description: '双公示审批数据回流', authorized: true,
    }]);
  });

  it('ignores unknown IDs and keeps built-in ordering without duplicate entries', async () => {
    vi.spyOn(runtime, 'currentGrant').mockResolvedValue(grant([
      'online-car-permit', 'not-installed', 'government-info', 'government-info',
    ]));
    expect((await runtime.listSystemModules()).map(({ id, authorized }) => ({ id, authorized }))).toEqual([
      { id: 'government-info', authorized: true },
      { id: 'online-car-permit', authorized: true },
    ]);
  });

  it('does not show business systems for a tools-only license', async () => {
    vi.spyOn(runtime, 'currentGrant').mockResolvedValue(grant([], { allowedTools: ['health-publicity'] }));
    expect(await runtime.listSystemModules()).toEqual([]);
  });

  it.each([-1, 0])('does not show modules when the license expires %i ms from now', async (offset) => {
    vi.spyOn(runtime, 'currentGrant').mockResolvedValue(grant(['market-access'], { expiresAt: now.getTime() + offset }));
    expect(await runtime.listSystemModules()).toEqual([]);
  });

  it('does not cache permissions after the current license changes', async () => {
    vi.spyOn(runtime, 'currentGrant')
      .mockResolvedValueOnce(grant(['market-access']))
      .mockResolvedValueOnce(grant(['oversize-transport']))
      .mockResolvedValueOnce(null);
    expect((await runtime.listSystemModules()).map(({ id }) => id)).toEqual(['market-access']);
    expect((await runtime.listSystemModules()).map(({ id }) => id)).toEqual(['oversize-transport']);
    expect(await runtime.listSystemModules()).toEqual([]);
  });
});
