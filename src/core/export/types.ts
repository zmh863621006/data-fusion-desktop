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
}

export interface ExportService {
  export<T extends Record<string, unknown>>(request: ExportRequest<T>): Promise<ExportResult>;
}
