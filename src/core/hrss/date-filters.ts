import type { BusinessMatter } from '../query/types';

function localDate(time: number): string { return new Date(time + 8 * 3_600_000).toISOString().slice(0, 10); }

export function hrssDefaultDateFilters(matterId: string, now = Date.now()): { startDate: string; endDate: string } {
  const today = localDate(now);
  return { startDate: matterId === 'unemployment' ? '2025-05-01' : `${today.slice(0, 7)}-01`, endDate: today };
}

export function hrssDateFilter(matterId: string): NonNullable<BusinessMatter['dateFilter']> {
  const basis = hrssDateBasis(matterId);
  if (basis) return { mode: 'applied', message: matterId === 'youth-internship-agreement'
    ? '审核列表按申请日期、查询列表按见习开始日期筛选；两个列表分别保留。'
    : `按所选${basis.label}查询原系统列表。${SUBDISTRICT_IDS.has(matterId) ? '仅非待受理办件继续提取全部办理记录。' : ''}` };
  return { mode: 'pending', message: matterId === 'poverty-alleviation-personnel'
    ? '原站脱贫人员列表未提供日期条件，当前暂停该事项回流，避免按所选日期执行无约束查询。'
    : '该事项日期条件尚未验证，所选日期仅记录到任务。' };
}

const SUBSIDY_IDS = new Set(['self-employment-identity', 'job-seeking-startup-subsidy',
  'graduate-flexible-employment-subsidy', 'difficult-flexible-employment-subsidy', 'one-time-startup-subsidy',
  'startup-rent-subsidy', 'startup-employment-subsidy', 'employment-internship-subsidy', 'greater-bay-youth-living-subsidy']);
const SUBDISTRICT_IDS = new Set(['enterprise-hiring-difficult-personnel-subsidy',
  'enterprise-hiring-difficult-personnel-post-subsidy', 'startup-training', 'retired-military-employment-subsidy']);

/** Match actual source controls, rather than assuming every list uses application dates. */
export function hrssDateBasis(matterId: string): { field: string; label: string } | undefined {
  if (matterId === 'unemployment') return { field: 'bce089', label: '登记日期' };
  if (matterId === 'employment-difficulty-recognition') return { field: 'cdc138', label: '申请日期' };
  if (matterId === 'youth-internship-unit') return { field: 'cdc111', label: '申请日期' };
  if (matterId === 'youth-internship-agreement') return { field: 'review:cdc111;registration:bae062', label: '审核申请日期／查询见习开始日期' };
  if (['graduate-tracking-service', 'difficult-tracking-service', 'unemployment-tracking-service'].includes(matterId)) return { field: 'bae003', label: '服务对象创建日期' };
  if (matterId === 'startup-training') return { field: 'BCE089', label: '申请日期' };
  if (SUBSIDY_IDS.has(matterId) || SUBDISTRICT_IDS.has(matterId)) return { field: 'adc705', label: '申请日期' };
  return undefined;
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
  const basis = hrssDateBasis(matterId);
  if (basis) return { ...requested, dateFilterStatus: 'applied', dateBasis: basis.field, dateBasisLabel: basis.label,
    startDate: filters.startDate, endDate: filters.endDate };
  return { ...requested, dateFilterStatus: 'pending', dateScope: matterId === 'poverty-alleviation-personnel' ? 'blocked-unverified-date' : 'original-list' };
}

export function hrssTaskDateLabel(details?: Record<string, unknown>): string {
  if (details?.dateFilterStatus === 'pending') {
    const start = typeof details.requestedStartDate === 'string' ? details.requestedStartDate : '—';
    const end = typeof details.requestedEndDate === 'string' ? details.requestedEndDate : '—';
    if (details.dateScope === 'blocked-unverified-date') return `所选 ${start} 至 ${end}（原站日期条件未确认，已暂停回流）`;
    return `所选 ${start} 至 ${end}（日期筛选待接入）；本批次按${details.dateScope === 'current-month' ? '原规则的本月范围' : '原列表条件'}回流`;
  }
  const start = typeof details?.startDate === 'string' ? details.startDate : '';
  const end = typeof details?.endDate === 'string' ? details.endDate : '';
  return start || end ? `${start || '—'} 至 ${end || '—'}` : '原列表条件';
}
