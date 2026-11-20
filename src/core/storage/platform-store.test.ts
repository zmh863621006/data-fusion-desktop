import { expect, it } from 'vitest';
import { parseLocalRecordQuery } from '../ipc/validation';
import { NodeSqliteDriver } from './database';
import { SqlitePlatformStore } from './platform-store';
it('orders ledger by decision date then document number, independently of update time', async () => {
  const db = new NodeSqliteDriver(':memory:');
  try {
    await db.exec('CREATE TABLE local_records(system_id TEXT,matter_id TEXT,record_key TEXT,data_json TEXT,first_seen_at INTEGER,updated_at INTEGER)');
    for (const [key,date,num,updated] of [['old','2026-10-13','2026009999',999],['a','2026-10-14','2026006756',1],['b','2026-10-14','2026006757',1]]) {
      await db.run('INSERT INTO local_records VALUES(?,?,?,?,0,?)',['s','m',key,JSON.stringify({xkJdrq:date,xkWsh:num}),updated]);
    }
    const store = new SqlitePlatformStore(db);
    const result = await store.listRecords({systemId:'s',matterId:'m'});
    expect(result.rows.map(row => row.recordKey)).toEqual(['b','a','old']);
    expect(result.total).toBe(3);
  } finally { await db.close(); }
});

it('returns complete 500-row ledger pages through the IPC query limits', async () => {
  const db = new NodeSqliteDriver(':memory:');
  try {
    await db.exec(`CREATE TABLE local_records(system_id TEXT,matter_id TEXT,record_key TEXT,data_json TEXT,first_seen_at INTEGER,updated_at INTEGER);
      WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<501)
      INSERT INTO local_records SELECT 's','m',printf('%04d',n),'{}',0,0 FROM numbers`);
    const store = new SqlitePlatformStore(db);
    const first = await store.listRecords(parseLocalRecordQuery({ page: 1, pageSize: 500 }));
    const last = await store.listRecords(parseLocalRecordQuery({ page: 2, pageSize: 500 }));
    expect(first.total).toBe(501);
    expect(first.rows).toHaveLength(500);
    expect(first.rows[499].recordKey).toBe('0500');
    expect(last.rows.map(row => row.recordKey)).toEqual(['0501']);
  } finally { await db.close(); }
});
