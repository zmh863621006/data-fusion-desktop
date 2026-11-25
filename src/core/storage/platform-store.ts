import type { AuditEvent, AuditLog } from '../audit/types';
import { DEFAULT_APP_SETTINGS, type AppSettings, type SettingsStore } from '../settings/types';
import type { RuntimeTask, TaskStore } from '../tasks/engine';
import type { DatabaseDriver } from './database';
import type { StoredRecord } from './types';

interface TaskRow {
  id: string; type: string; name: string; system_id?: string; matter_id?: string; status: RuntimeTask['status'];
  progress_json: string; created_at: number; started_at?: number; finished_at?: number; error_message?: string;
  metadata_json?: string;
}

function taskFromRow(row: TaskRow): RuntimeTask {
  return { id: row.id, type: row.type, name: row.name, systemId: row.system_id, matterId: row.matter_id,
    status: row.status, progress: JSON.parse(row.progress_json), createdAt: row.created_at,
    startedAt: row.started_at, finishedAt: row.finished_at, error: row.error_message,
    details: row.metadata_json ? JSON.parse(row.metadata_json) : undefined };
}

interface RecordRow {
  system_id: string; matter_id: string; record_key: string; data_json: string; first_seen_at: number; updated_at: number;
}

export interface LocalRecordQuery {
  systemId?: string;
  matterId?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
  /** Added by the runtime, never accepted from IPC input. */
  accessScopes?: Array<{ systemId: string; matterIds?: string[] }>;
}

const MAX_EXPORT_ROWS = 50_000;
type RowPage = { size: number; offset: number };

export interface TaskHistoryQuery {
  systemId?: string;
  matterId?: string;
  taskId?: string;
  completedBatches?: boolean;
  page?: number;
  pageSize?: number;
}

function scopeConditions(query: Pick<LocalRecordQuery, 'systemId' | 'matterId' | 'accessScopes'>) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.accessScopes) {
    const scopes = query.accessScopes.filter(scope => !scope.matterIds || scope.matterIds.length).map(scope => {
      params.push(scope.systemId);
      if (!scope.matterIds) return '(system_id=?)';
      params.push(...scope.matterIds);
      return `(system_id=? AND matter_id IN (${scope.matterIds.map(() => '?').join(',')}))`;
    });
    where.push(scopes.length ? `(${scopes.join(' OR ')})` : '0');
  }
  if (query.systemId) { where.push('system_id = ?'); params.push(query.systemId); }
  if (query.matterId) { where.push('matter_id = ?'); params.push(query.matterId); }
  return { where, params };
}

export interface TaskOutputRow {
  rowNo: number;
  systemId: string;
  matterId: string;
  recordKey: string;
  data: Record<string, unknown>;
}

export class SqlitePlatformStore implements TaskStore, AuditLog, SettingsStore {
  constructor(private readonly database: DatabaseDriver) {}

  async initialize(): Promise<void> {
    const columns = await this.database.all<{ name: string }>('PRAGMA table_info(runtime_tasks)');
    if (!columns.some((column) => column.name === 'metadata_json')) {
      await this.database.exec('ALTER TABLE runtime_tasks ADD COLUMN metadata_json TEXT');
    }
  }

  async recoverInterruptedTasks(): Promise<void> {
    await this.database.run(
      `UPDATE runtime_tasks SET status='failed', finished_at=?, error_message='应用上次退出时任务尚未完成'
       WHERE status IN ('queued','running')`,
      [Date.now()],
    );
  }

  async save(task: RuntimeTask): Promise<void> {
    await this.database.run(
      `INSERT INTO runtime_tasks(id,type,name,system_id,matter_id,status,progress_json,created_at,started_at,finished_at,error_message,metadata_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
       status=excluded.status,progress_json=excluded.progress_json,started_at=excluded.started_at,
       finished_at=excluded.finished_at,error_message=excluded.error_message,metadata_json=excluded.metadata_json`,
      [task.id, task.type, task.name, task.systemId, task.matterId, task.status, JSON.stringify(task.progress),
        task.createdAt, task.startedAt, task.finishedAt, task.error, task.details ? JSON.stringify(task.details) : undefined],
    );
  }

