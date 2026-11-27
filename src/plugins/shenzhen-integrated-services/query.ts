import { createHash } from 'node:crypto';
import { AppError } from '../../core/errors/app-error';
import type { QueryContext, QueryPage } from '../../core/query/types';
import { SHENZHEN_MAX_HISTORY, SHENZHEN_MAX_RECORDS, SHENZHEN_SYSTEM_ID, shenzhenRecordMatterId, type ShenzhenMatter } from './catalog';

export interface ShenzhenQueryClient {
  list(parameters: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>[]>;
  handling(parameters: { ywlsh?: string; lsh?: string }, signal?: AbortSignal): Promise<Record<string, unknown>[]>;
}
export interface ShenzhenRecord extends Record<string, unknown> {
  recordKey: string; caseNumber: string; processNumber: string; applicationNumber: string;
  handlingRecords: Record<string, unknown>[]; handlingRecordCount: number; handlingRecordStatus: 'collected' | 'failed';
}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new AppError('TASK_CANCELLED', '回流任务已取消'); };
const invalid = (message: string) => new AppError('QUERY_INVALID', message);
const failed = (message: string) => new AppError('REMOTE_REQUEST_FAILED', message);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** All source timestamps are local Chinese civil time, never guessed from the host timezone. */
export function shenzhenDateTime(value: unknown): string {
  const input = text(value);
  const digits = /^\d{14}$/.test(input) ? input : '';
  const formatted = digits
    ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)} ${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}`
    : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(input) ? input.replace('T', ' ') : '';
  if (!formatted || !validDate(formatted.slice(0, 10))) return '';
  const [hour, minute, second] = formatted.slice(11).split(':').map(Number);
  return hour <= 23 && minute <= 59 && second <= 59 ? formatted : '';
}
export interface ShenzhenFilters { dateType: 'received' | 'accepted' | 'finished'; startDate: string; endDate: string }
export function normalizeShenzhenFilters(filters: Record<string, unknown>): ShenzhenFilters {
  const dateType = text(filters.dateType ?? 'received'), startDate = text(filters.startDate), endDate = text(filters.endDate);
  if (!['received', 'accepted', 'finished'].includes(dateType) || !validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    throw invalid('请选择有效的日期类型及完整日期范围');
  }
  if ((Date.parse(endDate + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / 86_400_000 > 3660) {
    throw invalid('日期范围超过十年，请缩小范围后回流');
  }
  return { dateType: dateType as ShenzhenFilters['dateType'], startDate, endDate };
}
export function shenzhenListParameters(filters: ShenzhenFilters): Record<string, unknown> {
  const prefix = { received: ['jssj', 'jsqssj', 'jszzsj'], accepted: ['slsj', 'slqssj', 'slzzsj'], finished: ['bjsj', 'bjqssj', 'bjzzsj'] }[filters.dateType];
  const start = filters.startDate.replaceAll('-', '') + '000000', end = filters.endDate.replaceAll('-', '') + '235959';
  return { [prefix[0]]: [start, end], [prefix[1]]: start, [prefix[2]]: end };
}
const normalizedName = (value: unknown) => text(value).replace(/\s/g, '').replace(/\(/g, '（').replace(/\)/g, '）');
function matchesMatter(row: Record<string, unknown>, matter: ShenzhenMatter): boolean {
  const id = text(row.sxid);
  if (id && matter.sourceIds.includes(id)) return true;
  // A known id for another matter must not be overridden by a misleading name.
  if (id && matter.sourceIds.length) return false;
  return matter.sourceNames.some(name => normalizedName(name) === normalizedName(row.sxmc));
}
function identifier(value: unknown): string {
  const v = text(value);
  return v && v.length <= 256 && !/[\s*•●\u0000-\u001f]/.test(v) ? v : '';
}
function caseKey(sourceId: string, applicationNumber: string, processNumber: string): string {
  return createHash('sha256').update(JSON.stringify([sourceId, applicationNumber ? 'application' : 'process', applicationNumber || processNumber])).digest('hex');
}
function record(row: Record<string, unknown>, matter: ShenzhenMatter): ShenzhenRecord {
  const processNumber = identifier(row.ywlsh), applicationNumber = identifier(row.lsh);
  if (!processNumber && !applicationNumber) throw failed('办件缺少可关联的业务或申办流水号，请在原系统核对');
  const sourceId = text(row.sxid) || shenzhenRecordMatterId(SHENZHEN_SYSTEM_ID, matter.id);
  // Keep the application key when a later run adds a workflow id to the same case.
  const recordKey = caseKey(sourceId, applicationNumber, processNumber);
  return {
    recordKey, caseNumber: processNumber || applicationNumber, processNumber, applicationNumber,
    municipalAcceptanceNumber: text(row.slsh), sourceMatterId: sourceId, sourceMatterName: text(row.sxmc),
    scenarioId: text(row.qxid), scenarioName: text(row.qxmc), subjectType: text(row.ywztlx),
    subjectName: text(row.ywztmc), subjectNumber: text(row.ywztbh),
    appliedAt: shenzhenDateTime(row.sqsj), receivedAt: shenzhenDateTime(row.kqsj), acceptedAt: shenzhenDateTime(row.slsj), finishedAt: shenzhenDateTime(row.bjsj),
    acceptor: text(row.ywslr), currentAssignee: text(row.dqfpr), organization: text(row.ywjbdw),
    businessState: text(row.ywzt), currentStep: text(row.dqhjmc) || stageLabel(text(row.dqhj), ''), summary: text(row.ywzy),
    handlingRecords: [], handlingRecordCount: 0, handlingRecordStatus: 'failed',
  };
}
function stageLabel(type: string, name: string): string {
  const labels: Record<string, string> = { shenqing: '申请', shouli: '受理', chushen: '初审', fushen: '复审', shenpi: '审批', gongshi: '公示', chehui: '撤回', banjie: '办结', guidang: '归档', zidongrenwu: '自动任务', zidingyi: '自定义环节', '9': '结束' };
  return type === 'zidingyi' && name ? name : labels[type] || name || (type ? '其他环节' : '');
}
export function projectShenzhenHandling(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!Array.isArray(rows) || rows.length > SHENZHEN_MAX_HISTORY || rows.some(row => !object(row))) throw failed('办理过程格式无效或超出保护限制');
  return rows.map((row, index) => {
    const receivedAt = shenzhenDateTime(row.cjsj), operatedAt = shenzhenDateTime(row.czsj), reviewedAt = shenzhenDateTime(row.sprq), completedAt = shenzhenDateTime(row.wcsj);
    const rawResult = text(row.spyjmc), result = ['异议不成立', '没有异议', '无异议'].includes(rawResult) ? '公示通过' : rawResult === '异议成立' ? '公示不通过' : rawResult;
    return { sourceRecordId: text(row.logid), sourceIndex: index + 1, operator: text(row.czr), reviewer: text(row.spr), organization: text(row.yqjgmc),
      receivedAt, operatedAt, reviewedAt, completedAt, handledAt: reviewedAt || operatedAt || completedAt || receivedAt,
      step: text(row.hjbt) || text(row.hjmc), stageType: text(row.hjlx), action: stageLabel(text(row.hjlx), text(row.hjmc)),
      result, rawResult, opinion: text(row.spsm), publicityStartedAt: shenzhenDateTime(row.gssj), withdrawn: text(row.zhbz) === '1' };
  });
}

export async function queryShenzhenCases(client: ShenzhenQueryClient, matter: ShenzhenMatter, context: QueryContext): Promise<QueryPage<ShenzhenRecord>> {
  cancelled(context.signal);
  const filters = normalizeShenzhenFilters(context.filters);
  context.onProgress?.({ current: 0, message: '正在读取经办业务列表' });
  // The source returns one array and paginates it in the browser. Do not invent remote page numbers.
  const source = await client.list(shenzhenListParameters(filters), context.signal);
  cancelled(context.signal);
  if (!Array.isArray(source) || source.length > SHENZHEN_MAX_RECORDS || source.some(row => !object(row))) throw failed('经办列表格式无效或超过五万条，请缩小日期范围');
  const selected = new Map<string, ShenzhenRecord>(), aliases = new Map<string, string>();
  let undated = 0;
  const dateField = { received: 'receivedAt', accepted: 'acceptedAt', finished: 'finishedAt' }[filters.dateType];
  for (const raw of source) {
    if (!matchesMatter(raw, matter)) continue;
    const projected = record(raw, matter), date = text(projected[dateField]).slice(0, 10);
    if (!date) { undated++; continue; }
    if (date < filters.startDate || date > filters.endDate) continue;
    const keys = [projected.processNumber && 'process:' + projected.processNumber, projected.applicationNumber && 'application:' + projected.applicationNumber].filter(Boolean) as string[];
    const previousKeys = [...new Set(keys.map(key => aliases.get(key)).filter(Boolean))] as string[];
    if (previousKeys.length > 1) throw failed('经办列表的申办与流程编号存在冲突，请在原系统核对');
    const existingKey = previousKeys[0], old = existingKey ? selected.get(existingKey) : undefined;
    if (old) {
      if (old.sourceMatterId !== projected.sourceMatterId || old.processNumber && projected.processNumber && old.processNumber !== projected.processNumber
        || old.applicationNumber && projected.applicationNumber && old.applicationNumber !== projected.applicationNumber) throw failed('同一办件返回了冲突的关联编号');
      projected.processNumber ||= old.processNumber; projected.applicationNumber ||= old.applicationNumber;
      projected.recordKey = caseKey(text(projected.sourceMatterId), projected.applicationNumber, projected.processNumber);
      projected.caseNumber = projected.processNumber || projected.applicationNumber;
      if (existingKey !== projected.recordKey) {
        selected.delete(existingKey);
        for (const [alias, key] of aliases) if (key === existingKey) aliases.set(alias, projected.recordKey);
      }
    }
    selected.set(projected.recordKey, projected);
    for (const key of keys) aliases.set(key, projected.recordKey);
  }
  const records = [...selected.values()];
  let partial = 0, timeouts = 0;
  for (let index = 0; index < records.length; index++) {
    cancelled(context.signal);
    const row = records[index];
    try {
      const logs = await client.handling(row.processNumber ? { ywlsh: row.processNumber } : { lsh: row.applicationNumber }, context.signal);
      cancelled(context.signal);
      row.handlingRecords = projectShenzhenHandling(logs);
      row.handlingRecordCount = row.handlingRecords.length; row.handlingRecordStatus = 'collected';
    } catch (error) {
      cancelled(context.signal);
      if (error instanceof AppError && ['TASK_CANCELLED', 'SESSION_EXPIRED', 'SYSTEM_LOGIN_REQUIRED', 'REMOTE_RATE_LIMITED'].includes(error.code)) throw error;
      partial++; if (error instanceof AppError && error.code === 'REMOTE_TIMEOUT') timeouts++;
      row.handlingRecordError = '本次办理过程读取失败，办件已保留，可重新回流补齐。';
    }
    context.onProgress?.({ current: index + 1, total: records.length, message: `已读取 ${index + 1}/${records.length} 笔办件的办理过程${partial ? `，${partial} 笔待补齐` : ''}` });
  }
  cancelled(context.signal);
  context.onProgress?.({ current: records.length, total: records.length, message: `办件及办理过程回流完成，共 ${records.length} 笔${partial ? `，${partial} 笔办理过程待补齐` : ''}` });
  return { rows: records, page: 1, pageSize: Math.max(1, records.length), total: records.length,
    ...(undated ? { undatedExcludedCount: undated } : {}), ...(timeouts ? { skippedRequestCount: timeouts } : {}) };
}

/** A failed read never replaces previously collected history with a fabricated empty list. */
export function mergeShenzhenRecord(incoming: Record<string, unknown>, previous: Record<string, unknown>): Record<string, unknown> {
  if (incoming.recordKey !== previous.recordKey || incoming.handlingRecordStatus !== 'failed' || !Array.isArray(previous.handlingRecords)) return incoming;
  return { ...incoming, handlingRecords: previous.handlingRecords, handlingRecordCount: previous.handlingRecords.length,
    handlingRecordError: '本次读取失败，已保留上次办理过程，等待补齐。' };
}
