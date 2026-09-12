export type SessionStatus =
  | 'logged-out'
  | 'logging-in'
  | 'authenticated'
  | 'expiring'
  | 'expired';

export interface SessionState {
  status: SessionStatus;
  systemId: string;
  expiresAt?: number;
  displayName?: string;
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
