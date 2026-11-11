import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomaticUpdateController, type AutomaticUpdateDependencies } from './automatic';
import type { UpdateArtifact, UpdateCheckResult } from './service';

const artifact: UpdateArtifact = { version: '1.0.3', url: 'https://updates.test/app.exe', sha256: 'a'.repeat(64),
  bytes: 100, installer: 'nsis', platform: 'win32', arch: 'x64', notes: '新版本' };
const result = (): UpdateCheckResult => ({ configured: true, checkedAt: Date.now(), app: { ...artifact } });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(overrides: Partial<AutomaticUpdateDependencies> = {}) {
  const deps = { version: '1.0.2', installMode: 'installed' as const,
    settings: vi.fn(async () => ({ autoCheckUpdates: true })), check: vi.fn(async () => result()),
    download: vi.fn<AutomaticUpdateDependencies['download']>(async (_artifact, progress) => { progress({ downloaded: 100, total: 100, percent: 100 }); return '/safe/cache.exe'; }),
    verify: vi.fn<AutomaticUpdateDependencies['verify']>(async () => {}), install: vi.fn<AutomaticUpdateDependencies['install']>(async () => {}),
    busy: vi.fn(() => false), changed: vi.fn<AutomaticUpdateDependencies['changed']>(),
  };
  Object.assign(deps, overrides);
  return { deps, controller: new AutomaticUpdateController(deps) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('automatic update lifecycle', () => {
  it('waits ten seconds at startup, respects saved opt-out, and supports a manual check', async () => {
    vi.useFakeTimers();
    const { deps, controller } = fixture({ settings: vi.fn(async () => ({ autoCheckUpdates: false })) });
    controller.start(); await vi.advanceTimersByTimeAsync(9999); expect(deps.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(deps.settings).toHaveBeenCalledTimes(1); expect(deps.check).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ automatic: false, status: 'idle' });
    await controller.check(); expect(controller.snapshot().status).toBe('ready'); expect(deps.download).toHaveBeenCalledTimes(1); await controller.stop();
  });
  it('automatically downloads but never installs or interrupts even while business tasks are busy', async () => {
    vi.useFakeTimers(); const { deps, controller } = fixture({ busy: vi.fn(() => true) });
    controller.start(); await vi.advanceTimersByTimeAsync(10000);
    expect(controller.snapshot()).toMatchObject({ status: 'ready', version: artifact.version, progress: { percent: 100 } });
    expect(deps.install).not.toHaveBeenCalled(); await controller.stop();
  });
  it('polls every four hours and avoids downloading a verified same-version cache twice', async () => {
    vi.useFakeTimers(); const { deps, controller } = fixture();
    controller.start(); await vi.advanceTimersByTimeAsync(10000); await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    expect(deps.check).toHaveBeenCalledTimes(2); expect(deps.download).toHaveBeenCalledTimes(1); expect(deps.verify).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().message).not.toContain('手动'); await controller.stop();
  });
  it('retries after fifteen minutes on an offline check and never leaks raw upstream errors', async () => {
    vi.useFakeTimers(); const { deps, controller } = fixture(); deps.check.mockRejectedValueOnce(new Error('secret upstream URL'));
    controller.start(); await vi.advanceTimersByTimeAsync(10000);
    expect(controller.snapshot()).toMatchObject({ status: 'error' }); expect(JSON.stringify(controller.snapshot())).not.toContain('secret');
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1); expect(deps.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(deps.check).toHaveBeenCalledTimes(2); expect(controller.snapshot().status).toBe('ready'); await controller.stop();
  });
  it('a preferences/activation notification schedules a new respecting-settings check without duplicate timers', async () => {
    vi.useFakeTimers(); const { deps, controller } = fixture(); controller.start(); controller.requestCheckSoon(); controller.requestCheckSoon();
    await vi.advanceTimersByTimeAsync(1000); expect(deps.check).toHaveBeenCalledTimes(1); await controller.stop();
  });
  it('deduplicates parallel checks and download requests, and exposes no installation paths or signed proofs', async () => {
    const pending = deferred<UpdateCheckResult>(), { deps, controller } = fixture(); deps.check.mockReturnValueOnce(pending.promise);
    const first = controller.check(), second = controller.check(); expect(deps.check).toHaveBeenCalledTimes(1);
    pending.resolve(result()); await Promise.all([first, second]); await Promise.all([controller.download(), controller.download()]);
    expect(deps.download).toHaveBeenCalledTimes(1); expect(JSON.stringify(controller.snapshot())).not.toContain('/safe/cache.exe');
  });
  it('does not let an explicit download race an in-flight newer manifest check', async () => {
    const pending = deferred<UpdateCheckResult>(), { deps, controller } = fixture(); deps.check.mockReturnValueOnce(pending.promise);
    const check = controller.check(); await expect(controller.download()).rejects.toThrow('正在检查');
    pending.resolve(result()); await check; expect(deps.download).toHaveBeenCalledTimes(1);
  });
  it('re-downloads a changed release and a corrupted same-version cache', async () => {
    const { deps, controller } = fixture(); await controller.check(); deps.verify.mockRejectedValueOnce(new Error('bad cache'));
    await controller.check(); expect(deps.download).toHaveBeenCalledTimes(2);
    deps.check.mockResolvedValueOnce({ ...result(), app: { ...artifact, version: '1.0.4', sha256: 'b'.repeat(64) } });
    await controller.check(); expect(deps.download).toHaveBeenCalledTimes(3); expect(controller.snapshot().version).toBe('1.0.4');
  });
  it.each(['manual', 'external', 'wrong-architecture'])('never auto-downloads or auto-installs unsupported mode/artifact: %s', async kind => {
    const { deps, controller } = fixture(kind === 'manual' ? { installMode: 'manual' } : {});
    if (kind === 'external') deps.check.mockResolvedValue({ ...result(), app: { ...artifact, installer: undefined } });
    if (kind === 'wrong-architecture') deps.check.mockResolvedValue({ ...result(), app: { ...artifact, arch: undefined } });
    await controller.check(true); expect(deps.download).not.toHaveBeenCalled(); expect(controller.snapshot()).toMatchObject({ status: 'available', installMode: 'manual' });
    await controller.download(); await expect(controller.install()).rejects.toThrow('手动'); expect(deps.install).not.toHaveBeenCalled();
  });
  it.each([undefined, { ...artifact, version: '1.0.2' }, { ...artifact, url: 'http://updates.test/app.exe' }])('handles current/invalid releases without executing or downloading', async app => {
    const { deps, controller } = fixture(); deps.check.mockResolvedValue({ configured: true, checkedAt: 1, app });
    if (app) await expect(controller.check()).rejects.toThrow('更新检查'); else await controller.check();
    expect(deps.download).not.toHaveBeenCalled(); expect(deps.install).not.toHaveBeenCalled();
  });
  it('clears a cached release on entitlement loss or an empty newer manifest', async () => {
    const { deps, controller } = fixture(); await controller.check();
    deps.check.mockResolvedValueOnce({ configured: false, checkedAt: 1, message: '授权未开启' }); await controller.check();
    expect(controller.snapshot()).toMatchObject({ status: 'disabled', version: undefined, notes: undefined });
    await expect(controller.install()).rejects.toThrow('先下载');
  });
  it('reports download failure and safely recovers on a later check', async () => {
    const { deps, controller } = fixture(); deps.download.mockRejectedValueOnce(new Error('raw token=secret'));
    await expect(controller.check()).rejects.toThrow('更新检查'); expect(controller.snapshot().status).toBe('error');
    expect(JSON.stringify(controller.snapshot())).not.toContain('secret'); await controller.check(); expect(controller.snapshot().status).toBe('ready');
  });
  it('aborts an in-flight background download and ignores late progress or completion after stop', async () => {
    const work = deferred<string>(), { deps, controller } = fixture(); let signal!: AbortSignal; let progress!: (value: { downloaded: number }) => void;
    deps.download.mockImplementationOnce(async (_artifact, callback, value) => { signal = value; progress = callback; return work.promise; });
    const checking = controller.check(); await vi.waitFor(() => expect(deps.download).toHaveBeenCalledTimes(1));
    const before = deps.changed.mock.calls.length, stopping = controller.stop(); expect(signal.aborted).toBe(true);
    progress({ downloaded: 10 }); work.resolve('/late.exe'); await Promise.all([checking, stopping]);
    expect(deps.changed).toHaveBeenCalledTimes(before); await expect(controller.install()).rejects.toThrow('先下载');
  });
  it('never schedules work after a stopped delayed settings read resolves', async () => {
    vi.useFakeTimers(); const settings = deferred<{ autoCheckUpdates: boolean }>(), { deps, controller } = fixture({ settings: () => settings.promise });
    controller.start(); await vi.advanceTimersByTimeAsync(10000); await controller.stop(); settings.resolve({ autoCheckUpdates: true });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); expect(deps.check).not.toHaveBeenCalled();
  });
  it('retains a safe last-install warning without exposing mutable internal state', async () => {
    const { controller } = fixture({ lastInstallError: '上次更新未完成，仍使用原版本' });
    await controller.check(); const state = controller.snapshot(); expect(state.lastInstallError).toContain('上次更新');
    state.status = 'disabled'; expect(controller.snapshot().status).toBe('ready');
  });
});

