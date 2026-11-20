import { AppError } from '../errors/app-error';
import type { QueryContext } from '../query/types';
import type { LocalRecordQuery, TaskHistoryQuery } from '../storage/platform-store';
import type { AppSettings } from '../settings/types';

const MAX_FILTER_BYTES = 256 * 1024;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new AppError('QUERY_INVALID', `${label}格式无效`);
  }
  return value;
}

export function parseQueryContext(value: unknown): QueryContext {
  if (!isRecord(value) || !isRecord(value.filters)) {
    throw new AppError('QUERY_INVALID', '查询参数格式无效');
  }

  const page = value.page;
  const pageSize = value.pageSize;
  if (!Number.isSafeInteger(page) || Number(page) < 1 || Number(page) > 100_000) {
    throw new AppError('QUERY_INVALID', '页码必须在 1 到 100000 之间');
  }
  if (!Number.isSafeInteger(pageSize) || Number(pageSize) < 1 || Number(pageSize) > 200) {
    throw new AppError('QUERY_INVALID', '每页数量必须在 1 到 200 之间');
  }

  for (const key of Object.keys(value.filters)) {
    if (BLOCKED_KEYS.has(key)) throw new AppError('QUERY_INVALID', '查询条件包含非法字段');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value.filters);
  } catch {
    throw new AppError('QUERY_INVALID', '查询条件无法序列化');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FILTER_BYTES) {
    throw new AppError('QUERY_INVALID', '查询条件过大');
  }

  return {
    page: Number(page),
    pageSize: Number(pageSize),
    filters: JSON.parse(serialized) as Record<string, unknown>,
  };
}

export function parseRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10_000 || value.some((row) => !isRecord(row))) {
    throw new AppError('QUERY_INVALID', '同步数据格式无效或单批数据超过 10000 条');
  }
  return value as Record<string, unknown>[];
}

export function parseLocalRecordQuery(value: unknown): LocalRecordQuery {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new AppError('QUERY_INVALID', '本地数据查询参数无效');
  const allowed = new Set(['systemId', 'matterId', 'keyword', 'page', 'pageSize']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new AppError('QUERY_INVALID', '包含不支持的本地查询参数');
  const result: LocalRecordQuery = {};
  if (value.systemId !== undefined) result.systemId = parseIdentifier(value.systemId, '系统标识');
  if (value.matterId !== undefined) result.matterId = parseIdentifier(value.matterId, '事项标识');
  if (value.keyword !== undefined) {
    if (typeof value.keyword !== 'string' || value.keyword.length > 200) throw new AppError('QUERY_INVALID', '搜索关键字无效');
    result.keyword = value.keyword;
  }
  if (value.page !== undefined) {
    if (!Number.isSafeInteger(value.page) || Number(value.page) < 1 || Number(value.page) > 100_000) throw new AppError('QUERY_INVALID', '页码无效');
    result.page = Number(value.page);
  }
  if (value.pageSize !== undefined) {
    if (!Number.isSafeInteger(value.pageSize) || Number(value.pageSize) < 10 || Number(value.pageSize) > 500) throw new AppError('QUERY_INVALID', '每页数量无效');
    result.pageSize = Number(value.pageSize);
  }
  return result;
}

export function parseTaskHistoryQuery(value: unknown): TaskHistoryQuery {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new AppError('QUERY_INVALID', '任务查询参数无效');
  const { completedBatches, taskId, ...scope } = value;
  if ('keyword' in scope || (completedBatches !== undefined && typeof completedBatches !== 'boolean')) {
    throw new AppError('QUERY_INVALID', '任务查询参数无效');
  }
  const parsed = parseLocalRecordQuery(scope);
  if (parsed.matterId && !parsed.systemId) throw new AppError('QUERY_INVALID', '事项查询缺少系统标识');
  return { ...parsed, completedBatches, taskId: taskId === undefined ? undefined : parseIdentifier(taskId, '任务标识') };
}

export function parseSettingsPatch(value: unknown): Partial<AppSettings> {
  if (!isRecord(value)) throw new AppError('QUERY_INVALID', '设置参数无效');
  const allowed = new Set(['autoCheckUpdates', 'defaultPageSize', 'exportDirectory', 'taskConcurrency', 'retainAuditDays']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new AppError('QUERY_INVALID', '包含不支持的设置项');
  const result: Partial<AppSettings> = {};
  if (value.autoCheckUpdates !== undefined) {
    if (typeof value.autoCheckUpdates !== 'boolean') throw new AppError('QUERY_INVALID', '自动更新设置无效');
    result.autoCheckUpdates = value.autoCheckUpdates;
  }
  for (const [key, minimum, maximum] of [['defaultPageSize', 10, 500], ['taskConcurrency', 1, 10], ['retainAuditDays', 1, 3650]] as const) {
    if (value[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || Number(value[key]) < minimum || Number(value[key]) > maximum) throw new AppError('QUERY_INVALID', `${key}设置无效`);
      result[key] = Number(value[key]);
    }
  }
  if (value.exportDirectory !== undefined) {
    if (typeof value.exportDirectory !== 'string' || value.exportDirectory.length > 1_000) throw new AppError('QUERY_INVALID', '导出目录设置无效');
    result.exportDirectory = value.exportDirectory;
  }
  return result;
}
