import { expect, it } from 'vitest';
import { NodeSqliteDriver } from './database';
import { SqliteLocalRepository } from './sqlite-repository';
import { SqlitePlatformStore } from './platform-store';

it('counts the persisted whole batch even when the exported keyword hides an incomplete process', async () => {
  const db = new NodeSqliteDriver(':memory:');
  try {
    await new SqliteLocalRepository(db).initialize();
    const store = new SqlitePlatformStore(db); await store.initialize();
    for (const id of ['selected-batch', 'other-batch']) {
      await store.save({ id, name: '测试回流', type: 'data-return', systemId: 'shenzhen-integrated-services', matterId: 'fixture',
        status: 'completed', progress: { current: 4, total: 4 }, createdAt: 1,
        result: { total: 3, incompleteHandlingCount: 1 } });
    }
    await store.replaceTaskOutput('selected-batch', 'shenzhen-integrated-services', 'fixture', [
      { recordKey: 'complete', data: { subjectName: '筛选命中单位', handlingRecordStatus: 'collected' } },
      { recordKey: 'incomplete', data: { subjectName: '过程未齐单位', handlingRecordStatus: 'failed', handlingRecords: [{ operator: '历史记录' }] } },
      { recordKey: 'pending', data: { subjectName: '待受理单位', handlingRecordStatus: 'skipped-pending' } },
    ]);
    await store.replaceTaskOutput('other-batch', 'shenzhen-integrated-services', 'fixture', [
      { recordKey: 'other', data: { handlingRecordStatus: 'failed' } },
    ]);
    expect((await store.getTask('selected-batch'))?.result).toBeUndefined();
    expect(await store.taskRowsForExport('selected-batch', '筛选命中单位')).toHaveLength(1);
    expect(await store.taskOutputCompleteness('selected-batch')).toEqual({ batchRowCount: 3, incompleteHandling: 1 });
    expect(await store.taskOutputCompleteness('other-batch')).toEqual({ batchRowCount: 1, incompleteHandling: 1 });
    expect(await store.taskOutputCompleteness('no-such-batch')).toEqual({ batchRowCount: 0, incompleteHandling: 0 });
  } finally { await db.close(); }
});
