export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  engineVersion: string;
  entry: string;
  systems?: string[];
  capabilities: Array<'auth' | 'query' | 'detail' | 'sync' | 'export'>;
}

export function validateManifest(manifest: PluginManifest): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) throw new Error('Invalid plugin id');
  if (!manifest.name.trim()) throw new Error('Plugin name is required');
  if (!/^\d+\.\d+\.\d+/.test(manifest.version)) throw new Error('Plugin version must use semver');
  if (!manifest.entry.trim()) throw new Error('Plugin entry is required');
  if (!manifest.capabilities.includes('auth') || !manifest.capabilities.includes('query')) {
    throw new Error('Business system plugin must support auth and query');
  }
}
