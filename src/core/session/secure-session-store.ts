import type { AuthSession } from './types';

/**
 * Raw business-system sessions must never be persisted in ordinary application tables.
 * Platform-specific implementations should use OS credential/keychain facilities.
 */
export interface SecureSessionStore {
  load(systemId: string): Promise<AuthSession | null>;
  save(systemId: string, session: AuthSession): Promise<void>;
  remove(systemId: string): Promise<void>;
}

export class MemorySecureSessionStore implements SecureSessionStore {
  private readonly sessions = new Map<string, AuthSession>();

  async load(systemId: string): Promise<AuthSession | null> {
    return this.sessions.get(systemId) ?? null;
  }

  async save(systemId: string, session: AuthSession): Promise<void> {
    this.sessions.set(systemId, { ...session });
  }

  async remove(systemId: string): Promise<void> {
    this.sessions.delete(systemId);
  }
}
