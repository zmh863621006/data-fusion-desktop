import { AppError } from '../../core/errors/app-error';
import type { QueryContext, QueryPage } from '../../core/query/types';
import {
  ONE_WINDOW_MAX_RECORDS, ONE_WINDOW_STATES, type OneWindowMatter,
} from './catalog';
import { OneWindowClient, type OneWindowSourceFilters } from './client';
import { oneWindowFailure, oneWindowObject, oneWindowText, sanitizeOneWindowData } from './parser';
import type { OneWindowDetailSection, OneWindowFormData, OneWindowHtmlData, OneWindowRecord } from './types';

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeOneWindowFilters(input: Record<string, unknown>): OneWindowSourceFilters {
  const dateType = input.dateType ?? 'all';
  if (!['all','received','finished'].includes(String(dateType))) throw new AppError('QUERY_INVALID', '请选择有效的日期类型');
  const startDate = oneWindowText(input.startDate), endDate = oneWindowText(input.endDate), state = oneWindowText(input.state);
  if (!ONE_WINDOW_STATES.some(option => option.value === state)) throw new AppError('QUERY_INVALID', '请选择有效的办件状态');
  if (dateType !== 'all' && (!validDate(startDate) || !validDate(endDate) || startDate > endDate)) {
    throw new AppError('QUERY_INVALID', '请选择完整且有效的回流日期范围');
  }
  return { dateType: dateType as OneWindowSourceFilters['dateType'],
    startDate: dateType === 'all' ? '' : startDate, endDate: dateType === 'all' ? '' : endDate, state };
}

function field(section: OneWindowDetailSection | undefined, key: string): string {
  if (section?.status !== 'complete' || !oneWindowObject(section.data)) return '';
  const data = section.data as unknown as OneWindowHtmlData;
  return Array.isArray(data.fields) ? data.fields.find(item => item.key === key)?.value ?? '' : '';
}

function summary(row: Record<string, unknown>, matter: OneWindowMatter, now: number): OneWindowRecord {
  return {
    bsnum: oneWindowText(row.BSNUM), receiveNumber: oneWindowText(row.RECEIVE_NUMBER), matterName: matter.name,
    applicant: oneWindowText(row.APPLICANT), applicantId: oneWindowText(row.IDCARD_NO),
    organizationName: oneWindowText(row.ORG_NAME), status: oneWindowText(row.STATE),
    statusLabel: oneWindowText(row.STATE_NAME ?? row.STATE_TEXT ?? row.STATE),
    receivedAt: oneWindowText(row.RECEIVE_TIME), submittedAt: oneWindowText(row.SUBMIT_TIME), finishedAt: oneWindowText(row.FINISH_TIME),
    creditCode: '', legalPerson: '', collectedAt: now,
    detailStatus: 'partial', detailFailures: [],
    sourceList: sanitizeOneWindowData(row) as Record<string, unknown>, details: {},
  };
}

export async function queryOneWindow(client: OneWindowClient, matter: OneWindowMatter, context: QueryContext, now = Date.now()): Promise<QueryPage<OneWindowRecord>> {
  const filters = normalizeOneWindowFilters(context.filters);
  await client.prepare(context.signal);
  const list: Record<string, unknown>[] = [], seen = new Set<string>();
  let total: number | undefined;
  const size = Math.min(200, Math.max(1, context.pageSize || 100));
  for (let page = 1; total === undefined || list.length < total; page++) {
    const response = await client.list(matter, filters, page, size, context.signal);
    if (total !== undefined && total !== response.total) throw oneWindowFailure('一窗列表在分页过程中发生变化，请重新回流');
    total = response.total;
    if (total > ONE_WINDOW_MAX_RECORDS) throw oneWindowFailure('本次一窗办件超过五万条，请缩小日期范围后回流');
    if (!response.rows.length && list.length < total) throw oneWindowFailure('一窗分页未返回全部办件，本次结果尚未保存');
    for (const row of response.rows) {
      const bsnum = oneWindowText(row.BSNUM);
      if (!bsnum || seen.has(bsnum)) throw oneWindowFailure('一窗列表出现缺失或重复的办件流水号，请重新回流');
      if (oneWindowText(row.ITEM_NAME) !== matter.name) throw oneWindowFailure('一窗返回了其他事项的办件，请在原系统核对查询条件');
      seen.add(bsnum); list.push(row);
    }
    if (list.length > total) throw oneWindowFailure('一窗办件条数与分页总数不一致，请重新回流');
    context.onProgress?.({ current: list.length, total, message: `已获取 ${list.length} 条办件列表，正在准备详情` });
  }
  const records: OneWindowRecord[] = [];
  for (const row of list) {
    if (context.signal?.aborted) throw new AppError('TASK_CANCELLED', '回流任务已取消');
    const record = summary(row, matter, now);
    record.statusLabel = oneWindowText(row.STATE_NAME ?? row.STATE_TEXT) || client.statusLabel(record.status);
    try { record.details = await client.details(record.bsnum, context.signal); }
    catch (error) {
      if (error instanceof AppError && ['SESSION_EXPIRED','TASK_CANCELLED'].includes(error.code)) throw error;
      record.details = { detail: { status: 'failed', data: null, message: '办件详情读取失败，等待补采' } };
    }
    record.detailFailures = Object.entries(record.details).filter(([,section]) => section.status === 'failed').map(([name]) => name);
    record.detailStatus = record.detailFailures.length ? 'partial' : 'complete';
    const form = record.details.form;
    const formData = form?.status === 'complete' && oneWindowObject(form.data) ? (form.data as unknown as OneWindowFormData).data : {};
    record.creditCode = oneWindowText(formData.TongYiSheHuiXinYongDaiMa) || field(record.details.base, 'ORG_CODE');
    record.legalPerson = oneWindowText(formData.OperatorName) || field(record.details.base, 'LEGAL_PERSON');
    records.push(record);
    context.onProgress?.({ current: records.length, total: list.length,
      message: `已读取 ${records.length}/${list.length} 条办件详情` });
  }
  return { rows: records, page: 1, pageSize: records.length || size, total: records.length };
}

/** A failed refresh keeps older detail bytes visibly marked as stale until a later successful read. */
export function mergeOneWindowRecord(incoming: OneWindowRecord, previous: OneWindowRecord): OneWindowRecord {
  if (incoming.bsnum !== previous.bsnum) return incoming;
  const details = { ...incoming.details };
  for (const [name, current] of Object.entries(details)) {
    const old = previous.details?.[name];
    if (current.status === 'failed' && old?.data !== undefined && old.data !== null) {
      details[name] = { ...current, data: old.data, message: '本次读取失败，已保留上次详情，等待补采' };
    }
  }
  // A failed wrapper cannot discover its child links. Retain all previous sections as stale data.
  if (details.detail?.status === 'failed') {
    for (const [name, old] of Object.entries(previous.details ?? {})) {
      if (!details[name]) details[name] = { ...old, status: 'failed', message: '本次详情读取失败，已保留上次内容，等待补采' };
    }
  }
  return { ...incoming, creditCode: incoming.creditCode || previous.creditCode,
    legalPerson: incoming.legalPerson || previous.legalPerson, details };
}
