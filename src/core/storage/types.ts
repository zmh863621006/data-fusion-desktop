export interface StoredRecord<T = Record<string, unknown>> {
  systemId: string;
  matterId: string;
  recordKey: string;
  data: T;
  firstSeenAt: number;
  updatedAt: number;
}

export interface RecordVersion<T = Record<string, unknown>> {
  recordKey: string;
  version: number;
  data: T;
  capturedAt: number;
}

export interface LocalRepository {
  find(systemId: string, matterId: string, recordKey: string): Promise<StoredRecord | null>;
  upsert(record: StoredRecord): Promise<void>;
  appendVersion(version: RecordVersion): Promise<void>;
}
