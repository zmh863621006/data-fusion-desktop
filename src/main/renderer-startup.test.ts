import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { RendererStartupGuard } from './renderer-startup';

afterEach(() => { vi.useRealTimers(); });
function fixture(verifyView = vi.fn(async () => true)) {
  vi.useFakeTimers(); const frame = {}, event = { sender: { id: 7 }, senderFrame: frame } as Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>;
  const deps = { contentsId: () => 7, mainFrame: () => frame, verifyView, show: vi.fn(), ready: vi.fn(), failed: vi.fn(), timeoutMs: 1000 };
  return { guard: new RendererStartupGuard(deps), deps, event };
}
describe('verified renderer startup', () => {
  it.each(['paint-first', 'ipc-first'])('requires both real first view acknowledgment and first paint (%s)', async order => {
    const { guard, deps, event } = fixture();
    if (order === 'paint-first') guard.firstPaint(); else await guard.acknowledge(event);
    expect(deps.ready).not.toHaveBeenCalled(); expect(deps.show).not.toHaveBeenCalled();
    if (order === 'paint-first') await guard.acknowledge(event); else guard.firstPaint();
    expect(deps.ready).toHaveBeenCalledTimes(1); expect(deps.show).toHaveBeenCalledTimes(1);
    await guard.acknowledge(event); guard.firstPaint(); await vi.advanceTimersByTimeAsync(2000);
    expect(deps.ready).toHaveBeenCalledTimes(1); expect(deps.failed).not.toHaveBeenCalled(); guard.dispose();
  });
  it('never reports an empty or unstyled first paint as ready and exposes timed recovery', async () => {
    const { guard, deps, event } = fixture(vi.fn(async () => false)); guard.firstPaint();
    expect(await guard.acknowledge(event)).toBe(false); await vi.advanceTimersByTimeAsync(1000);
    expect(deps.ready).not.toHaveBeenCalled(); expect(deps.show).not.toHaveBeenCalled();
    expect(deps.failed).toHaveBeenCalledWith('BUSINESS_RENDERER_TIMEOUT');
    expect(await guard.acknowledge(event)).toBe(false); guard.fail('again'); expect(deps.failed).toHaveBeenCalledTimes(1);
  });
  it('rejects child frames and other windows even if they have the same bridge', async () => {
    const { guard, deps, event } = fixture();
    await expect(guard.acknowledge({ ...event, senderFrame: {} } as typeof event)).rejects.toThrow('非受信');
    await expect(guard.acknowledge({ ...event, sender: { id: 8 } } as typeof event)).rejects.toThrow('非受信');
    expect(deps.verifyView).not.toHaveBeenCalled(); guard.dispose();
  });
  it('permits retry after initial DOM validation fails, and a later renderer crash enters recovery', async () => {
    const verify = vi.fn(async () => false), { guard, deps, event } = fixture(verify); guard.firstPaint();
    expect(await guard.acknowledge(event)).toBe(false); verify.mockResolvedValue(true);
    expect(await guard.acknowledge(event)).toBe(true); guard.fail('BUSINESS_RENDERER_GONE');
    expect(deps.ready).toHaveBeenCalledTimes(1); expect(deps.failed).toHaveBeenCalledWith('BUSINESS_RENDERER_GONE');
  });
  it('does not become ready when a pending verification completes after the window closes', async () => {
    let finish!: (value: boolean) => void;
    const { guard, deps, event } = fixture(vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })));
    guard.firstPaint(); const ack = guard.acknowledge(event); guard.dispose(); finish(true);
    expect(await ack).toBe(false); await vi.advanceTimersByTimeAsync(2000);
    expect(deps.ready).not.toHaveBeenCalled(); expect(deps.failed).not.toHaveBeenCalled();
  });
});
