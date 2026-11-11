import { describe, expect, it } from 'vitest';
import { MemoryLocalRepository } from '../storage/memory-repository';
import { buildRecordKey, DefaultLocalSyncEngine } from './engine';

describe('DefaultLocalSyncEngine', () => {
  it('prevents a matter merge from changing the unique key', async () => {
    const repository = new MemoryLocalRepository();
    const engine = new DefaultLocalSyncEngine(repository);
    await engine.commit('demo', 'orders', await engine.preview('demo', 'orders', ['id'], [{ id: '1' }]));
    await expect(engine.preview('demo', 'orders', ['id'], [{ id: '1' }], () => ({ id: '2' })))
      .rejects.toThrow('cannot change the unique key');
  });
  it('builds collision-safe compound record keys', () => {
    const first = buildRecordKey({ a: 'x|b=y', b: 'z' }, ['a', 'b']);
    const second = buildRecordKey({ a: 'x', b: 'y|b=z' }, ['a', 'b']);

    expect(first).not.toBe(second);
  });

  it('previews inserts, updates and unchanged rows and records versions', async () => {
    const repository = new MemoryLocalRepository();
    const engine = new DefaultLocalSyncEngine(repository);
    const initial = await engine.preview('demo', 'orders', ['id'], [
      { id: '1', amount: 10 },
      { id: '2', amount: 20 },
    ]);
    await engine.commit('demo', 'orders', initial);

    const next = await engine.preview('demo', 'orders', ['id'], [
      { id: '1', amount: 10 },
      { id: '2', amount: 25 },
      { id: '3', amount: 30 },
    ]);

    expect(next).toMatchObject({ total: 3, inserted: 1, updated: 1, unchanged: 1 });
    await engine.commit('demo', 'orders', next);
    const key = buildRecordKey({ id: '2' }, ['id']);
    expect((await repository.find('demo', 'orders', key))?.data).toEqual({ id: '2', amount: 25 });
    expect(await repository.listVersions('demo', 'orders', key)).toHaveLength(2);
  });

  it('rolls back current data and history when a commit fails', async () => {
    class FailingRepository extends MemoryLocalRepository {
      private writes = 0;

      override async appendVersion(version: Parameters<MemoryLocalRepository['appendVersion']>[0]): Promise<void> {
        this.writes += 1;
        if (this.writes === 2) throw new Error('simulated write failure');
        await super.appendVersion(version);
      }
    }

    const repository = new FailingRepository();
    const engine = new DefaultLocalSyncEngine(repository);
    const summary = await engine.preview('demo', 'orders', ['id'], [{ id: '1' }, { id: '2' }]);

    await expect(engine.commit('demo', 'orders', summary)).rejects.toThrow('simulated write failure');
    expect(await repository.find('demo', 'orders', buildRecordKey({ id: '1' }, ['id']))).toBeNull();
    expect(await repository.find('demo', 'orders', buildRecordKey({ id: '2' }, ['id']))).toBeNull();
  });
});

it('deduplicates within a batch and across repeated imports', async () => {
  const repository = new MemoryLocalRepository();
  const engine = new DefaultLocalSyncEngine(repository);
  const rows = [{ id: '1', value: 'old' }, { id: '1', value: 'new' }];
  const summary = await engine.preview('s', 'm', ['id'], rows);
  expect(summary).toMatchObject({ total: 1, inserted: 1 });
  expect(summary.changes[0].current.value).toBe('new');
  await engine.commit('s', 'm', summary);
  expect(await engine.preview('s', 'm', ['id'], rows)).toMatchObject({ total: 1, inserted: 0, unchanged: 1 });
});
