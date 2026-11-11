import { AppError } from '../../core/errors/app-error';
import type { QueryContext, QueryPage } from '../../core/query/types';
import type { ArchivePage, PractitionerCategory } from './client';

const PAGE_SIZE = 1_000;
const MAX_PAGES = 100;
const AUTHORITY_NAME = '惠州市交通运输局';
const AUTHORITY_CODE = '114413000071877877';

export interface PractitionerQueryTransport {
  fetchArchivePage(category: PractitionerCategory, startDate: string, endDate: string, page: number, pageSize: number, signal?: AbortSignal): Promise<ArchivePage>;
}

export interface PractitionerRecord extends Record<string, unknown> {
  xzxkmc: string;
  xkXdrMc: string;
  xkXdrZjhm: string;
  xkJdrq: string;
}

const text = (row: Record<string, unknown>, key: string): string => typeof row[key] === 'string' ? row[key].trim() : String(row[key] ?? '').trim();

function timestamp(value: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value.replace(/\//g, '-'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function pickTaxiDates(row: Record<string, unknown>): [string, string] {
  const online = text(row, 'WangYueCongYeZiGeZhengFaZhengRiQi');
  const cruise = text(row, 'XunYouCongYeZiGeZhengFaZhengRiQi');
  let useOnline = Boolean(online);
  if (online && cruise) {
    const onlineTime = timestamp(online);
    const cruiseTime = timestamp(cruise);
    useOnline = onlineTime !== null && (cruiseTime === null || onlineTime >= cruiseTime);
  }
  return useOnline
    ? [online, text(row, 'WangYueCongYeZiGeZhengYouXiaoRiQi')]
    : [cruise, text(row, 'XunYouCongYeZiGeZhengYouXiaoRiQi')];
}

export function mapPractitionerRecord(row: Record<string, unknown>, category: PractitionerCategory): PractitionerRecord {
  const [decisionDate, validUntil] = category === 'taxi'
    ? pickTaxiDates(row)
    : [text(row, 'CongYeZiGeZhengFaZhengRiQi'), text(row, 'CongYeZiGeZhengYouXiaoRiQi')];
  const certificateNo = text(row, 'CongYeZiGeZhengHao');
  return {
    xzxkmc: text(row, 'CongYeZiGeLeiBie'),
    xkXdrMc: text(row, 'XingMing'),
    xkXdrLb: '自然人',
    xkXdrShxym: '',
    xkXdrGszc: '',
    xkXdrZzjg: '',
    xkXdrSwdj: '',
    xkXdrSydw: '',
    xkXdrShzz: '',
    xkFrdb: '',
    xkFrZjlx: '',
    xkFrZjhm: '',
    xkXdrZjlx: '身份证',
    xkXdrZjhm: certificateNo,
    xkXkws: '从业资格证核发',
    xkWsh: '',
    xkXklb: '普通',
    xkXkzs: '',
    xkXkbh: '',
    xkNr: '从业资格证核发',
    xkJdrq: decisionDate,
    xkYxqz: decisionDate,
    xkYxqzi: validUntil,
    xkXkjg: AUTHORITY_NAME,
    xkXkjgdm: AUTHORITY_CODE,
    xkZt: '1',
    xkLydw: AUTHORITY_NAME,
    xkLydwdm: AUTHORITY_CODE,
    xkSxjbbm: '',
    xkSxssbm: '',
    bz: '',
  };
}

async function fetchCategory(
  transport: PractitionerQueryTransport,
  category: PractitionerCategory,
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
): Promise<PractitionerRecord[]> {
  const first = await transport.fetchArchivePage(category, startDate, endDate, 1, PAGE_SIZE, signal);
  const pageCount = Math.ceil(first.total / PAGE_SIZE);
  if (pageCount > MAX_PAGES) throw new AppError('REMOTE_REQUEST_FAILED', `从业人员数据超过 ${MAX_PAGES * PAGE_SIZE} 条安全上限，请缩小日期范围`);
  const rows = [...first.items];
  for (let page = 2; page <= pageCount; page += 1) {
    if (signal?.aborted) throw new AppError('TASK_CANCELLED', '任务已取消');
    const next = await transport.fetchArchivePage(category, startDate, endDate, page, PAGE_SIZE, signal);
    rows.push(...next.items);
    if (next.items.length === 0) break;
  }
  return rows.map((row) => mapPractitionerRecord(row, category));
}

export async function queryPractitionerCategory(
  transport: PractitionerQueryTransport,
  category: PractitionerCategory,
  context: QueryContext,
): Promise<QueryPage<PractitionerRecord>> {
  const startDate = String(context.filters.startDate ?? '').trim();
  const endDate = String(context.filters.endDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new AppError('QUERY_INVALID', '从业人员回流需要有效的开始和结束日期');
  }
  if (startDate > endDate) throw new AppError('QUERY_INVALID', '开始日期不能晚于结束日期');
  const begin = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  if (!Number.isFinite(begin.getTime()) || !Number.isFinite(end.getTime()) || begin.toISOString().slice(0,10) !== startDate || end.toISOString().slice(0,10) !== endDate) {
    throw new AppError('QUERY_INVALID', '请输入有效日期');
  }
  begin.setUTCDate(begin.getUTCDate() - 1);
  const rows = await fetchCategory(transport, category, begin.toISOString().slice(0, 10), endDate, context.signal);
  return { rows, page: 1, pageSize: Math.max(rows.length, 1), total: rows.length };
}

export async function queryPractitionerData(
  transport: PractitionerQueryTransport,
  context: QueryContext,
): Promise<QueryPage<PractitionerRecord>> {
  const [road, taxi] = await Promise.all([
    queryPractitionerCategory(transport, 'road', context),
    queryPractitionerCategory(transport, 'taxi', context),
  ]);
  const rows = [...road.rows, ...taxi.rows];
  return { rows, page: 1, pageSize: Math.max(rows.length, 1), total: rows.length };
}
