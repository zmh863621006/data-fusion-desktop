import { AppError } from '../errors/app-error';
import type { BusinessMatter, QueryContext } from './types';

export interface QueryRunOptions {
  maxPages?: number;
  signal?: AbortSignal;
  onPage?: (info: { page: number; fetched: number; total?: number }) => void;
}

export async function queryAllPages<T extends Record<string, unknown>>(
  matter: BusinessMatter<T>,
  context: QueryContext,
  options: QueryRunOptions = {},
): Promise<T[]> {
  const maxPages = options.maxPages ?? 10_000;
  const rows: T[] = [];
  let page = Math.max(1, context.page || 1);
  let completed = false;

  for (let index = 0; index < maxPages; index += 1) {
    if (options.signal?.aborted) throw new AppError('TASK_CANCELLED', '查询任务已取消');
    const result = await matter.query({ ...context, page, signal: options.signal ?? context.signal });
    rows.push(...result.rows);
    options.onPage?.({ page, fetched: rows.length, total: result.total });

    if (result.rows.length === 0) { completed = true; break; }
    if (result.total >= 0 && rows.length >= result.total) { completed = true; break; }
    if (result.rows.length < result.pageSize) { completed = true; break; }
    page += 1;
  }

  if (!completed) {
    throw new AppError('QUERY_INVALID', '查询达到最大分页保护限制，请缩小查询范围', { maxPages });
  }

  return rows;
}
