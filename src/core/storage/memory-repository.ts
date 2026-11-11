import type { LocalRepository, RecordVersion, StoredRecord } from './types';

export class MemoryLocalRepository implements LocalRepository {
  private readonly records = new Map<string, StoredRecord>();
  private readonly versions = new Map<string, RecordVersion[]>();

  private key(systemId: string, matterId: string, recordKey: string): string {
    return `${systemId}::${matterId}::${recordKey}`;
  }

  async find(systemId: string, matterId: string, recordKey: string): Promise<StoredRecord | null> {
    return this.records.get(this.key(systemId, matterId, recordKey)) ?? null;
  }

  async upsert(record: StoredRecord): Promise<void> {
    this.records.set(this.key(record.systemId, record.matterId, record.recordKey), record);
  }

  async appendVersion(version: RecordVersion): Promise<void> {
    const key = this.key(version.systemId, version.matterId, version.recordKey);
    const current = this.versions.get(key) ?? [];
    current.push(version);
    this.versions.set(key, current);
  }

  async listVersions(systemId: string, matterId: string, recordKey: string): Promise<RecordVersion[]> {
    return [...(this.versions.get(this.key(systemId, matterId, recordKey)) ?? [])]
      .sort((a, b) => b.capturedAt - a.capturedAt);
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    const recordsBefore = new Map(this.records);
    const versionsBefore = new Map(
      [...this.versions.entries()].map(([key, versions]) => [key, [...versions]]),
    );
    try {
      return await work();
    } catch (error) {
      this.records.clear();
      recordsBefore.forEach((value, key) => this.records.set(key, value));
      this.versions.clear();
      versionsBefore.forEach((value, key) => this.versions.set(key, value));
      throw error;
    }
  }
}
