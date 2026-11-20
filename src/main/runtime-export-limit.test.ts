import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));
import { NodeSqliteDriver } from '../core/storage/database';
import { SqliteLocalRepository } from '../core/storage/sqlite-repository';
import { SqlitePlatformStore } from '../core/storage/platform-store';
import type { StoredRecord } from '../core/storage/types';
import { AppRuntime } from './runtime';

const query = { systemId: 'fixture', matterId: 'fixture-matter' };
const task = { ...query, id: 'batch', type: 'data-return', name: '导出测试', status: 'completed' as const, createdAt: 1, progress: { current: 1 } };
let db: NodeSqliteDriver;
let store: SqlitePlatformStore;
let runtime: AppRuntime;

beforeEach(async () => {
  db = new NodeSqliteDriver(':memory:');
  await new SqliteLocalRepository(db).initialize();
  store = new SqlitePlatformStore(db);
  await store.initialize();
  await store.save(task);
  runtime = new AppRuntime();
  Object.assign(runtime, { platformStore: store, currentGrant: async () => ({
    allowExport: true, allowedSystems: [query.systemId], expiresAt: Date.now() + 60_000,
  }) });
});
afterEach(() => db.close());

async function insertRows(source: string, count: number) {
  const sequence = 'WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n < ?)';
  if (source === 'ledger') {
    await db.run(sequence + ' INSERT INTO local_records(system_id,matter_id,record_key,data_json,first_seen_at,updated_at)' +
      " SELECT ?,?,printf('%05d',n),'{}',1,1 FROM sequence", [count, query.systemId, query.matterId]);
  } else {
    await db.run(sequence + ' INSERT INTO task_output_rows(task_id,row_no,system_id,matter_id,record_key,data_json)' +
      " SELECT ?,n,?,?,printf('%05d',n),'{}' FROM sequence", [count, task.id, query.systemId, query.matterId]);
  }
}

describe.each(['batch', 'ledger'])('%s export limit', source => {
  it.each([50_000, 50_001])('checks the full filtered count of %i before writing', async total => {
    await insertRows(source, total);
    const exportRecords = vi.fn(async (rows: StoredRecord[]) => ({ count: rows.length, last: rows.at(-1)?.recordKey }));
    Object.assign(runtime, { exportRecords });
    const exportData = (keyword?: string) => source === 'ledger'
      ? runtime.exportLocalRecords({ ...query, keyword }, undefined, 'xlsx') : runtime.exportTaskOutput(task.id, undefined, keyword);
    if (total === 50_000) {
      await expect(exportData()).resolves.toEqual({ count: total, last: '50000' });
    } else {
      await expect(exportData()).rejects.toThrow('不能超过 50000 条');
      expect(exportRecords).not.toHaveBeenCalled();
      await expect(exportData('50001')).resolves.toEqual({ count: 1, last: '50001' });
    }
  });
});

it('exports every ledger key exactly once while a later record moves to the top of the list', async () => {
  await insertRows('ledger', 201);
  const read = db.all.bind(db);
  let reordered = false;
  vi.spyOn(db, 'all').mockImplementation(async <T>(sql: string, params?: unknown[]) => {
    const rows = await read<T>(sql, params);
    if (!reordered && sql.startsWith('SELECT * FROM local_records')) {
      reordered = true;
      await store.updateRecord(query.systemId, query.matterId, '00201', '00201', { xkWsh: '999' });
    }
    return rows;
  });
  const directory = await mkdtemp(join(tmpdir(), 'fusion-export-snapshot-'));
  try {
    const path = join(directory, 'ledger.xlsx');
    const exported = await runtime.exportLocalRecords(query, path, 'xlsx');
    expect(exported?.rowCount).toBe(201);
    const workbook = await new ExcelJS.Workbook().xlsx.readFile(path);
    const keys = workbook.worksheets[0].getColumn(3).values.slice(2);
    expect(reordered).toBe(true);
    expect(keys).toEqual(Array.from({ length: 201 }, (_, index) => String(index + 1).padStart(5, '0')));
    expect((await store.listRecords({ ...query, pageSize: 10 })).rows[0].recordKey).toBe('00201');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
