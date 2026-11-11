import type { LocalRepository, StoredRecord } from '../storage/types';
import type { LocalSyncEngine, SyncChange, SyncSummary } from './types';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  if (value === undefined) return 'undefined:';
  if (typeof value === 'number' && Number.isNaN(value)) return 'number:NaN';
  return `${typeof value}:${JSON.stringify(value)}`;
}

export function buildRecordKey(row: Record<string, unknown>, uniqueKey: string[]): string {
  if (!uniqueKey.length) throw new Error('uniqueKey is required');
  const components = uniqueKey.map((key) => {
    const value = row[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing unique key field: ${key}`);
    }
    return [key, stable(value)];
  });
  return JSON.stringify(components);
}

export class DefaultLocalSyncEngine implements LocalSyncEngine {
  constructor(private readonly repository: LocalRepository) {}

  async preview<T extends Record<string, unknown>>(
    systemId: string,
    matterId: string,
    uniqueKey: string[],
    rows: T[],
    mergeRecord?: (incoming: T, previous: T) => T,
  ): Promise<SyncSummary<T>> {
    const changes: SyncChange<T>[] = [];
    const uniqueRows = new Map(rows.map(row => [buildRecordKey(row, uniqueKey), row]));
    for (const incoming of uniqueRows.values()) {
      let row = incoming;
      const key = buildRecordKey(row, uniqueKey);
      const previous = await this.repository.find(systemId, matterId, key);
      if (previous && mergeRecord) {
        row = mergeRecord(incoming, previous.data as T);
        if (buildRecordKey(row, uniqueKey) !== key) throw new Error('Record merge cannot change the unique key');
      }
      if (!previous) {
        changes.push({ type: 'insert', key, current: row });
      } else if (stable(previous.data) === stable(row)) {
        changes.push({ type: 'unchanged', key, current: row, previous: previous.data as T });
      } else {
        changes.push({ type: 'update', key, current: row, previous: previous.data as T });
      }
    }
    return {
      total: changes.length,
      inserted: changes.filter((x) => x.type === 'insert').length,
      updated: changes.filter((x) => x.type === 'update').length,
      unchanged: changes.filter((x) => x.type === 'unchanged').length,
      changes,
    };
  }

  async commit<T extends Record<string, unknown>>(
    systemId: string,
    matterId: string,
    summary: SyncSummary<T>,
  ): Promise<void> {
    await this.repository.transaction(async () => {
      const now = Date.now();
      for (const change of summary.changes) {
        if (change.type === 'unchanged') continue;
        const existing = await this.repository.find(systemId, matterId, change.key);
        const record: StoredRecord<T> = {
          systemId,
          matterId,
          recordKey: change.key,
          data: change.current,
          firstSeenAt: existing?.firstSeenAt ?? now,
          updatedAt: now,
        };
        await this.repository.upsert(record);
        await this.repository.appendVersion({
          systemId,
          matterId,
          recordKey: change.key,
          version: now,
          data: change.current,
          capturedAt: now,
        });
      }
    });
  }
}
