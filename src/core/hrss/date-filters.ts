import type { BusinessMatter } from '../query/types';

function localDate(time: number): string { return new Date(time + 8 * 3_600_000).toISOString().slice(0, 10); }

export function hrssDefaultDateFilters(matterId: string, now = Date.now()): { startDate: string; endDate: string } {
  const today = localDate(now);
  return { startDate: matterId === 'unemployment' ? '2025-05-01' : `${today.slice(0, 7)}-01`, endDate: today };
}

export function hrssDateFilter(matterId: string): NonNullable<BusinessMatter['dateFilter']> {
  if (matterId === 'unemployment') return { mode: 'applied', message: '按所选登记日期查询原系统列表。' };
  return { mode: 'pending', message: matterId === 'unemployment-tracking-service'
    ? '所选日期仅记录到任务，本次仍按原规则查询本月创建的服务对象。'
    : '所选日期仅记录到任务，本次仍按原列表条件回流。' };
}

export function validateHrssDateFilters(filters: Record<string, unknown>): void {
  const start = filters.startDate, end = filters.endDate;
  // Old main-process callers with no date selection continue to use the original source defaults.
  if (start === undefined && end === undefined) return;
  const valid = (value: unknown): value is string => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (!valid(start) || !valid(end)) throw new Error('请选择有效的开始日期和结束日期');
  if (start > end) throw new Error('开始日期不能晚于结束日期');
}

/** Only effective remote dates enter startDate/endDate, which drive exports and dashboard coverage. */
export function hrssReturnDateDetails(matterId: string, filters: Record<string, unknown>): Record<string, unknown> {
  validateHrssDateFilters(filters);
  const requested = { requestedStartDate: filters.startDate, requestedEndDate: filters.endDate };
  if (hrssDateFilter(matterId).mode === 'applied') return { ...requested, dateFilterStatus: 'applied', dateBasis: 'bce089',
    startDate: filters.startDate, endDate: filters.endDate };
  return { ...requested, dateFilterStatus: 'pending', dateScope: matterId === 'unemployment-tracking-service' ? 'current-month' : 'original-list' };
}

export function hrssTaskDateLabel(details?: Record<string, unknown>): string {
  if (details?.dateFilterStatus === 'pending') {
    const start = typeof details.requestedStartDate === 'string' ? details.requestedStartDate : '—';
    const end = typeof details.requestedEndDate === 'string' ? details.requestedEndDate : '—';
    return `所选 ${start} 至 ${end}（日期筛选待接入）；本批次按${details.dateScope === 'current-month' ? '原规则的本月范围' : '原列表条件'}回流`;
  }
  const start = typeof details?.startDate === 'string' ? details.startDate : '';
  const end = typeof details?.endDate === 'string' ? details.endDate : '';
  return start || end ? `${start || '—'} 至 ${end || '—'}` : '原列表条件';
}
