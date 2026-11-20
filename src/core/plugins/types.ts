import type { AuthAdapter, SessionState, SessionRecovery } from '../session/types';
import type { BusinessMatter } from '../query/types';

export interface BusinessSystemPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Selects the system-specific renderer shell; systems opt in instead of inheriting another system's menus. */
  workspaceMode?: 'standard' | 'return-ledger' | 'list-ledger';
  supportsCredentialConfiguration?: boolean;
  auth: AuthAdapter;
  sessionRecovery?: SessionRecovery;
  /** Embedded opens the source website in the app; automatic delegates login to the adapter. */
  loginMode?: 'embedded' | 'automatic';
  loginPage?: {
    url: string;
    partition: string;
    allowedOrigin: string;
    /** Explicit SSO destinations only; never arbitrary redirects. */
    additionalAllowedOrigins?: string[];
    credentialPaths?: string[];
    /** Main-process-only capture of named portal keys, never renderer metadata. */
    browserAuth?: { localStorageKeys: string[]; sessionStorageKeys?: string[]; accept(values: Record<string, string>): void };
    /** Explicit selectors for legacy login forms with nonstandard field names. */
    credentialFields?: { account: string; password: string };
    /** Opt in when returning to the configured portal login path confirms sign-out. */
    onLoginPageChange?: (visible: boolean) => void;
    onNavigate?: (url: string) => void;
  };
  matters: BusinessMatter[];

  initialize(): Promise<void>;
  getSessionState(options?: { force?: boolean }): Promise<SessionState>;
}

export interface PluginRegistry {
  register(plugin: BusinessSystemPlugin): void;
  unregister(id: string): boolean;
  get(id: string): BusinessSystemPlugin | undefined;
  list(): BusinessSystemPlugin[];
}

export function sourceOrigins(page: NonNullable<BusinessSystemPlugin['loginPage']>): string[] {
  return [...new Set([page.allowedOrigin, ...(page.additionalAllowedOrigins ?? [])])].filter((origin) => {
    try { const url = new URL(origin); return /^https?:$/.test(url.protocol) && url.origin === origin; } catch { return false; }
  });
}

export function validatePluginContract(plugin: BusinessSystemPlugin): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin.id)) throw new Error(`Invalid plugin id: ${plugin.id}`);
  if (!plugin.name.trim() || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(plugin.version)) {
    throw new Error(`Invalid plugin metadata: ${plugin.id}`);
  }
  if (!plugin.auth || typeof plugin.initialize !== 'function' || typeof plugin.getSessionState !== 'function') {
    throw new Error(`Incomplete plugin contract: ${plugin.id}`);
  }
  if (plugin.loginMode !== 'automatic' && (!plugin.loginPage?.url || !plugin.loginPage.partition || !plugin.loginPage.allowedOrigin)) {
    throw new Error(`Incomplete login page contract: ${plugin.id}`);
  }
  const matterIds = new Set<string>();
  for (const matter of plugin.matters) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(matter.id) || matterIds.has(matter.id)) {
      throw new Error(`Invalid or duplicate matter id: ${matter.id}`);
    }
    matterIds.add(matter.id);
    if (!matter.uniqueKey.length || new Set(matter.uniqueKey).size !== matter.uniqueKey.length) {
      throw new Error(`Invalid unique key for matter: ${matter.id}`);
    }
    const fieldKeys = matter.querySchema.map((field) => field.key);
    if (fieldKeys.some((key) => !key.trim()) || new Set(fieldKeys).size !== fieldKeys.length) {
      throw new Error(`Invalid query schema for matter: ${matter.id}`);
    }
  }
}

export class DefaultPluginRegistry implements PluginRegistry {
  private readonly plugins = new Map<string, BusinessSystemPlugin>();

  register(plugin: BusinessSystemPlugin): void {
    validatePluginContract(plugin);
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin already registered: ${plugin.id}`);
    }
    this.plugins.set(plugin.id, plugin);
  }

  get(id: string): BusinessSystemPlugin | undefined {
    return this.plugins.get(id);
  }

  unregister(id: string): boolean {
    return this.plugins.delete(id);
  }

  list(): BusinessSystemPlugin[] {
    return [...this.plugins.values()];
  }
}
