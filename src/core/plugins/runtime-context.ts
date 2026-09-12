import type { AuditLog } from '../audit/types';
import type { RequestPolicy } from '../network/request-policy';
import type { SecureSessionStore } from '../session/secure-session-store';

export interface PluginRuntimeContext {
  readonly pluginId: string;
  readonly sessions: SecureSessionStore;
  readonly audit: AuditLog;
  readonly requestPolicy: RequestPolicy;
  now(): number;
}

/**
 * Plugins should receive capabilities through this context instead of importing
 * arbitrary application internals. This keeps plugin boundaries testable.
 */
export function createPluginRuntimeContext(input: PluginRuntimeContext): PluginRuntimeContext {
  return Object.freeze({ ...input });
}
