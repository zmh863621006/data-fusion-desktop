import { AppError } from '../../core/errors/app-error';
import type { QueryContext, QueryPage } from '../../core/query/types';
import type { OversizeListItem } from './client';
import { supplementOversizeApplication, type OversizeApplicationSource } from './application';
import { normalizeCreditCode } from '../../core/enterprise/credit-code';

const AUTHORITY_NAME = '惠州市交通运输局';
const AUTHORITY_CODE = '114413000071877877';
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
export const isHuizhouCertificate = (value: unknown): boolean => /^[A-Za-z]4413[0-9]+$/.test(text(value));
export function oversizeDay(value: unknown): string {
  const match = text(value).match(/^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/);
  if (!match) return '';
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1] ? match[1] : '';
}

export function mapOversizeCertificate(row: OversizeListItem): Record<string, unknown> {
  const from = oversizeDay(row.startTime), until = oversizeDay(row.endTime);
  if (!from || !until || from > until) throw new AppError('REMOTE_REQUEST_FAILED', `大件运输证件有效期异常（申请编号：${text(row.reqNo)}）`);
  return {
    xzxkmc: '省内大件运输许可审批', xkXdrMc: text(row.transportName),
    // Certificate list usually has names only; the selected application supplies its credit code next.
    xkXdrLb: '法人及非法人组织', xkXdrShxym: normalizeCreditCode(row.transportCreditCode),
    xkXdrGszc: '', xkXdrZzjg: '', xkXdrSwdj: '', xkXdrSydw: '', xkXdrShzz: '',
    xkFrdb: '', xkFrZjlx: '', xkFrZjhm: '', xkXdrZjlx: '', xkXdrZjhm: '',
    xkXkws: '交通行政许可决定书', xkWsh: text(row.reqNo), xkXklb: '普通', xkXkzs: '广东省超限运输通行证',
    xkXkbh: text(row.reqNo), xkNr: text(row.roadLine), xkJdrq: oversizeDay(row.handerTime), xkYxqz: from, xkYxqzi: until,
    xkXkjg: AUTHORITY_NAME, xkXkjgdm: AUTHORITY_CODE, xkZt: '1', xkLydw: AUTHORITY_NAME, xkLydwdm: AUTHORITY_CODE,
    xkSxjbbm: '', xkSxssbm: '', bz: '',
  };
}

export interface OversizeTransportSource extends OversizeApplicationSource {
  fetchIssuedList(startDate: string, endDate: string, signal?: AbortSignal): Promise<OversizeListItem[]>;
  captureQuerySession?(): () => void;
}
export async function queryOversizeTransport(source: OversizeTransportSource, context: QueryContext): Promise<QueryPage<Record<string, unknown>>> {
  const startDate = text(context.filters.startDate), endDate = text(context.filters.endDate);
  if (!startDate || oversizeDay(startDate) !== startDate || !endDate || oversizeDay(endDate) !== endDate) throw new AppError('QUERY_INVALID', '大件运输回流需要有效的开始和结束日期');
  if (startDate > endDate) throw new AppError('QUERY_INVALID', '开始日期不能晚于结束日期');
  const assertSession = source.captureQuerySession?.() ?? (() => {});
  const items = await source.fetchIssuedList(startDate, endDate, context.signal);
  assertSession();
  if (context.signal?.aborted) throw new AppError('TASK_CANCELLED', '任务已取消');
  const rows: Record<string, unknown>[] = [], numbers = new Set<string>();
  for (const item of items) {
    if (context.signal?.aborted) throw new AppError('TASK_CANCELLED', '任务已取消');
    const reqNo = text(item.reqNo);
    if (!isHuizhouCertificate(reqNo)) continue;
    const decision = oversizeDay(item.handerTime);
    if (!decision) throw new AppError('REMOTE_REQUEST_FAILED', `大件运输证件缺少有效办理日期，无法判断回流范围（申请编号：${reqNo}）`);
    if (decision < startDate || decision > endDate) continue;
    if (numbers.has(reqNo)) throw new AppError('REMOTE_REQUEST_FAILED', `同一申请编号存在多份证件，请核对后回流（申请编号：${reqNo}）`);
    numbers.add(reqNo); rows.push(mapOversizeCertificate(item));
  }
  // Validate the entire selection before issuing per-application lookups. Do not query unrelated/date-excluded cases.
  const supplemented: Record<string, unknown>[] = [];
  for (const row of rows) {
    assertSession();
    supplemented.push(await supplementOversizeApplication(source, row, context.signal));
    assertSession();
  }
  return { rows: supplemented, page: 1, pageSize: Math.max(supplemented.length, 1), total: supplemented.length };
}
