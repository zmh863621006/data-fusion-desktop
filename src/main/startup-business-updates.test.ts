import { describe, expect, it, vi } from 'vitest';
import { StartupBusinessUpdates } from './startup-business-updates';
import type { BusinessBootstrapContext } from './business-bootstrap-context';

function fixture() {
  const context: BusinessBootstrapContext = { schema: 1, primaryInstance: true, profilePath: '/isolated/profile', root: '/isolated/business',
    shellVersion: '1.1.0', version: '1.1.0', backend: { origin: 'https://backend.example.test', revision: 1 }, offline: false,
    check: vi.fn(async () => ({ version: '1.1.1', offline: false })), ready: vi.fn(), failed: vi.fn(), cancelCheck: vi.fn() };
  const deps = { context, busy: vi.fn(() => false), restart: vi.fn(async () => {}), changed: vi.fn() };
  return { ...deps, controller: new StartupBusinessUpdates(deps) };
}
describe('business updates during an already running application', () => {
  it('prepares a new version without loading it, reinstalling, or restarting business work', async () => {
    const f = fixture();
    await expect(f.controller.check()).resolves.toMatchObject({ configured: true, businessVersion: '1.1.1' });
    expect(f.controller.snapshot()).toMatchObject({ status: 'ready', installMode: 'startup', kind: 'business', currentVersion: '1.1.0', version: '1.1.1', shellVersion: '1.1.0' });
    expect(f.restart).not.toHaveBeenCalled(); expect(f.context.ready).not.toHaveBeenCalled();
    f.busy.mockReturnValue(true);
    await expect(f.controller.install()).rejects.toThrow('回流'); expect(f.restart).not.toHaveBeenCalled();
    f.busy.mockReturnValue(false); await f.controller.install(); expect(f.restart).toHaveBeenCalledTimes(1);
  });
  it('keeps the offline last verified version usable without claiming an online check succeeded', async () => {
    const f = fixture(); vi.mocked(f.context.check).mockResolvedValue({ version: '1.1.0', offline: true });
    await f.controller.check();
    expect(f.controller.snapshot()).toMatchObject({ status: 'up-to-date', offline: true, version: undefined });
    expect(f.controller.snapshot().message).toContain('暂时无法检查'); expect(f.restart).not.toHaveBeenCalled();
  });
  it('retains errors from a mandatory pending update without starting an installer or replacing the running version', async () => {
    const f = fixture(); vi.mocked(f.context.check).mockRejectedValue(new Error('PENDING_UPDATE_REQUIRED'));
    await expect(f.controller.check()).rejects.toThrow('尚未准备完成');
    expect(f.controller.snapshot()).toMatchObject({ status: 'error', currentVersion: '1.1.0' });
    expect(f.controller.snapshot().message).toContain('下次启动'); expect(f.restart).not.toHaveBeenCalled();
  });
  it('coalesces checks and cancels in-flight preparation before closing', async () => {
    const f = fixture(); let complete!: (value: { version: string; offline: boolean }) => void;
    vi.mocked(f.context.check).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const one = f.controller.check(), two = f.controller.check(); expect(f.context.check).toHaveBeenCalledTimes(1);
    const stopped = f.controller.stop(); expect(f.context.cancelCheck).toHaveBeenCalledTimes(1);
    complete({ version: '1.1.1', offline: false }); await Promise.all([one, two, stopped]);
    await expect(f.controller.install()).rejects.toThrow();
  });
});
