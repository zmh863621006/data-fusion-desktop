import { useEffect, useRef, useState } from 'react';
import type { RuntimeTask } from '../../core/tasks/engine';
import type { ReturnBatchState } from '../../core/query/return-batches';
import { hrssTaskDateLabel } from '../../core/hrss/date-filters';
import { taskProgressPercent, taskStatusLabel } from './ui-format';
import './TaskCenterPage.css';

export type ReturnBatchCounts = ReturnBatchState['counts'];
export interface ReturnBatchSnapshot extends ReturnBatchState {
  startDate?: string;
  endDate?: string;
}

export interface TaskCenterApi {
  tasks: {
    page(query: { systemId: string; matterId: string; page: number; pageSize: number }): Promise<{ rows: RuntimeTask[]; total: number }>;
    cancel(id: string): Promise<boolean>;
  };
  returnBatches: {
    get(systemId: string, batchId: string): Promise<ReturnBatchSnapshot>;
    cancelPending(systemId: string, batchId: string): Promise<{ cancelled: number }>;
    retryFailed(systemId: string, batchId: string): Promise<{ batchId: string; taskIds: string[]; count: number }>;
  };
}

export interface TaskCenterProps {
  pageSize: number;
  systemId: string;
  matterId: string;
  matterName?: string;
  onViewBatch: (taskId: string) => void;
  onViewTask?: (task: RuntimeTask) => void;
  returnBatchId?: string;
  onReturnBatchChange?: (batchId: string) => void;
}

/** Batch reads intentionally omit matterId: a batch can contain several independent matters. */
export async function loadTaskCenter(api: TaskCenterApi, input: {
  systemId: string; matterId: string; page: number; pageSize: number; batchId?: string;
}): Promise<{ rows: RuntimeTask[]; total: number; batch: ReturnBatchSnapshot | null }> {
  if (input.batchId) {
    const batch = await api.returnBatches.get(input.systemId, input.batchId);
    if (batch.systemId !== input.systemId || batch.batchId !== input.batchId
      || batch.tasks.some(task => task.systemId !== input.systemId || task.details?.returnBatchId !== input.batchId)) {
      throw new Error('批次与当前系统不匹配，请重新选择。');
    }
    return { rows: batch.tasks, total: batch.tasks.length, batch };
  }
  const result = await api.tasks.page({ systemId: input.systemId, matterId: input.matterId, page: input.page, pageSize: input.pageSize });
  return { ...result, batch: null };
}

export function returnTaskPeriod(task: RuntimeTask, fallbackSystemId?: string): string {
  if ((task.systemId ?? fallbackSystemId) === 'guangdong-hrss') return hrssTaskDateLabel(task.details);
  const start = typeof task.details?.startDate === 'string' ? task.details.startDate : '';
  const end = typeof task.details?.endDate === 'string' ? task.details.endDate : '';
  return start || end ? `${start || '—'} 至 ${end || '—'}` : '—';
}

export function returnBatchPeriod(batch: ReturnBatchSnapshot | null): string {
  const context = batch?.tasks[0]?.details?.returnContext as { filters?: Record<string, unknown> } | undefined;
  const start = batch?.startDate ?? context?.filters?.startDate;
  const end = batch?.endDate ?? context?.filters?.endDate;
  return typeof start === 'string' && typeof end === 'string' ? `${start} 至 ${end}` : '以各业务任务保存的条件为准';
}

const COUNT_LABELS: Array<[keyof ReturnBatchCounts, string]> = [
  ['total', '业务总数'], ['queued', '等待'], ['running', '执行中'], ['completed', '完成'], ['failed', '失败'], ['cancelled', '取消'],
];

export function ReturnBatchSummary({ batch }: { batch: ReturnBatchSnapshot }) {
  return <dl className="return-batch-counts" aria-label="本批次任务统计">
    {COUNT_LABELS.map(([key, label]) => <div key={key} className={key === 'failed' && batch.counts.failed ? 'has-failures' : ''}><dt>{label}</dt><dd>{batch.counts[key]}</dd></div>)}
  </dl>;
}

