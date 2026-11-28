import { expect, it } from 'vitest';
import { exportBatchContext } from './export-batch-context';
import type { RuntimeTask } from '../core/tasks/engine';

const task: RuntimeTask = { id: 'fixture', type: 'data-return', name: '测试', systemId: 'guangdong-hrss', matterId: 'poverty-alleviation-personnel',
  status: 'completed', createdAt: 1, progress: { current: 0, skippedRequests: 5 }, details: {
    dateFilterStatus: 'pending', requestedStartDate: '2026-11-01', requestedEndDate: '2026-11-28',
  }, result: { total: 0, skippedRequests: 1, partial: true } };
it('keeps selected dates without falsely claiming they were applied and prefers persisted progress counts', () => {
  expect(exportBatchContext(task, '测试')).toMatchObject({ dateFiltering: false, startDate: '2026-11-01', endDate: '2026-11-28', skippedRequests: 5, partial: true });
});
it('uses the original Shenzhen date selection instead of guessing from current defaults', () => {
  expect(exportBatchContext({ ...task, systemId: 'shenzhen-integrated-services', details: { returnContext: { filters: { dateType: 'finished' } } } }, '测试')?.dateBasis).toBe('办结日期');
  expect(exportBatchContext({ ...task, systemId: 'shenzhen-integrated-services', details: {} }, '测试')?.dateBasis).toBeUndefined();
});
it('does not attach ledger metadata to official publicity templates', () => {
  expect(exportBatchContext({ ...task, systemId: 'government-info' }, '测试')).toBeUndefined();
});
