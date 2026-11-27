export const HOUSING_SYSTEM_ID = 'shenzhen-housing-rental';
export const HOUSING_MATTER_ID = 'house-code-binding';
export interface HousingImportIssue { rowNumber: number; message: string }
export interface HousingImportPreview {
  importId: string; fileName: string; totalRows: number; validCount: number; duplicateCount: number;
  codes: Array<{ rowNumber: number; code: string }>; issues: HousingImportIssue[];
}
export type HousingJobPhase = 'queued' | 'running' | 'waiting-login' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type HousingRowStatus = 'pending' | 'binding' | 'succeeded' | 'already-bound' | 'failed' | 'unknown';
export interface HousingBindingRow {
  rowNumber: number; code: string; status: HousingRowStatus; message: string; updatedAt: number;
}
export interface HousingBindingJob {
  id: string; taskId: string | null; acceptanceNumber: string; certificateNumber: string; fileName: string;
  phase: HousingJobPhase; total: number; succeeded: number; skipped: number; failed: number; pending: number;
  createdAt: number; updatedAt: number; error: string | null; parentJobId: string | null;
}
export interface HousingBindingState { jobs: HousingBindingJob[]; total: number }
export interface HousingBindingDetail { job: HousingBindingJob; rows: HousingBindingRow[]; total: number }
export interface HousingBindingCreate { acceptanceNumber: string; certificateNumber: string; importId: string }
export interface HousingBindingApi {
  importWorkbook(): Promise<HousingImportPreview | null>;
  create(input: HousingBindingCreate): Promise<HousingBindingJob>;
  state(page?: number): Promise<HousingBindingState>;
  detail(jobId: string, page?: number): Promise<HousingBindingDetail>;
  cancel(jobId: string): Promise<HousingBindingJob>;
  retry(jobId: string): Promise<HousingBindingJob>;
  template(): Promise<{ fileName: string; directory: string }>;
  openTemplateFolder(): Promise<boolean>;
}
