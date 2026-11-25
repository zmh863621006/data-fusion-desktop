import { AppError } from '../../core/errors/app-error';

const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 5;
const cancelled = () => new AppError('TASK_CANCELLED', '回流任务已取消');
const timedOut = () => new AppError('REMOTE_TIMEOUT', '人社系统请求超时');

/** Match transport timeout signatures, never business messages or a user abort. */
export function isHrssRequestTimeout(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (current instanceof AppError) return current.code === 'REMOTE_TIMEOUT';
    if (!current || typeof current !== 'object' || seen.has(current)) return false;
    seen.add(current);
    const value = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (value.name === 'AbortError' || ['TASK_CANCELLED', 'SESSION_EXPIRED', 'QUERY_INVALID'].includes(String(value.code))) return false;
    if (value.name === 'TimeoutError' || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ERR_TIMED_OUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(String(value.code))) return true;
    if (typeof value.message === 'string' && /\bnet::ERR_(?:CONNECTION_)?TIMED_OUT\b/i.test(value.message)) return true;
    current = value.cause;
  }
  return false;
}

export function isExhaustedHrssTimeout(error: unknown): error is AppError {
  return error instanceof AppError && error.code === 'REMOTE_TIMEOUT'
    && error.details?.attempts === MAX_ATTEMPTS && error.details.exhausted === true;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** All HRSS routes share one serial queue. Only real timeouts consume the five-attempt retry budget. */
export class HrssRequestGate {
  private lastStartedAt?: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly minimumIntervalMs = 2_000) {
    if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) throw new RangeError('Invalid HRSS request interval');
  }

  async execute<T>(path: string, operation: (signal: AbortSignal) => Promise<T>, outerSignal?: AbortSignal): Promise<T> {
    if (outerSignal?.aborted) throw cancelled();
    const task = this.tail.then(() => this.run(path, operation, outerSignal));
    this.tail = task.then(() => undefined, () => undefined);
    // A cancelled queued request returns immediately, without waiting for the preceding request.
    if (!outerSignal) return task;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(cancelled());
      outerSignal.addEventListener('abort', onAbort, { once: true });
      task.then(resolve, reject).finally(() => outerSignal.removeEventListener('abort', onAbort));
      if (outerSignal.aborted) onAbort();
    });
  }

  private async run<T>(path: string, operation: (signal: AbortSignal) => Promise<T>, outerSignal?: AbortSignal): Promise<T> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (outerSignal?.aborted) throw cancelled();
      const delay = this.lastStartedAt === undefined ? 0 : Math.max(0, this.minimumIntervalMs - (Date.now() - this.lastStartedAt));
      if (delay) await wait(delay, outerSignal);
      if (outerSignal?.aborted) throw cancelled();
      this.lastStartedAt = Date.now();
      try {
        return await this.attempt(operation, outerSignal);
      } catch (error) {
        if (outerSignal?.aborted) throw cancelled();
        if (!isHrssRequestTimeout(error)) throw error;
        // Client callers supply catalogue paths. Reject query strings and other dynamic text in diagnostics.
        const safePath = /^\/[A-Za-z0-9_./-]{1,255}$/.test(path) ? path : 'unknown';
        console.warn('人社接口请求超时', { path: safePath, attempt, maxAttempts: MAX_ATTEMPTS, exhausted: attempt === MAX_ATTEMPTS });
        if (attempt === MAX_ATTEMPTS) throw new AppError('REMOTE_TIMEOUT', '人社系统请求超时，已达到 5 次尝试上限', { attempts: MAX_ATTEMPTS, exhausted: true });
      }
    }
    throw new Error('HRSS attempt limit reached');
  }

  private async attempt<T>(operation: (signal: AbortSignal) => Promise<T>, outerSignal?: AbortSignal): Promise<T> {
    if (outerSignal?.aborted) throw cancelled();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let onAbort: () => void;
    const interruption = new Promise<never>((_resolve, reject) => {
      onAbort = () => { const error = cancelled(); reject(error); controller.abort(error); };
      outerSignal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { const error = timedOut(); reject(error); controller.abort(error); }, TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (outerSignal?.aborted) throw cancelled();
          return operation(controller.signal);
        }),
        interruption,
      ]);
    } finally {
      clearTimeout(timer!);
      outerSignal?.removeEventListener('abort', onAbort!);
    }
  }
}
