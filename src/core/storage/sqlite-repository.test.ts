import { afterEach, describe, expect, it } from 'vitest';
import { buildRecordKey, DefaultLocalSyncEngine } from '../sync/engine';
import { NodeSqliteDriver } from './database';
import { SqliteLocalRepository } from './sqlite-repository';
import { SqlitePlatformStore } from './platform-store';

describe('SqliteLocalRepository', () => {
  const drivers: NodeSqliteDriver[] = [];
  afterEach(async () => {
    await Promise.all(drivers.splice(0).map((driver) => driver.close()));
  });

  it('persists current records and their history', async () => {
    const driver = new NodeSqliteDriver(':memory:');
    drivers.push(driver);
    const repository = new SqliteLocalRepository(driver);
    await repository.initialize();
    const engine = new DefaultLocalSyncEngine(repository);

    await engine.commit('demo', 'orders', await engine.preview('demo', 'orders', ['id'], [{ id: '1', amount: 10 }]));
    await engine.commit('demo', 'orders', await engine.preview('demo', 'orders', ['id'], [{ id: '1', amount: 11 }]));

    const key = buildRecordKey({ id: '1' }, ['id']);
    expect((await repository.find('demo', 'orders', key))?.data).toEqual({ id: '1', amount: 11 });
    expect(await repository.listVersions('demo', 'orders', key)).toHaveLength(2);
  });

  it('rolls back a failed database transaction', async () => {
    const driver = new NodeSqliteDriver(':memory:');
    drivers.push(driver);
    const repository = new SqliteLocalRepository(driver);
    await repository.initialize();

    await expect(repository.transaction(async () => {
      await repository.upsert({
        systemId: 'demo', matterId: 'orders', recordKey: '1', data: { id: 1 },
        firstSeenAt: 1, updatedAt: 1,
      });
      throw new Error('rollback');
    })).rejects.toThrow('rollback');

    expect(await repository.find('demo', 'orders', '1')).toBeNull();
  });

  it('serializes concurrent top-level transactions', async () => {
    const driver = new NodeSqliteDriver(':memory:');
    drivers.push(driver);
    await driver.exec('CREATE TABLE events (value TEXT NOT NULL)');
    const order: string[] = [];

    const first = driver.transaction(async () => {
      order.push('first-start');
      await Promise.resolve();
      await driver.run('INSERT INTO events(value) VALUES (?)', ['first']);
      order.push('first-end');
    });
    const second = driver.transaction(async () => {
      order.push('second-start');
      await driver.run('INSERT INTO events(value) VALUES (?)', ['second']);
      order.push('second-end');
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
    expect(await driver.all<{ value: string }>('SELECT value FROM events')).toEqual([
      { value: 'first' },
      { value: 'second' },
    ]);
  });

  it('keeps an immutable row set for each completed return task', async () => {
    const driver = new NodeSqliteDriver(':memory:');
    drivers.push(driver);
    const repository = new SqliteLocalRepository(driver);
    await repository.initialize();
    const store = new SqlitePlatformStore(driver);
    await store.save({
      id: 'task-1', type: 'data-return', name: '双公示回流', systemId: 'government-info',
      matterId: 'double-publicity-return', status: 'completed', progress: { current: 4, total: 4 },
      createdAt: 1, finishedAt: 2,
    });

    await store.replaceTaskOutput('task-1', 'government-info', 'double-publicity-return', [
      { recordKey: 'A', data: { cityLsh: 'A', department: '水务' } },
      { recordKey: 'B', data: { cityLsh: 'B', department: '城管' } },
    ]);

    const output = await store.listTaskOutput('task-1');
    expect(output.total).toBe(2);
    expect(output.rows.map((row) => row.data.cityLsh)).toEqual(['A', 'B']);
    const filtered = await store.listTaskOutput('task-1', 1, 50, '城管');
    expect(filtered.total).toBe(1);
    expect(filtered.rows[0].rowNo).toBe(2);
    expect(filtered.rows[0].data.cityLsh).toBe('B');
  });

  it('persists task return periods and keeps record history after an edited key changes', async () => {
    const driver = new NodeSqliteDriver(':memory:');
    drivers.push(driver);
    const repository = new SqliteLocalRepository(driver);
    await repository.initialize();
    const store = new SqlitePlatformStore(driver);
    await store.initialize();
    await store.save({
      id: 'task-period', type: 'data-return', name: '道路运输从业人员回流', systemId: 'transport-practitioner',
      matterId: 'road-practitioner-return', status: 'completed', progress: { current: 1, total: 1 },
      details: { startDate: '2026-09-14', endDate: '2026-09-18' }, createdAt: 1, finishedAt: 2,
    });
    expect((await store.listTasks())[0].details).toEqual({ startDate: '2026-09-14', endDate: '2026-09-18' });

    await repository.upsert({
      systemId: 'transport-practitioner', matterId: 'road-practitioner-return', recordKey: 'old-key',
      data: { xkXdrZjhm: 'old' }, firstSeenAt: 1, updatedAt: 1,
    });
    await repository.appendVersion({
      systemId: 'transport-practitioner', matterId: 'road-practitioner-return', recordKey: 'old-key',
      version: 1, data: { xkXdrZjhm: 'old' }, capturedAt: 1,
    });
    await store.updateRecord('transport-practitioner', 'road-practitioner-return', 'old-key', 'new-key', { xkXdrZjhm: 'new' });

    expect(await repository.find('transport-practitioner', 'road-practitioner-return', 'old-key')).toBeNull();
    expect((await repository.find('transport-practitioner', 'road-practitioner-return', 'new-key'))?.data).toEqual({ xkXdrZjhm: 'new' });
    expect(await repository.listVersions('transport-practitioner', 'road-practitioner-return', 'new-key')).toHaveLength(2);
  });
});
