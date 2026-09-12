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
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new AppError('TASK_CANCELLED', '任务已取消'));
  }, { once: true });
});

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
        lastError = error;
        if (outerSignal?.aborted) throw new AppError('TASK_CANCELLED', '任务已取消');
        if (attempt < this.policy.maxAttempts) await sleep(this.policy.retryDelayMs * attempt, outerSignal);
      } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', onAbort);
      }
    }
    throw new AppError('REMOTE_REQUEST_FAILED', '远程系统请求失败', { attempts: this.policy.maxAttempts }, { cause: lastError });
  }
}
