export type AppErrorCode =
  | 'LICENSE_INVALID'
  | 'LICENSE_EXPIRED'
  | 'SYSTEM_NOT_FOUND'
  | 'SYSTEM_LOGIN_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'QUERY_INVALID'
  | 'REMOTE_RATE_LIMITED'
  | 'REMOTE_TIMEOUT'
  | 'REMOTE_REQUEST_FAILED'
  | 'LOCAL_STORAGE_FAILED'
  | 'EXPORT_FAILED'
  | 'TASK_CANCELLED'
  | 'UNKNOWN';

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}

export function toAppError(error: unknown, fallback: AppErrorCode = 'UNKNOWN'): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) return new AppError(fallback, error.message, undefined, { cause: error });
  return new AppError(fallback, String(error));
}
