import type { OneWindowSchedule } from './scheduler';

export interface OneWindowFilters {
  dateType: 'all' | 'received' | 'finished';
  startDate: string;
  endDate: string;
  state: string;
}

export interface OneWindowPlan {
  matterId: string;
  schedule: OneWindowSchedule;
  filters: OneWindowFilters;
  nextRunAt: number | null;
  lastRunAt: number | null;
}

export interface OneWindowBatch {
  taskId: string;
  matterId: string;
  createdAt: number;
  total: number;
  partialCount: number;
  fileName: string;
  filePath: string;
  uploadStatus: 'pending' | 'uploading' | 'uploaded' | 'failed';
  uploadError: string | null;
  uploadedAt: number | null;
  objectKey: string | null;
}

export interface OneWindowState {
  plan: OneWindowPlan;
  running: boolean;
  batches: OneWindowBatch[];
  batchTotal: number;
  sessionStatus: string;
}
