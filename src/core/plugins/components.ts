/** Public metadata only. Component discovery never probes a remote login session. */
export interface ComponentSummary {
  id: string;
  kind: 'system' | 'tool';
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  authorized: boolean;
  workspaceMode?: 'standard' | 'return-ledger' | 'list-ledger';
  supportsCredentialConfiguration?: boolean;
}
