export type SyncChangeType = 'insert' | 'update' | 'unchanged';

export interface SyncChange<T = Record<string, unknown>> {
  type: SyncChangeType;
  key: string;
  current: T;
  previous?: T;
}

export interface SyncSummary<T = Record<string, unknown>> {
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
  changes: SyncChange<T>[];
}

export interface LocalSyncEngine {
  preview<T extends Record<string, unknown>>(
    systemId: string,
    matterId: string,
    uniqueKey: string[],
    rows: T[],
  ): Promise<SyncSummary<T>>;

  commit<T extends Record<string, unknown>>(
    systemId: string,
    matterId: string,
    summary: SyncSummary<T>,
  ): Promise<void>;
}
