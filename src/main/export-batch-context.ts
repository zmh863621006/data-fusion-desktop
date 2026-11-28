import type { RuntimeTask } from '../core/tasks/engine';
import type { ExportBatchContext } from '../core/export/types';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function exportBatchContext(task: RuntimeTask, businessName: string): ExportBatchContext | undefined {
  if (!['guangdong-hrss', 'shenzhen-integrated-services'].includes(task.systemId ?? '')) return undefined;
  const details = task.details ?? {}, result = object(task.result);
  const filters = object(object(details.returnContext).filters);
  const shenzhenDateLabels: Record<string, string> = { received: '接收日期', accepted: '受理日期', finished: '办结日期' };
  return {
    taskId: task.id, systemId: task.systemId!, matterId: task.matterId, businessName, status: task.status,
    startDate: text(details.startDate) ?? text(details.requestedStartDate),
    endDate: text(details.endDate) ?? text(details.requestedEndDate),
    dateBasis: text(details.dateBasisLabel) ?? (task.systemId === 'shenzhen-integrated-services' ? shenzhenDateLabels[String(filters.dateType)] : text(details.dateBasis)),
    dateFiltering: details.dateFilterStatus === 'pending' ? false : undefined,
    partial: result.partial === true,
    skippedRequests: number(task.progress?.skippedRequests) ?? number(result.skippedRequests),
    batchRowCount: number(result.total), incompleteHandling: number(result.incompleteHandlingCount),
  };
}
