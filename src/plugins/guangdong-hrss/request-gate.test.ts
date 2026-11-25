import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../core/errors/app-error';
import { HrssRequestGate, isExhaustedHrssTimeout, isHrssRequestTimeout } from './request-gate';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const nativeTimeout = () => new Error('net::ERR_TIMED_OUT');

describe('HRSS timeout identification', () => {
  it('recognizes native, Node and nested transport timeouts without matching arbitrary timeout text', () => {
    for (const error of [nativeTimeout(), new DOMException('Timed out', 'TimeoutError'), Object.assign(new Error(), { code: 'ETIMEDOUT' }), new Error('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), new AppError('REMOTE_TIMEOUT', '超时')]) {
      expect(isHrssRequestTimeout(error)).toBe(true);
    }
    for (const error of [new Error('business timeout warning'), new SyntaxError('invalid JSON'), new DOMException('Aborted', 'AbortError'), new AppError('SESSION_EXPIRED', '会话失效', undefined, { cause: nativeTimeout() }), new AppError('REMOTE_REQUEST_FAILED', '结构错误', { retryable: false }, { cause: nativeTimeout() })]) {
      expect(isHrssRequestTimeout(error)).toBe(false);
    }
    const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
    expect(isHrssRequestTimeout(cycle)).toBe(false);
    expect(isExhaustedHrssTimeout(new AppError('REMOTE_TIMEOUT', '超时'))).toBe(false);
    expect(isExhaustedHrssTimeout(new AppError('REMOTE_TIMEOUT', '超时', { attempts: 5, exhausted: true }))).toBe(true);
  });
});

describe('HRSS shared request scheduling', () => {
  it('starts immediately and serializes different paths with at least the default two-second interval', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const gate = new HrssRequestGate(), starts: number[] = [];
    const call = (path: string) => gate.execute(path, async () => { starts.push(Date.now()); return path; });
    await expect(call('/count')).resolves.toBe('/count');
    const second = call('/list'), third = call('/handling');
    await vi.advanceTimersByTimeAsync(1_999); expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1); await expect(second).resolves.toBe('/list');
    expect(starts).toEqual([0, 2_000]);
    await vi.advanceTimersByTimeAsync(2_000); await expect(third).resolves.toBe('/handling');
    expect(starts).toEqual([0, 2_000, 4_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries only timeouts and can recover before the fifth attempt', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const operation = vi.fn().mockRejectedValueOnce(nativeTimeout()).mockRejectedValueOnce({ cause: { code: 'ETIMEDOUT' } }).mockResolvedValue('ready');
    const pending = new HrssRequestGate().execute('/list', operation);
    await vi.advanceTimersByTimeAsync(3_999); expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); await expect(pending).resolves.toBe('ready');
    expect(operation).toHaveBeenCalledTimes(3); expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(call => call[1])).toEqual([
      { path: '/list', attempt: 1, maxAttempts: 5, exhausted: false },
      { path: '/list', attempt: 2, maxAttempts: 5, exhausted: false },
    ]);
  });

  it('caps fast native failures at five total attempts and emits only sanitized diagnostics', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const operation = vi.fn().mockRejectedValue(new Error('net::ERR_TIMED_OUT token=PRIVATE-ACCESS'));
    const result = new HrssRequestGate().execute('/list?token=PRIVATE-QUERY', operation).catch(error => error);
    await vi.advanceTimersByTimeAsync(8_000);
    const error = await result;
    expect(isExhaustedHrssTimeout(error)).toBe(true);
    if (!isExhaustedHrssTimeout(error)) throw new Error('Expected an exhausted HRSS timeout');
    expect(error).toMatchObject({ code: 'REMOTE_TIMEOUT', details: { attempts: 5, exhausted: true } });
    expect(operation).toHaveBeenCalledTimes(5); expect(warn).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/PRIVATE|token|\?/);
    expect(JSON.stringify(warn.mock.calls)).toContain('unknown');
    expect(error.message).not.toContain('PRIVATE');
  });

  it('times out each attempt at sixty seconds even when the operation ignores abort', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const signals: AbortSignal[] = [];
    const operation = vi.fn((signal: AbortSignal) => { signals.push(signal); return new Promise<never>(() => undefined); });
    const result = new HrssRequestGate().execute('/list', operation).catch(error => error);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(operation).toHaveBeenCalledTimes(5); expect(signals.filter(signal => signal.aborted)).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(isExhaustedHrssTimeout(await result)).toBe(true);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new AppError('SESSION_EXPIRED', '重新登录'),
    new AppError('QUERY_INVALID', '查询条件错误'),
    new AppError('REMOTE_REQUEST_FAILED', '列表结构错误', { retryable: false }),
    Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
    new DOMException('Cancelled', 'AbortError'),
  ])('does not retry non-timeout failures: %s', async error => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined), operation = vi.fn().mockRejectedValue(error);
    await expect(new HrssRequestGate(0).execute('/list', operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1); expect(warn).not.toHaveBeenCalled();
  });

  it('cancels an active operation immediately without retrying or converting it into a timeout', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let signal: AbortSignal | undefined;
    const operation = vi.fn((value: AbortSignal) => { signal = value; return new Promise<never>(() => undefined); });
    const result = new HrssRequestGate().execute('/list', operation, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect(await result).toMatchObject({ code: 'TASK_CANCELLED' });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(signal?.aborted).toBe(true); expect(operation).toHaveBeenCalledTimes(1); expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels during throttling and does not start the cancelled request later', async () => {
    vi.useFakeTimers();
    const gate = new HrssRequestGate(), operation = vi.fn(async () => 'ok');
    await gate.execute('/first', operation);
    const controller = new AbortController(), result = gate.execute('/second', operation, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(100); controller.abort();
    expect(await result).toMatchObject({ code: 'TASK_CANCELLED' });
    await vi.advanceTimersByTimeAsync(10_000); expect(operation).toHaveBeenCalledTimes(1);
    await expect(gate.execute('/third', operation)).resolves.toBe('ok');
  });

  it('returns cancellation while queued behind a pending request and keeps the queue usable', async () => {
    vi.useFakeTimers();
    const gate = new HrssRequestGate(0), controller = new AbortController();
    let finish!: (value: string) => void;
    const first = gate.execute('/first', async () => new Promise<string>(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(0);
    const operation = vi.fn(async () => 'unexpected');
    const second = gate.execute('/second', operation, controller.signal).catch(error => error);
    controller.abort(); expect(await second).toMatchObject({ code: 'TASK_CANCELLED' });
    finish('done'); await expect(first).resolves.toBe('done');
    await expect(gate.execute('/third', async () => 'ready')).resolves.toBe('ready');
    expect(operation).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
