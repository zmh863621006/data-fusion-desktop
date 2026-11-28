export type ExportFormat = 'xlsx' | 'csv' | 'json';

export interface ExportColumn {
  key: string;
  label: string;
}

export interface ExportRequest<T = Record<string, unknown>> {
  fileName: string;
  format: ExportFormat;
  columns: ExportColumn[];
  rows: T[];
}

export interface ExportResult {
  path: string;
  rowCount: number;
  createdAt: number;
  warningCount?: number;
  missingRequiredCount?: number;
  completenessWarning?: string;
}

/** Collection metadata is separate from business columns and never changes import templates. */
export interface ExportBatchContext {
  taskId: string;
  systemId: string;
  matterId?: string;
  businessName?: string;
  startDate?: string;
  endDate?: string;
  dateBasis?: string;
  dateFiltering?: boolean;
  status?: string;
  partial?: boolean;
  skippedRequests?: number;
  batchRowCount?: number;
  incompleteHandling?: number;
}

export interface ExportService {
  export<T extends Record<string, unknown>>(request: ExportRequest<T>): Promise<ExportResult>;
}
