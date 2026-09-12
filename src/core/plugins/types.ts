import type { AuthAdapter, SessionState } from '../session/types';
import type { BusinessMatter } from '../query/types';

export interface BusinessSystemPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  auth: AuthAdapter;
  matters: BusinessMatter[];

  initialize(): Promise<void>;
  getSessionState(): Promise<SessionState>;
}

export interface PluginRegistry {
  register(plugin: BusinessSystemPlugin): void;
  get(id: string): BusinessSystemPlugin | undefined;
  list(): BusinessSystemPlugin[];
}

export class DefaultPluginRegistry implements PluginRegistry {
  private readonly plugins = new Map<string, BusinessSystemPlugin>();

  register(plugin: BusinessSystemPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin already registered: ${plugin.id}`);
    }
    this.plugins.set(plugin.id, plugin);
  }

  get(id: string): BusinessSystemPlugin | undefined {
    return this.plugins.get(id);
  }

  list(): BusinessSystemPlugin[] {
    return [...this.plugins.values()];
  }
}
