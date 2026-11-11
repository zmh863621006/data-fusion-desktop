import { beforeEach, afterEach, expect, it } from 'vitest';
import { NodeSqliteDriver } from '../storage/database';
import { PractitionerNumbers, ROAD, TAXI } from './practitioner-numbers';
let db: NodeSqliteDriver;
let numbers: PractitionerNumbers;
beforeEach(async () => {
  db = new NodeSqliteDriver(':memory:');
  await db.exec('CREATE TABLE local_records(system_id TEXT,matter_id TEXT,record_key TEXT,data_json TEXT)');
  numbers = new PractitionerNumbers(db); await numbers.initialize();
});
afterEach(async () => { await db.close(); });
const row = (id = 'A') => ({ xkXdrZjhm: id, xkJdrq: '2026-10-14', xkXdrMc: '测试人员' });
const assigned = (matter = ROAD, id = 'A') => numbers.withNumbers(matter, [row(id)], async rows => String(rows[0].xkWsh));
it('seeds both sequences and keeps zero padding', async () => {
  expect(await assigned()).toBe('惠交从（许可）字（2026）00010963号');
  expect(await assigned(TAXI)).toBe('2026006756');
});
it('persists config across service reconstruction without resetting seeds', async () => {
  const config = (await numbers.list(2026))[0];
  await numbers.save({ ...config, latestNumber: '惠交从（许可）字（2026）00012000号' });
  const reopened = new PractitionerNumbers(db); await reopened.initialize();
  expect((await reopened.list(2026))[0].latestNumber).toContain('00012000');
  expect(await assigned()).toContain('00012001');
  await expect(numbers.save(config)).rejects.toThrow('编号已更新');
});
it('reuses existing assignment on repeated queries', async () => {
  expect(await assigned()).toBe(await assigned());
  expect(await assigned(ROAD, 'B')).toContain('00010964');
});
it('rolls back allocation if local data saving fails', async () => {
  await expect(numbers.withNumbers(ROAD, [row()], async () => { throw new Error('保存失败'); })).rejects.toThrow('保存失败');
  expect(await assigned()).toContain('00010963');
});
it('serializes concurrent allocations and repeated queries', async () => {
  const result = await Promise.all([assigned(), assigned(), assigned(ROAD, 'B')]);
  expect(result[0]).toBe(result[1]); expect(result[2]).toContain('00010964');
});
it('rejects resetting into used numbers and unknown year', async () => {
  await assigned();
  const config = (await numbers.list(2026))[0];
  await numbers.save({ ...config, latestNumber: '惠交从（许可）字（2026）00010962号' });
  await expect(assigned(ROAD, 'B')).rejects.toThrow('已被使用');
  await expect(numbers.withNumbers(ROAD, [{ ...row(), xkJdrq: '2027-01-01' }], async () => null)).rejects.toThrow('尚未配置');
});
