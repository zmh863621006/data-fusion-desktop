import type { RuntimeTask } from '../tasks/engine';

export interface ReturnBatchInput {
  matterIds: string[];
  startDate: string;
  endDate: string;
  filtersByMatter?: Record<string, Record<string, unknown>>;
}
export interface ReturnBatchCreated { batchId: string; taskIds: string[]; count: number }
export interface ReturnBatchState {
  batchId: string;
  systemId: string;
  tasks: RuntimeTask[];
  counts: { queued: number; running: number; completed: number; failed: number; cancelled: number; total: number };
}