export function TaskCenterPage({ systemId, matterId, matterName, pageSize, onViewBatch, onViewTask, returnBatchId = '', onReturnBatchChange }: TaskCenterProps) {
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const key = `${systemId}/${returnBatchId || matterId}/${returnBatchId ? 1 : page}/${pageSize}`;
  const actionInFlight = useRef(false);
  const scope = useRef(key);
  scope.current = key;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [state, setState] = useState<{ key: string; rows: RuntimeTask[]; total: number; batch: ReturnBatchSnapshot | null; loading: boolean; error: string }>({ key: '', rows: [], total: 0, batch: null, loading: true, error: '' });
  const current = state.key === key ? state : { key, rows: [], total: 0, batch: null, loading: true, error: '' };
  const api = window.desktopApi as unknown as TaskCenterApi;
  useEffect(() => { setPage(1); setMessage(''); setBusy(''); }, [systemId, matterId, returnBatchId]);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const result = await loadTaskCenter(api, { systemId, matterId, page: returnBatchId ? 1 : page, pageSize, batchId: returnBatchId || undefined });
        if (disposed) return;
        setState({ key, ...result, loading: false, error: '' });
        if (!returnBatchId) setPage(Math.min(page, Math.max(1, Math.ceil(result.total / pageSize))));
      } catch (error) {
        if (!disposed) setState({ key, rows: [], total: 0, batch: null, loading: false,
          error: error instanceof Error ? error.message : '任务列表暂时无法加载，请稍后重试。' });
      } finally {
        if (!disposed) timer = window.setTimeout(() => void refresh(), 3_000);
      }
    };
    setState({ key, rows: [], total: 0, batch: null, loading: true, error: '' });
    void refresh();
    return () => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [systemId, matterId, page, pageSize, returnBatchId, revision]);

  const action = async (name: string, execute: () => Promise<{ message: string; batchId?: string }>) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    const requestScope = key;
    setBusy(name); setMessage('');
    try {
      const result = await execute();
      if (!mounted.current || scope.current !== requestScope) return;
      setMessage(result.message);
      if (result.batchId) onReturnBatchChange?.(result.batchId);
      setRevision(value => value + 1);
    } catch (error) {
      if (mounted.current && scope.current === requestScope) setMessage(error instanceof Error ? error.message : '操作失败，请重试。');
    } finally {
      actionInFlight.current = false;
      if (mounted.current && scope.current === requestScope) setBusy('');
    }
  };
  const cancel = (task: RuntimeTask) => action(task.id, async () => {
    const cancelled = await api.tasks.cancel(task.id);
    return { message: cancelled ? '已取消该任务。' : '该任务已结束或已取消，请查看最新状态。' };
  });
  const cancelPending = () => action('cancel-pending', async () => {
    const result = await api.returnBatches.cancelPending(systemId, returnBatchId);
    return { message: result.cancelled ? `已取消 ${result.cancelled} 个等待任务。` : '当前没有可取消的等待任务。' };
  });
  const retryFailed = () => action('retry-failed', async () => {
    const result = await api.returnBatches.retryFailed(systemId, returnBatchId);
    return { message: `已为 ${result.count} 个失败事项创建新的回流任务。`, batchId: result.batchId };
  });
  const view = (task: RuntimeTask) => { if (onViewTask) onViewTask(task); else onViewBatch(task.id); };
  const counts = current.batch?.counts;
  const activePeriod = returnBatchPeriod(current.batch);
  return <div className="task-center-page">
    <header className="page-header"><div><span className="eyebrow">{returnBatchId ? '事项工作区 / 批量任务' : '事项工作区 / 任务'}</span>
      <h1>{returnBatchId ? '批量回流任务' : `${matterName ?? '当前事项'} · 回流任务`}</h1>
      <p>{returnBatchId ? `批次 ${returnBatchId.slice(0, 8).toUpperCase()} · ${current.batch ? activePeriod : '正在读取任务条件…'}` : '查看当前事项的处理进度、结果与批次数据。'}</p>
    </div>{returnBatchId && onReturnBatchChange && <button className="secondary" onClick={() => onReturnBatchChange('')}>返回当前事项任务</button>}</header>
    {returnBatchId && <section className="panel return-batch-overview" aria-label="批量回流概览" aria-busy={current.loading}>
      {current.batch ? <ReturnBatchSummary batch={current.batch} /> : <p className="return-batch-loading">{current.loading ? '正在读取本批次任务…' : '批次暂时无法加载'}</p>}
      <div className="return-batch-actions"><span>每个业务独立保存结果，可分别查看或重新执行。</span><div>
        <button className="secondary" disabled={Boolean(busy) || !counts?.queued} onClick={() => void cancelPending()}>{busy === 'cancel-pending' ? '正在取消…' : '取消等待任务'}</button>
        <button className="secondary" disabled={Boolean(busy) || !counts?.failed} onClick={() => void retryFailed()}>{busy === 'retry-failed' ? '正在创建…' : '重新回流失败项'}</button>
      </div></div>
    </section>}
    {(message || current.error) && <div className={current.error ? 'inline-error task-center-message' : 'message task-center-message'} role="status">{current.error || message}
      {current.error && <button className="link-button" disabled={Boolean(busy)} onClick={() => setRevision(value => value + 1)}>重新加载</button>}</div>}
    <section className="panel data-panel task-table-panel" tabIndex={0} aria-label={returnBatchId ? '本批次各业务任务' : '当前事项任务列表'} aria-busy={current.loading}><table><thead><tr>
      <th>任务号</th><th>{returnBatchId ? '业务事项' : '任务'}</th><th>回流时间段</th><th>状态</th><th>进度</th><th>生成时间</th><th>结果</th><th>操作</th>
    </tr></thead><tbody>{current.rows.map(task => {
      const percent = taskProgressPercent(task.progress, task.status);
      const parentBatchId = typeof task.details?.returnBatchId === 'string' ? task.details.returnBatchId : '';
      const name = returnBatchId ? task.name.split(' / ').at(-1) ?? task.name : task.name;
      return <tr key={task.id} data-task-id={task.id}><td className="batch-id" title={task.id}>{task.id.slice(0, 8).toUpperCase()}</td><td className="task-name-cell" title={task.name}>{name}
        {!returnBatchId && parentBatchId && onReturnBatchChange && <button className="link-button task-parent-batch" onClick={() => onReturnBatchChange(parentBatchId)}>查看任务组 · {parentBatchId.slice(0, 8).toUpperCase()}</button>}</td>
        <td>{returnTaskPeriod(task, systemId)}</td><td><span className={`status-chip ${task.status}`}>{taskStatusLabel(task.status)}</span></td>
        <td><div className="task-progress">{percent !== undefined && <progress max={100} value={percent} aria-label={`${task.name}进度`} />}<span>{task.progress.message ?? (percent !== undefined ? `${percent}%` : '等待进度')}</span></div></td>
        <td>{new Date(task.createdAt).toLocaleString()}</td><td className={task.error ? 'error-text task-result-cell' : 'task-result-cell'}>{task.error ?? (task.finishedAt ? taskStatusLabel(task.status) : task.status === 'queued' ? '等待执行' : '执行中')}</td>
        <td className="task-center-row-actions">{['queued', 'running'].includes(task.status) && <button className="link-button error-text" disabled={Boolean(busy)} onClick={() => void cancel(task)}>取消</button>}
          {task.type === 'data-return' && task.status === 'completed' && task.systemId && task.matterId && <button className="link-button" onClick={() => view(task)}>在回流数据中查看</button>}</td></tr>;
    })}{!current.rows.length && <tr><td colSpan={8} className="empty">{current.loading ? '正在读取任务…' : current.error ? '暂时无法读取任务' : '暂无任务记录'}</td></tr>}</tbody></table></section>
    {!returnBatchId && current.total > pageSize && <div className="pagination"><span>共 {current.total} 条 · 第 {page}/{Math.ceil(current.total / pageSize)} 页</span>
      <button className="secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><button className="secondary" disabled={page >= Math.ceil(current.total / pageSize)} onClick={() => setPage(value => value + 1)}>下一页</button></div>}
  </div>;
}
