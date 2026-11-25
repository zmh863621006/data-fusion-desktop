import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { TaskCenterPage, type ReturnBatchSnapshot, type TaskCenterApi } from '../../src/renderer/src/TaskCenterPage';
import type { RuntimeTask } from '../../src/core/tasks/engine';

const systemId = 'guangdong-hrss';
const task = (id: string, matterId: string, status: RuntimeTask['status'], batchId: string): RuntimeTask => ({
  id, type: 'data-return', systemId, matterId, name: `合成测试 / ${matterId}`, status, createdAt: 1_795_000_000_000,
  ...(status === 'completed' || status === 'failed' ? { finishedAt: 1_795_000_010_000 } : {}),
  progress: { current: status === 'completed' ? 1 : 0, total: 1, message: status === 'queued' ? '等待前一人社任务完成' : '合成进度' },
  ...(status === 'failed' ? { error: '合成测试错误，可重新回流' } : {}),
  details: { returnBatchId: batchId, returnBatchOrder: 0, returnBatchSize: 3, startDate: '2026-11-01', endDate: '2026-11-25',
    returnContext: { page: 1, pageSize: 200, filters: { startDate: '2026-11-01', endDate: '2026-11-25' } } },
});
const original = [task('done-other', 'startup-training', 'completed', 'batch-a'), task('waiting', 'unemployment', 'queued', 'batch-a'), task('failed', 'other-matter', 'failed', 'batch-a')];
const single = task('single-task', 'unemployment', 'running', 'batch-a');
const calls = { batch: [] as string[][], page: [] as unknown[], cancel: [] as string[], pending: [] as string[][], retry: [] as string[][] };
const fixture = {
  calls, viewed: null as unknown, failNext: false, holdRetry: false,
  chooseBatch: (_id: string) => {}, resolveLate: () => {}, resolveRetry: () => {},
};
const snapshot = (id: string): ReturnBatchSnapshot => {
  const tasks = id === 'batch-a' ? original : [task(id === 'batch-late' ? 'must-not-render-late' : 'retry-task', 'other-matter', 'queued', id)];
  const counts = { total: tasks.length, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const item of tasks) counts[item.status]++;
  return structuredClone({ batchId: id, systemId, tasks, counts });
};
const api: TaskCenterApi = {
  tasks: {
    page: async query => { calls.page.push(structuredClone(query)); return { rows: structuredClone([single]), total: 1 }; },
    cancel: async id => { calls.cancel.push(id); single.status = 'cancelled'; return true; },
  },
  returnBatches: {
    get: async (system, id) => {
      calls.batch.push([system, id]);
      if (fixture.failNext) { fixture.failNext = false; throw new Error('合成批次读取失败'); }
      if (id === 'batch-late') return new Promise(resolve => { fixture.resolveLate = () => resolve(snapshot(id)); });
      return snapshot(id);
    },
    cancelPending: async (system, id) => {
      calls.pending.push([system, id]); let cancelled = 0;
      for (const item of original) if (item.status === 'queued') { item.status = 'cancelled'; cancelled++; }
      return { cancelled };
    },
    retryFailed: async (system, id) => {
      calls.retry.push([system, id]);
      const result = { batchId: 'batch-retry', taskIds: ['retry-task'], count: 1 };
      if (fixture.holdRetry) return new Promise(resolve => { fixture.resolveRetry = () => resolve(result); });
      return result;
    },
  },
};
Object.defineProperty(window, 'desktopApi', { value: api });
Object.defineProperty(window, 'taskCenterFixture', { value: fixture });
function Harness() {
  const [batchId, setBatchId] = useState('batch-a');
  fixture.chooseBatch = setBatchId;
  return <div style={{ padding: 24 }}><TaskCenterPage systemId={systemId} matterId="unemployment" matterName="失业信息" pageSize={50}
    returnBatchId={batchId} onReturnBatchChange={setBatchId} onViewBatch={() => { throw new Error('Batch rows must use the full task scope'); }}
    onViewTask={item => { fixture.viewed = { systemId: item.systemId, matterId: item.matterId, taskId: item.id }; }} /></div>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
