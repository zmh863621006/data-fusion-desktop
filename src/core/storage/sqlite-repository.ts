import type { DatabaseDriver } from './database';
import schemaSql from './schema.sql?raw';
import type { LocalRepository, RecordVersion, StoredRecord } from './types';

interface StoredRecordRow {
  system_id: string;
  matter_id: string;
  record_key: string;
  data_json: string;
  first_seen_at: number;
  updated_at: number;
}

interface RecordVersionRow {
  system_id: string;
  matter_id: string;
  record_key: string;
  version_no: number;
  data_json: string;
  captured_at: number;
}

export class SqliteLocalRepository implements LocalRepository {
  constructor(private readonly database: DatabaseDriver) {}

  async initialize(): Promise<void> {
    await this.database.exec(schemaSql);
  }

  async find(systemId: string, matterId: string, recordKey: string): Promise<StoredRecord | null> {
    const row = await this.database.get<StoredRecordRow>(
      `SELECT system_id, matter_id, record_key, data_json, first_seen_at, updated_at
       FROM local_records WHERE system_id = ? AND matter_id = ? AND record_key = ?`,
      [systemId, matterId, recordKey],
    );
    if (!row) return null;
    return {
      systemId: row.system_id,
      matterId: row.matter_id,
      recordKey: row.record_key,
      data: JSON.parse(row.data_json) as Record<string, unknown>,
      firstSeenAt: row.first_seen_at,
      updatedAt: row.updated_at,
    };
  }

  async upsert(record: StoredRecord): Promise<void> {
    await this.database.run(
      `INSERT INTO local_records(system_id, matter_id, record_key, data_json, first_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(system_id, matter_id, record_key) DO UPDATE SET
         data_json = excluded.data_json,
         updated_at = excluded.updated_at`,
      [
        record.systemId,
        record.matterId,
        record.recordKey,
        JSON.stringify(record.data),
        record.firstSeenAt,
        record.updatedAt,
      ],
    );
  }

  async appendVersion(version: RecordVersion): Promise<void> {
    await this.database.run(
      `INSERT INTO record_versions(system_id, matter_id, record_key, version_no, data_json, captured_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        version.systemId,
        version.matterId,
        version.recordKey,
        version.version,
        JSON.stringify(version.data),
        version.capturedAt,
      ],
    );
  }

  async listVersions(systemId: string, matterId: string, recordKey: string): Promise<RecordVersion[]> {
    const rows = await this.database.all<RecordVersionRow>(
      `SELECT system_id, matter_id, record_key, version_no, data_json, captured_at
       FROM record_versions
       WHERE system_id = ? AND matter_id = ? AND record_key = ?
       ORDER BY captured_at DESC, id DESC`,
      [systemId, matterId, recordKey],
    );
    return rows.map((row) => ({
      systemId: row.system_id,
      matterId: row.matter_id,
      recordKey: row.record_key,
      version: row.version_no,
      data: JSON.parse(row.data_json) as Record<string, unknown>,
      capturedAt: row.captured_at,
    }));
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}
