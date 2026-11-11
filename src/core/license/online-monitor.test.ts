import { afterEach, expect, it, vi } from 'vitest';
import { OnlineLicenseMonitor } from './online-monitor';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('polls every five minutes without overlapping and stops cleanly', async () => {
  vi.useFakeTimers();
  let resolve!: () => void;
  const refresh = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
  const monitor = new OnlineLicenseMonitor(refresh);
  monitor.start(); monitor.start();
  await vi.advanceTimersByTimeAsync(5 * 60_000); expect(refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5 * 60_000); expect(refresh).toHaveBeenCalledTimes(1);
  resolve(); await vi.advanceTimersByTimeAsync(5 * 60_000); expect(refresh).toHaveBeenCalledTimes(2);
  const stopping = monitor.stop(); resolve(); await stopping;
  await vi.advanceTimersByTimeAsync(10 * 60_000); expect(refresh).toHaveBeenCalledTimes(2);
});
it('retries after an offline error without leaking raw errors', async () => {
  vi.useFakeTimers(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const refresh = vi.fn().mockRejectedValueOnce(new Error('secret')).mockResolvedValue(null);
  const monitor = new OnlineLicenseMonitor(refresh); monitor.start();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(refresh).toHaveBeenCalledTimes(2); expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  await monitor.stop();
});
