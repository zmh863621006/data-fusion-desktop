import { expect, it } from 'vitest';
import { NodeSqliteDriver } from './database';

it('keeps independent reads and settings writes outside a cancelled asynchronous transaction', async () => {
  const db = new NodeSqliteDriver(':memory:');
  try {
    await db.exec('CREATE TABLE test_data(id TEXT PRIMARY KEY, value TEXT)');
    let release!: () => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const transaction = db.transaction(async () => {
      await db.run('INSERT INTO test_data VALUES(?,?)', ['cancelled', 'private draft']);
      began(); await gate;
      throw new Error('cancel rollback');
    });
    const rejected = expect(transaction).rejects.toThrow('cancel rollback');
    await started;
    const read = db.all<{ id: string }>('SELECT id FROM test_data');
    const setting = db.run('INSERT INTO test_data VALUES(?,?)', ['independent', 'keep this']);
    release(); await rejected;
    expect(await read).toEqual([]);
    await setting;
    expect(await db.all('SELECT id FROM test_data')).toEqual([{ id: 'independent' }]);
  } finally { await db.close(); }
});
