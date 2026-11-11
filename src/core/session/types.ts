export type SessionStatus =
  | 'logged-out'
  | 'logging-in'
  | 'authenticated'
  | 'unverified'
  | 'expiring'
  | 'expired';

export interface SessionState {
  status: SessionStatus;
  systemId: string;
  expiresAt?: number;
  displayName?: string;
  message?: string;
}

/** Main-process only. Never include these hooks or snapshots in IPC metadata. */
export interface SessionRecovery {
  snapshot(): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  restore(value: Record<string, unknown>): Promise<void> | void;
  validate(signal: AbortSignal): Promise<{ displayName?: string }>;
  homeUrl(): string;
}

/**
 * Sensitive authentication material stays inside the plugin/main-process boundary.
 * Renderer pages should receive SessionState, never raw credentials.
 */
export interface AuthSession {
  accessToken?: string;
  refreshToken?: string;
  cookies?: string;
  csrfToken?: string;
  expiresAt?: number;
  metadata?: Record<string, string>;
}

export interface AuthAdapter {
  getState(): Promise<SessionState>;
  login(): Promise<SessionState>;
  logout(): Promise<void>;
  refresh?(): Promise<SessionState>;
  getSessionForRequest(): Promise<AuthSession>;
}