  async listTasks(limit = 100): Promise<RuntimeTask[]> {
    const rows = await this.database.all<TaskRow>('SELECT * FROM runtime_tasks ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map(taskFromRow);
  }

  async getTask(id: string) {
    const row = await this.database.get<TaskRow>('SELECT * FROM runtime_tasks WHERE id=?', [id]);
    return row ? taskFromRow(row) : undefined;
  }

  async taskPage(query: TaskHistoryQuery, accessScopes: NonNullable<LocalRecordQuery['accessScopes']>) {
    const { where, params } = scopeConditions({ ...query, accessScopes });
    if (query.taskId) { where.push('id=?'); params.push(query.taskId); }
    if (query.completedBatches) where.push("type='data-return' AND status='completed'");
    const clause = `WHERE ${where.join(' AND ')}`;
    const pageSize = query.pageSize ?? 20, page = query.page ?? 1;
    const total = await this.database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM runtime_tasks ${clause}`, params);
    const rows = await this.database.all<TaskRow>(
      `SELECT * FROM runtime_tasks ${clause} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]);
    return { rows: rows.map(taskFromRow), total: total?.count ?? 0 };
  }

  /** Prefer the latest batch without skipped requests, including real empties; retain the latest task warning. */
  async successfulSnapshots(systemId: string, matterIds: string[]): Promise<{ records: StoredRecord[]; tasks: RuntimeTask[] }> {
    const records: StoredRecord[] = [];
    const tasks: RuntimeTask[] = [];
    for (const matterId of [...new Set(matterIds)]) {
      const latest = await this.database.all<TaskRow>(
        `SELECT * FROM runtime_tasks WHERE system_id=? AND matter_id=? AND type='data-return'
         AND (id=(SELECT id FROM runtime_tasks WHERE system_id=? AND matter_id=? AND type='data-return' AND status='completed'
                   AND COALESCE(json_extract(progress_json,'$.skippedRequests'),0)=0 ORDER BY finished_at DESC,created_at DESC,rowid DESC LIMIT 1)
           OR id=(SELECT id FROM runtime_tasks WHERE system_id=? AND matter_id=? AND type='data-return' ORDER BY created_at DESC,rowid DESC LIMIT 1))
         ORDER BY created_at DESC,rowid DESC`,
        [systemId, matterId, systemId, matterId, systemId, matterId]);
      for (const row of latest) {
        tasks.push({ id: row.id, type: row.type, name: row.name, systemId, matterId, status: row.status,
          progress: JSON.parse(row.progress_json), createdAt: row.created_at, finishedAt: row.finished_at,
          details: row.metadata_json ? JSON.parse(row.metadata_json) : undefined });
        if (row.status !== 'completed' || JSON.parse(row.progress_json).skippedRequests > 0) continue;
        const rows = await this.database.all<{ record_key: string; data_json: string }>(
          'SELECT record_key,data_json FROM task_output_rows WHERE task_id=? AND system_id=? AND matter_id=? ORDER BY row_no',
          [row.id, systemId, matterId]);
        records.push(...rows.map(record => ({ systemId, matterId, recordKey: record.record_key, data: JSON.parse(record.data_json),
          firstSeenAt: row.created_at, updatedAt: row.finished_at ?? row.created_at })));
      }
      if (!latest.some((row) => row.status === 'completed' && !(JSON.parse(row.progress_json).skippedRequests > 0))) {
        const rows = await this.database.all<RecordRow>(
          'SELECT * FROM local_records WHERE system_id=? AND matter_id=?', [systemId, matterId]);
        records.push(...rows.map((row) => ({ systemId, matterId, recordKey: row.record_key, data: JSON.parse(row.data_json),
          firstSeenAt: row.first_seen_at, updatedAt: row.updated_at })));
      }
    }
    return { records, tasks };
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> { return this.database.transaction(work); }

  async append(event: AuditEvent): Promise<void> {
    await this.database.run(
      'INSERT INTO audit_events(id,event_type,system_id,matter_id,task_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)',
      [event.id, event.type, event.systemId, event.matterId, event.taskId, event.metadata ? JSON.stringify(event.metadata) : undefined, event.createdAt],
    );
  }

  async list(limit = 100): Promise<AuditEvent[]> {
    const rows = await this.database.all<Record<string, unknown>>('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map((row) => ({
      id: String(row.id), type: row.event_type as AuditEvent['type'], systemId: row.system_id as string | undefined,
      matterId: row.matter_id as string | undefined, taskId: row.task_id as string | undefined,
      metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : undefined, createdAt: Number(row.created_at),
    }));
  }

  async get(): Promise<AppSettings> {
    const row = await this.database.get<{ value_json: string }>('SELECT value_json FROM app_settings WHERE key = ?', ['global']);
    return row ? { ...DEFAULT_APP_SETTINGS, ...JSON.parse(row.value_json) } : DEFAULT_APP_SETTINGS;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const value = { ...await this.get(), ...patch, locale: 'zh-CN' as const };
    if (value.defaultPageSize < 10 || value.defaultPageSize > 500) throw new Error('默认分页数量应为 10 至 500');
    if (value.taskConcurrency < 1 || value.taskConcurrency > 10) throw new Error('任务并发数应为 1 至 10');
    await this.database.run(
      `INSERT INTO app_settings(key,value_json,updated_at) VALUES('global',?,?)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
      [JSON.stringify(value), Date.now()],
    );
    return value;
  }

  async listRecords(query: LocalRecordQuery): Promise<{ rows: StoredRecord[]; total: number }> {
    const pageSize = Math.min(500, Math.max(10, query.pageSize ?? DEFAULT_APP_SETTINGS.defaultPageSize));
    const page = Math.max(1, query.page ?? 1);
    return this.selectRecords(query, { size: pageSize, offset: (page - 1) * pageSize });
  }

  async recordsForExport(query: LocalRecordQuery): Promise<StoredRecord[]> {
    return (await this.selectRecords(query)).rows;
  }

  private async selectRecords(query: LocalRecordQuery, page?: RowPage) {
    const { where, params } = scopeConditions(query);
    if (query.keyword) { where.push('(record_key LIKE ? OR data_json LIKE ?)'); params.push(`%${query.keyword}%`, `%${query.keyword}%`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { total, rows } = await this.selectRows<RecordRow>(`local_records ${clause}`, params,
      "COALESCE(json_extract(data_json, '$.xkJdrq'), '') DESC, COALESCE(json_extract(data_json, '$.xkWsh'), '') DESC, updated_at DESC, system_id, matter_id, record_key", page);
    return {
      total,
      rows: rows.map((row) => ({ systemId: row.system_id, matterId: row.matter_id, recordKey: row.record_key,
        data: JSON.parse(row.data_json), firstSeenAt: row.first_seen_at, updatedAt: row.updated_at })),
    };
  }

  async updateRecord(systemId: string, matterId: string, oldRecordKey: string, newRecordKey: string, data: Record<string, unknown>): Promise<StoredRecord> {
    const existing = await this.database.get<RecordRow>(
      'SELECT * FROM local_records WHERE system_id=? AND matter_id=? AND record_key=?',
      [systemId, matterId, oldRecordKey],
    );
    if (!existing) throw new Error('待修改的数据不存在或已经变更');
    const now = Date.now();
    try {
      await this.database.transaction(async () => {
        await this.database.run(
          'UPDATE local_records SET record_key=?, data_json=?, updated_at=? WHERE system_id=? AND matter_id=? AND record_key=?',
          [newRecordKey, JSON.stringify(data), now, systemId, matterId, oldRecordKey],
        );
        if (newRecordKey !== oldRecordKey) {
          await this.database.run(
            'UPDATE record_versions SET record_key=? WHERE system_id=? AND matter_id=? AND record_key=?',
            [newRecordKey, systemId, matterId, oldRecordKey],
          );
        }
        await this.database.run(
          'INSERT INTO record_versions(system_id,matter_id,record_key,version_no,data_json,captured_at) VALUES(?,?,?,?,?,?)',
          [systemId, matterId, newRecordKey, now, JSON.stringify(data), now],
        );
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) throw new Error('修改后的关键字段与已有数据重复');
      throw error;
    }
    return { systemId, matterId, recordKey: newRecordKey, data, firstSeenAt: existing.first_seen_at, updatedAt: now };
  }

  async replaceTaskOutput(
    taskId: string,
    systemId: string,
    matterId: string,
    rows: Array<{ recordKey: string; data: Record<string, unknown> }>,
  ): Promise<void> {
    await this.database.transaction(async () => {
      await this.database.run('DELETE FROM task_output_rows WHERE task_id = ?', [taskId]);
      const uniqueRows = [...new Map(rows.map(row => [row.recordKey, row])).values()];
      for (const [index, row] of uniqueRows.entries()) {
        await this.database.run(
          'INSERT INTO task_output_rows(task_id,row_no,system_id,matter_id,record_key,data_json) VALUES(?,?,?,?,?,?)',
          [taskId, index + 1, systemId, matterId, row.recordKey, JSON.stringify(row.data)],
        );
      }
    });
  }

  /** Compare-and-set prevents a delayed enterprise response from overwriting a user's newer edit. */
  async applyEnterpriseEnrichment(systemId: string, matterId: string, recordKey: string, previous: Record<string, unknown>, next: Record<string, unknown>): Promise<void> {
    const oldJson = JSON.stringify(previous), newJson = JSON.stringify(next);
    if (oldJson === newJson) return;
    await this.database.transaction(async () => {
      const now = Date.now();
      // Keep business ordering stable while paginating; enrichment has its own timestamp and version.
      const updated = await this.database.run('UPDATE local_records SET data_json=? WHERE system_id=? AND matter_id=? AND record_key=? AND data_json=?',
        [newJson, systemId, matterId, recordKey, oldJson]);
      if (updated.changes) await this.database.run('INSERT INTO record_versions(system_id,matter_id,record_key,version_no,data_json,captured_at) VALUES(?,?,?,?,?,?)',
        [systemId, matterId, recordKey, now, newJson, now]);
      await this.database.run('UPDATE task_output_rows SET data_json=? WHERE system_id=? AND matter_id=? AND record_key=? AND data_json=?',
        [newJson, systemId, matterId, recordKey, oldJson]);
    });
  }

  async listTaskOutput(taskId: string, page = 1, pageSize = 100, keyword?: string): Promise<{ rows: TaskOutputRow[]; total: number }> {
    const safePage = Math.max(1, page);
    const safePageSize = Math.min(500, Math.max(10, pageSize));
    return this.selectTaskOutput(taskId, keyword, { size: safePageSize, offset: (safePage - 1) * safePageSize });
  }

  async taskRowsForExport(taskId: string, keyword?: string): Promise<TaskOutputRow[]> {
    return (await this.selectTaskOutput(taskId, keyword)).rows;
  }

  private async selectTaskOutput(taskId: string, keyword?: string, page?: RowPage) {
    const keywordClause = keyword ? ' AND (record_key LIKE ? OR data_json LIKE ?)' : '';
    const keywordParams = keyword ? [`%${keyword}%`, `%${keyword}%`] : [];
    const { total, rows } = await this.selectRows<{
      row_no: number; system_id: string; matter_id: string; record_key: string; data_json: string;
    }>(`task_output_rows WHERE task_id = ?${keywordClause}`, [taskId, ...keywordParams], 'row_no', page);
    return {
      total,
      rows: rows.map((row) => ({
        rowNo: row.row_no,
        systemId: row.system_id,
        matterId: row.matter_id,
        recordKey: row.record_key,
        data: JSON.parse(row.data_json),
      })),
    };
  }

  private async selectRows<T>(source: string, params: unknown[], order: string, page?: RowPage) {
    const count = page ? await this.database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${source}`, params) : undefined;
    // One SELECT freezes both membership and order for an export, even while other tasks write.
    const rows = await this.database.all<T>(`SELECT * FROM ${source} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, page?.size ?? MAX_EXPORT_ROWS + 1, page?.offset ?? 0]);
    if (!page && rows.length > MAX_EXPORT_ROWS) throw new Error('单次导出不能超过 50000 条，请缩小筛选范围');
    return { total: count?.count ?? rows.length, rows };
  }
}
