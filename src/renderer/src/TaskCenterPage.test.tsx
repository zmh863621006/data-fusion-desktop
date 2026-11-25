import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RuntimeTask } from '../../core/tasks/engine';
import { loadTaskCenter, returnBatchPeriod, returnTaskPeriod, ReturnBatchSummary, type ReturnBatchSnapshot, type TaskCenterApi } from './TaskCenterPage';

const task = (id: string, matterId: string): RuntimeTask => ({ id, name: matterId, type: 'data-return', systemId: 'guangdong-hrss', matterId,
  status: 'queued', progress: { current: 0 }, createdAt: 1, details: { returnBatchId: 'batch-a',
    returnContext: { page: 1, pageSize: 200, filters: { startDate: '2026-11-01', endDate: '2026-11-25' } } } });
const batch = (): ReturnBatchSnapshot => ({ batchId: 'batch-a', systemId: 'guangdong-hrss', tasks: [task('a', 'unemployment'), task('b', 'startup-training')],
  counts: { total: 2, queued: 2, running: 0, completed: 0, failed: 0, cancelled: 0 } });
const api = (snapshot = batch()) => ({ tasks: { page: vi.fn(async () => ({ rows: [task('a', 'unemployment')], total: 1 })), cancel: vi.fn(async () => true) },
  returnBatches: { get: vi.fn(async () => snapshot), cancelPending: vi.fn(async () => ({ cancelled: 0 })), retryFailed: vi.fn(async () => ({ batchId: 'retry-batch', taskIds: ['new-task'], count: 1 })) } });

describe('task centre scope and date semantics', () => {
  it('reads every matter in the selected batch instead of applying the currently browsed matter filter', async () => {
    const fixture = api();
    const result = await loadTaskCenter(fixture as TaskCenterApi, { systemId: 'guangdong-hrss', matterId: 'unemployment', page: 3, pageSize: 50, batchId: 'batch-a' });
    expect(result.rows.map(row => row.matterId)).toEqual(['unemployment', 'startup-training']);
    expect(fixture.returnBatches.get).toHaveBeenCalledExactlyOnceWith('guangdong-hrss', 'batch-a');
    expect(fixture.tasks.page).not.toHaveBeenCalled();
  });
  it('keeps the existing single-matter history request and pagination intact', async () => {
    const fixture = api();
    expect(await loadTaskCenter(fixture as TaskCenterApi, { systemId: 'guangdong-hrss', matterId: 'unemployment', page: 3, pageSize: 50 })).toMatchObject({ total: 1, batch: null });
    expect(fixture.tasks.page).toHaveBeenCalledExactlyOnceWith({ systemId: 'guangdong-hrss', matterId: 'unemployment', page: 3, pageSize: 50 });
    expect(fixture.returnBatches.get).not.toHaveBeenCalled();
  });
  it.each(['system', 'batch', 'row'])('rejects a mismatched %s response rather than displaying another scope', async mode => {
    const snapshot = batch();
    if (mode === 'system') snapshot.systemId = 'other';
    if (mode === 'batch') snapshot.batchId = 'other';
    if (mode === 'row') snapshot.tasks[1].systemId = 'other';
    await expect(loadTaskCenter(api(snapshot) as TaskCenterApi, { systemId: 'guangdong-hrss', matterId: 'unemployment', page: 1, pageSize: 50, batchId: 'batch-a' })).rejects.toThrow('不匹配');
  });
  it('uses the frozen batch dates while preserving a non-date-filtered matter’s own task label', () => {
    const snapshot = batch();
    expect(returnBatchPeriod(snapshot)).toBe('2026-11-01 至 2026-11-25');
    const poverty = { ...task('p', 'poverty-alleviation-personnel'), details: { dateFilterStatus: 'pending', dateScope: 'original-list-no-date', requestedStartDate: '2026-11-01', requestedEndDate: '2026-11-25' } };
    expect(returnTaskPeriod(poverty)).toBe('按原列表条件回流（未按日期筛选）');
    expect(returnBatchPeriod(null)).toBe('以各业务任务保存的条件为准');
  });
  it('renders confirmed zero counts alongside failures without merging their state labels', () => {
    const snapshot = batch(); snapshot.counts = { total: 2, queued: 0, running: 0, completed: 1, failed: 1, cancelled: 0 };
    const html = renderToStaticMarkup(<ReturnBatchSummary batch={snapshot} />);
    expect(html).toContain('aria-label="本批次任务统计"');
    for (const label of ['业务总数', '等待', '执行中', '完成', '失败', '取消']) expect(html).toContain(`<dt>${label}</dt>`);
    expect(html).toContain('has-failures'); expect(html).toContain('<dd>0</dd>');
  });
});
