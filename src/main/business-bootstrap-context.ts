export interface ManagedBackend {
  origin: string;
  revision: number;
}
export interface BusinessPreparation {
  version: string;
  offline: boolean;
}
export interface BusinessBootstrapContext {
  schema: 1;
  primaryInstance: true;
  profilePath: string;
  shellVersion: string;
  version: string;
  root: string;
  backend: ManagedBackend;
  offline: boolean;
  check(progress?: (value: { phase?: string; received?: number; downloaded?: number; total?: number; version?: string }) => void): Promise<BusinessPreparation>;
  cancelCheck?(): void;
  ready(): void;
  failed(code: string): void;
}

/** Created only by the installed, immutable bootstrap, before business require(). */
export function businessBootstrapContext(): BusinessBootstrapContext | undefined {
  const value = (globalThis as typeof globalThis & { __DATA_FUSION_BUSINESS_BOOTSTRAP__?: BusinessBootstrapContext }).__DATA_FUSION_BUSINESS_BOOTSTRAP__;
  return value?.schema === 1 ? value : undefined;
}
