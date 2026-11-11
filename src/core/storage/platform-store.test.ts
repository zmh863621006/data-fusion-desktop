import { expect, it } from 'vitest';
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
