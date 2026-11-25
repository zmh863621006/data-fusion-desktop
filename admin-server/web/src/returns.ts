import { ApiError, request } from './api';

export type ReturnBatchState = 'uploading' | 'completed';
export interface ReturnBatch {
  id: string; clientBatchId: string; customerId: string; customerName: string; licenseId: string; deviceId: string;
  systemId: string; systemName: string; matterId: string; matterName: string;
  createdAt: number; startedAt: number; finishedAt: number; completedAt: number;
  rowCount: number; receivedRows: number; state: ReturnBatchState;
}
export interface ReturnRecord {
  rowNo: number; recordKey: string; data: Record<string, unknown>; firstSeenAt: number; updatedAt: number;
}
export interface ReturnList { rows: ReturnBatch[]; total: number }
export interface ReturnDetail { batch: ReturnBatch; rows: ReturnRecord[]; total: number }
export interface ReturnFilters {
  customerId?: string; deviceId?: string; systemId?: string; matterId?: string; keyword?: string;
  from?: number; to?: number; state?: ReturnBatchState;
}
export interface ReturnPagination { page: number; pageSize: number }
export const returnBatchLabel = (state: ReturnBatchState) => state === 'completed' ? '已上传' : '接收中';

export function returnQuery(filters: ReturnFilters, pagination: ReturnPagination): string {
  const query = new URLSearchParams({ page: String(pagination.page), pageSize: String(pagination.pageSize) });
  for (const key of ['customerId', 'deviceId', 'systemId', 'matterId', 'keyword', 'from', 'to', 'state'] as const) {
    const value = filters[key];
    if (value !== undefined && String(value).trim()) query.set(key, String(value).trim());
  }
  return query.toString();
}

const timedSignal = (signal?: AbortSignal, milliseconds = 20_000) => signal ? AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds);
export const returnApi = {
  list: (filters: ReturnFilters, pagination: ReturnPagination, signal?: AbortSignal) =>
    request<ReturnList>(`/api/admin/returns?${returnQuery(filters, pagination)}`, { signal: timedSignal(signal) }),
  detail: (id: string, pagination: ReturnPagination, signal?: AbortSignal) =>
    request<ReturnDetail>(`/api/admin/returns/${encodeURIComponent(id)}?${returnQuery({}, pagination)}`, { signal: timedSignal(signal) }),
};

/** A superseded request cannot replace the current batch, even if its server ignores aborts. */
export function latestReturnRequest() {
  let revision = 0;
  let pending: AbortController | undefined;
  return {
    async run<T>(load: (signal: AbortSignal) => Promise<T>, success: (value: T) => void, failure: (error: unknown) => void) {
      pending?.abort();
      const mine = ++revision, controller = new AbortController(); pending = controller;
      try { const value = await load(controller.signal); if (mine === revision && !controller.signal.aborted) success(value); }
      catch (error) { if (mine === revision && !controller.signal.aborted) failure(error); }
    },
    cancel() { revision++; pending?.abort(); pending = undefined; },
  };
}

/** Export stays on the authenticated origin; it never opens a server-supplied download URL. */
export async function downloadReturnBatch(id: string, signal?: AbortSignal): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`/api/admin/returns/${encodeURIComponent(id)}/export`, {
      credentials: 'same-origin', redirect: 'error', signal: timedSignal(signal, 60_000),
      headers: { accept: 'application/json' },
    });
  } catch {
    if (signal?.aborted) throw new ApiError('下载已取消', 0, 'REQUEST_CANCELLED');
    throw new ApiError('下载失败或超时，请稍后重试', 0);
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string; code?: string };
    const failure = new ApiError(error.error || `下载失败 ${response.status}`, response.status, error.code);
    window.dispatchEvent(new CustomEvent('admin-api-error', { detail: failure }));
    throw failure;
  }
  if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) throw new ApiError('下载内容不是有效的数据文件，请重新登录后重试', 502);
  return response.blob();
}
