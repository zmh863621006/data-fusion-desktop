import { useEffect, useState } from 'react';
import type { RuntimeTask } from '../../core/tasks/engine';

const batchPageSize = 50;

export function useCompletedBatches(systemId: string, matterId: string, selectedId: string, revision = 0, enabled = true) {
  const [page, setPage] = useState(1);
  const [batches, setBatches] = useState<RuntimeTask[]>([]);
  const [pageCount, setPageCount] = useState(1);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const scope = { systemId, matterId, completedBatches: true };
    const load = async () => {
      const result = await window.desktopApi.tasks.page({ ...scope, page, pageSize: batchPageSize });
      const count = Math.max(1, Math.ceil(result.total / batchPageSize));
      if (disposed) return;
      if (page > count) { setPage(count); return; }
      let rows = result.rows;
      if (selectedId && !rows.some(row => row.id === selectedId)) {
        const selected = await window.desktopApi.tasks.page({ ...scope, taskId: selectedId });
        rows = [...selected.rows, ...rows];
      }
      if (!disposed) { setBatches(rows); setPageCount(count); setError(''); }
    };
    void load().catch(() => { if (!disposed) { setBatches([]); setError('回流批次暂时无法读取'); } });
    return () => { disposed = true; };
  }, [systemId, matterId, selectedId, revision, page, enabled]);
  return { batches, page, pageCount, setPage, error };
}

export function BatchPageOptions({ page, pageCount }: { page: number; pageCount: number }) {
  return <>
    {page > 1 && <option value="@newer">查看较新的批次（第 {page - 1}/{pageCount} 页）</option>}
    {page < pageCount && <option value="@older">查看更早的批次（第 {page + 1}/{pageCount} 页）</option>}
  </>;
}

export function selectBatchOption(value: string, pages: { page: number; setPage: (page: number) => void }, select: (id: string) => void) {
  if (value === '@newer') pages.setPage(pages.page - 1);
  else if (value === '@older') pages.setPage(pages.page + 1);
  else select(value);
}