describe('verified update installation gate', () => {
  it('keeps an internal Linux build away from Windows update checks and installers', async () => {
    vi.useFakeTimers();
    const reason = '麒麟内部测试版暂未开放在线更新';
    const { deps, controller } = fixture({ disabledReason: reason });
    expect(controller.snapshot()).toMatchObject({ status: 'disabled', automatic: false, message: reason });
    controller.start(); controller.requestCheckSoon();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(await controller.check()).toMatchObject({ configured: false, message: reason });
    await expect(controller.download()).rejects.toThrow('没有可下载');
    await expect(controller.install()).rejects.toThrow('先下载');
    expect(deps.check).not.toHaveBeenCalled(); expect(deps.download).not.toHaveBeenCalled(); expect(deps.install).not.toHaveBeenCalled();
    await controller.stop();
  });
  it('re-checks live publication and file hash before requesting the main-process handoff', async () => {
    const { deps, controller } = fixture(); await controller.check(); await controller.install();
    expect(deps.check).toHaveBeenCalledTimes(2); expect(deps.verify).toHaveBeenCalledExactlyOnceWith('/safe/cache.exe', artifact);
    expect(deps.install).toHaveBeenCalledExactlyOnceWith('/safe/cache.exe', artifact); expect(controller.snapshot().status).toBe('installing');
  });
  it('refuses while business work is running without even rechecking or opening an installer', async () => {
    const { deps, controller } = fixture(); await controller.check(); deps.busy.mockReturnValue(true);
    await expect(controller.install()).rejects.toThrow('正在回流'); expect(deps.check).toHaveBeenCalledTimes(1); expect(deps.install).not.toHaveBeenCalled();
  });
  it.each(['permission', 'unpublished', 'different-version', 'different-hash', 'no-longer-nsis'])('does not install revoked or changed metadata: %s', async kind => {
    const { deps, controller } = fixture(); await controller.check();
    deps.check.mockResolvedValueOnce(kind === 'permission' ? { configured: false, checkedAt: 1 }
      : { configured: true, checkedAt: 1, app: kind === 'unpublished' ? undefined : { ...artifact,
        ...(kind === 'different-version' ? { version: '1.0.4' } : kind === 'different-hash' ? { sha256: 'b'.repeat(64) } : { installer: undefined }) } });
    await expect(controller.install()).rejects.toThrow('尚未安装'); expect(deps.install).not.toHaveBeenCalled(); expect(controller.snapshot().status).toBe('error');
  });
  it('does not hand off if the cached package has been altered since download', async () => {
    const { deps, controller } = fixture(); await controller.check(); deps.verify.mockRejectedValueOnce(new Error('mismatch'));
    await expect(controller.install()).rejects.toThrow('尚未安装'); expect(deps.install).not.toHaveBeenCalled(); expect(controller.snapshot().status).toBe('error');
  });
  it('rechecks business activity after a potentially slow file verification', async () => {
    const { deps, controller } = fixture(); await controller.check(); deps.verify.mockImplementationOnce(async () => { deps.busy.mockReturnValue(true); });
    await expect(controller.install()).rejects.toThrow('尚未安装'); expect(deps.install).not.toHaveBeenCalled(); expect(controller.snapshot().status).toBe('ready');
  });
  it('deduplicates install clicks and keeps a failed preparatory handoff retryable', async () => {
    const handoff = deferred<void>(), { deps, controller } = fixture(); await controller.check(); deps.install.mockReturnValueOnce(handoff.promise);
    const installing = controller.install(); await vi.waitFor(() => expect(deps.install).toHaveBeenCalledTimes(1));
    await expect(controller.install()).rejects.toThrow('先下载'); handoff.reject(new Error('helper unavailable'));
    await expect(installing).rejects.toThrow('尚未安装'); expect(controller.snapshot().status).toBe('ready');
  });
  it('stops before handoff if shutdown occurs during live publication verification', async () => {
    const pending = deferred<UpdateCheckResult>(), { deps, controller } = fixture(); await controller.check(); deps.check.mockReturnValueOnce(pending.promise);
    const installing = controller.install(); await controller.stop(); pending.resolve(result());
    await expect(installing).rejects.toThrow('尚未安装'); expect(deps.install).not.toHaveBeenCalled(); expect(deps.verify).not.toHaveBeenCalled();
  });
});
