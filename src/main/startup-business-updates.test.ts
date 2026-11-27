import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartupBusinessUpdates } from './startup-business-updates';
import type { BusinessBootstrapContext } from './business-bootstrap-context';

function fixture(offline = false) {
  const context: BusinessBootstrapContext = { schema: 1, primaryInstance: true, profilePath: '/isolated/profile', root: '/isolated/business',
    shellVersion: '1.1.0', version: '1.1.0', backend: { origin: 'https://backend.example.test', revision: 1 }, offline,
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

describe('one automatic follow-up after an offline startup', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not check until started, and does not schedule a follow-up after an online startup', async () => {
    const offline = fixture(true), online = fixture();
    offline.controller.requestCheckSoon(); online.controller.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(offline.context.check).not.toHaveBeenCalled();
    expect(online.context.check).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs exactly once after ten seconds even when start is called repeatedly', async () => {
    const f = fixture(true);
    f.controller.start(); f.controller.start();
    await vi.advanceTimersByTimeAsync(9_999); expect(f.context.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(f.context.check).toHaveBeenCalledTimes(1);
    f.controller.start(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.context.check).toHaveBeenCalledTimes(1);
    expect(f.controller.snapshot()).toMatchObject({ status: 'ready', offline: false, version: '1.1.1' });
    expect(f.restart).not.toHaveBeenCalled(); expect(f.context.ready).not.toHaveBeenCalled();
  });

  it('cancels the pending follow-up after a successful manual online check', async () => {
    const f = fixture(true); f.controller.start();
    await vi.advanceTimersByTimeAsync(2_000); await f.controller.check();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000); expect(f.context.check).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a follow-up if a manual check already recovered before start', async () => {
    const f = fixture(true); await f.controller.check(); f.controller.start();
    await vi.advanceTimersByTimeAsync(60_000); expect(f.context.check).toHaveBeenCalledTimes(1);
  });

  it('preserves the single automatic attempt after a manual failure', async () => {
    const f = fixture(true);
    vi.mocked(f.context.check).mockRejectedValueOnce(new Error('NETWORK_UNAVAILABLE'));
    f.controller.start(); await expect(f.controller.check()).rejects.toThrow('尚未准备完成');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.context.check).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot()).toMatchObject({ status: 'ready', offline: false });
  });

  it('preserves the follow-up when a manual check returns an offline fallback', async () => {
    const f = fixture(true);
    vi.mocked(f.context.check).mockResolvedValueOnce({ version: '1.1.0', offline: true });
    f.controller.start(); await f.controller.check();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.context.check).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot()).toMatchObject({ status: 'ready', offline: false });
  });

  it('waits for a pending manual check and skips the follow-up when it succeeds online', async () => {
    const f = fixture(true); let complete!: (value: { version: string; offline: boolean }) => void;
    vi.mocked(f.context.check).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    f.controller.start(); const manual = f.controller.check();
    await vi.advanceTimersByTimeAsync(10_000); expect(f.context.check).toHaveBeenCalledTimes(1);
    complete({ version: '1.1.1', offline: false }); await manual;
    await vi.advanceTimersByTimeAsync(60_000); expect(f.context.check).toHaveBeenCalledTimes(1);
  });

  it.each(['failure', 'offline'] as const)('retries once after a pending manual check ends with %s', async outcome => {
    const f = fixture(true); let complete!: (value: { version: string; offline: boolean }) => void;
    let fail!: (error: Error) => void;
    vi.mocked(f.context.check).mockImplementationOnce(() => new Promise((resolve, reject) => { complete = resolve; fail = reject; }));
    f.controller.start(); const manual = f.controller.check().catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000); expect(f.context.check).toHaveBeenCalledTimes(1);
    if (outcome === 'failure') fail(new Error('NETWORK_UNAVAILABLE'));
    else complete({ version: '1.1.0', offline: true });
    await manual; await vi.advanceTimersByTimeAsync(0);
    expect(f.context.check).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot()).toMatchObject({ status: 'ready', offline: false });
    await vi.advanceTimersByTimeAsync(60_000); expect(f.context.check).toHaveBeenCalledTimes(2);
  });

  it('coalesces a manual check with the automatic request and keeps restart under user control', async () => {
    const f = fixture(true); let complete!: (value: { version: string; offline: boolean }) => void;
    vi.mocked(f.context.check).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    f.busy.mockReturnValue(true); f.controller.start();
    await vi.advanceTimersByTimeAsync(10_000); const manual = f.controller.check();
    expect(f.context.check).toHaveBeenCalledTimes(1);
    complete({ version: '1.1.1', offline: false }); await manual; await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.snapshot()).toMatchObject({ status: 'ready', version: '1.1.1' });
    expect(f.restart).not.toHaveBeenCalled();
    await expect(f.controller.install()).rejects.toThrow('回流');
  });

  it('handles an automatic failure without an unhandled rejection or recurring retries', async () => {
    const f = fixture(true); vi.mocked(f.context.check).mockRejectedValue(new Error('NETWORK_UNAVAILABLE'));
    f.controller.start(); await vi.advanceTimersByTimeAsync(10_000);
    expect(f.controller.snapshot()).toMatchObject({ status: 'error', offline: true });
    await vi.advanceTimersByTimeAsync(60_000); expect(f.context.check).toHaveBeenCalledTimes(1);
    expect(f.restart).not.toHaveBeenCalled();
  });

  it('clears the timer on stop and cannot schedule checks after stopping', async () => {
    const f = fixture(true); f.controller.start(); await f.controller.stop(); f.controller.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000); expect(f.context.check).not.toHaveBeenCalled();
    await expect(f.controller.check()).rejects.toThrow('正在退出');
  });

  it('cancels and waits for the in-flight automatic check on stop', async () => {
    const f = fixture(true); let complete!: (value: { version: string; offline: boolean }) => void;
    vi.mocked(f.context.check).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    f.controller.start(); await vi.advanceTimersByTimeAsync(10_000);
    let closed = false; const stopped = f.controller.stop().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.context.cancelCheck).toHaveBeenCalledTimes(1); expect(closed).toBe(false);
    const changesBeforeCompletion = f.changed.mock.calls.length;
    complete({ version: '1.1.1', offline: false }); await stopped;
    expect(closed).toBe(true); expect(f.changed).toHaveBeenCalledTimes(changesBeforeCompletion);
    expect(f.restart).not.toHaveBeenCalled();
  });

  it('stops an automatic follow-up waiting for a manual request without starting another request', async () => {
    const f = fixture(true); let fail!: (error: Error) => void;
    vi.mocked(f.context.check).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    f.controller.start(); const manual = f.controller.check().catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    const stopped = f.controller.stop(); fail(new Error('CANCELLED'));
    await Promise.all([manual, stopped]);
    expect(f.context.check).toHaveBeenCalledTimes(1); expect(f.context.cancelCheck).toHaveBeenCalledTimes(1);
  });
});
