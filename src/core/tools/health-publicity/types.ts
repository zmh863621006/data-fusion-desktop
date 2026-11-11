export interface HealthPublicityDocument {
  id: string;
  fileName: string;
  kind: '执业登记' | '变更登记' | '注销登记';
  originalName: string;
  sourceText: string;
  sourceData: Record<string, string>;
  data: Record<string, string>;
  evidence: Record<string, string>;
  enterpriseEnrichment?: Record<string, unknown>;
  warnings: string[];
  createdAt: number;
}

export interface HealthPublicityState {
  documents: HealthPublicityDocument[];
  authorityCode: string;
}

export interface HealthImportResult {
  state: HealthPublicityState;
  added: number;
  duplicates: number;
  errors: Array<{ fileName: string; message: string }>;
}
