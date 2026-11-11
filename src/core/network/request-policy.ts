import { AppError } from '../errors/app-error';

export interface RequestPolicy {
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  minimumIntervalMs: number;
}

export const DEFAULT_REQUEST_POLICY: RequestPolicy = {
  timeoutMs: 20_000,
  maxAttempts: 3,
  retryDelayMs: 800,
  minimumIntervalMs: 250,
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const onAbort = () => {
    clearTimeout(timer);
    reject(new AppError('TASK_CANCELLED', '任务已取消'));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

const NON_RETRYABLE_CODES = new Set([
  'LICENSE_INVALID',
  'LICENSE_EXPIRED',
  'SYSTEM_NOT_FOUND',
  'SYSTEM_LOGIN_REQUIRED',
  'SESSION_EXPIRED',
  'QUERY_INVALID',
  'TASK_CANCELLED',
]);

export class RequestGate {
  private lastStartedAt = 0;

  constructor(private readonly policy: RequestPolicy = DEFAULT_REQUEST_POLICY) {}

  async execute<T>(operation: (signal: AbortSignal) => Promise<T>, outerSignal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt += 1) {
      if (outerSignal?.aborted) throw new AppError('TASK_CANCELLED', '任务已取消');
      const wait = Math.max(0, this.policy.minimumIntervalMs - (Date.now() - this.lastStartedAt));
      if (wait) await sleep(wait, outerSignal);

      const timeout = new AbortController();
      const onAbort = () => timeout.abort();
      outerSignal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => timeout.abort(), this.policy.timeoutMs);
      this.lastStartedAt = Date.now();

      try {
        return await operation(timeout.signal);
      } catch (error) {
        lastError = timeout.signal.aborted
          ? new AppError('REMOTE_TIMEOUT', '远程系统请求超时')
          : error;
        if (outerSignal?.aborted) throw new AppError('TASK_CANCELLED', '任务已取消');
        if (
          error instanceof AppError
          && (NON_RETRYABLE_CODES.has(error.code) || error.details?.retryable === false)
        ) throw error;
        if (attempt < this.policy.maxAttempts) await sleep(this.policy.retryDelayMs * attempt, outerSignal);
      } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', onAbort);
      }
    }
    if (lastError instanceof AppError) throw lastError;
    const reason = lastError instanceof Error && lastError.message.trim()
      ? `：${lastError.message.trim()}`
      : '';
    throw new AppError(
      'REMOTE_REQUEST_FAILED',
      `远程系统请求失败${reason}`,
      { attempts: this.policy.maxAttempts },
      { cause: lastError },
    );
  }
}
