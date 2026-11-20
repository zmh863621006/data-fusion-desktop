import { HRSS_MATTER_DEFINITIONS } from '../../plugins/guangdong-hrss/catalog';

export const HRSS_DASHBOARD_SYSTEM_ID = 'guangdong-hrss' as const;

export type HrssSyncState = 'not-synced' | 'local-only' | 'partial' | 'synced';
export type HrssTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface HrssDashboardRecord {
  matterId: string;
  data: Record<string, unknown>;
  systemId?: string;
  recordKey?: string;
  updatedAt?: number;
}
export interface HrssDashboardTask {
  matterId: string;
  status: HrssTaskStatus;
  type?: string;
  systemId?: string;
  createdAt?: number;
  finishedAt?: number;
  details?: Record<string, unknown>;
}
export interface HrssDashboardInput {
  /** Main-process verified license scope. Do not accept this value from the renderer. */
  allowedMatterIds: readonly string[];
  /** Prefer each matter's latest successful data-return snapshot, including empty snapshots. */
  records: readonly HrssDashboardRecord[];
  /** Successful data-return tasks plus the latest task for each authorized matter. */
  tasks: readonly HrssDashboardTask[];
  now?: number;
}
export interface HrssCountBucket { id: string; label: string; count: number }
export interface HrssStreetSummary {
  name: string;
  total: number;
  tracked: number;
  untracked: number;
  unknown: number;
}
export interface HrssAgingMetric {
  /** null means there is no usable evidence; zero means evidence supports a true zero. */
  value: number | null;
  evaluatedCount: number;
  unknownCount: number;
  supportedMatterCount: number;
  rule: string;
}
export interface HrssMatterSummary {
  id: string;
  name: string;
  syncState: Exclude<HrssSyncState, 'partial'>;
  total: number | null;
  lastSuccessAt: number | null;
  latestTaskStatus: HrssTaskStatus | null;
  coverage: { startDate: string | null; endDate: string | null } | null;
  statuses: HrssCountBucket[];
}
export interface HrssSubsidyMatterSummary {
  id: string;
  name: string;
  total: number | null;
  paymentSupported: boolean;
  paid: number | null;
  awaitingPayment: number | null;
  other: number | null;
}
interface HrssCoveredMetric {
  value: number | null;
  recordCount: number;
}
export interface HrssSubsidySummary {
  total: number | null;
  syncedMatterCount: number;
  matterCount: number;
  paymentTotal: number | null;
  paid: number;
  awaitingPayment: number;
  other: number;
  monthly: HrssCountBucket[];
  missingApplyDate: number;
  streets: HrssCountBucket[];
  channels: HrssCountBucket[];
  averagePaymentDays: HrssCoveredMetric;
  flexibleSubsidyMonths: HrssCoveredMetric;
  reportedApplicants: HrssCoveredMetric;
  matters: HrssSubsidyMatterSummary[];
}
export interface HrssDashboardData {
  systemId: typeof HRSS_DASHBOARD_SYSTEM_ID;
  generatedAt: number;
  syncState: HrssSyncState;
  totalRecords: number | null;
  authorizedMatterCount: number;
  syncedMatterCount: number;
  lastSuccessAt: number | null;
  matters: HrssMatterSummary[];
  ages: { total: number | null; buckets: HrssCountBucket[] };
  tracking: { total: number | null; tracked: number; untracked: number; unknown: number; streets: HrssStreetSummary[] };
  statuses: { total: number | null; buckets: HrssCountBucket[] };
  aging: { review: HrssAgingMetric; payment: HrssAgingMetric };
  subsidies: HrssSubsidySummary;
}

export class HrssDashboardAccessError extends Error {
  constructor() { super('当前授权不允许访问所请求的人社台账'); this.name = 'HrssDashboardAccessError'; }
}

const DAY = 86_400_000;
const SHANGHAI_OFFSET = 8 * 3_600_000;
const POPULATION_MATTERS = new Set([
  'unemployment', 'employment-difficulty-recognition', 'graduate-tracking-service',
  'difficult-tracking-service', 'unemployment-tracking-service', 'poverty-alleviation-personnel',
]);
const TRACKING_MATTERS = new Set(['graduate-tracking-service', 'difficult-tracking-service', 'unemployment-tracking-service']);
const SUBSIDY_REVIEW_MATTERS = new Set([
  'job-seeking-startup-subsidy', 'graduate-flexible-employment-subsidy', 'difficult-flexible-employment-subsidy',
  'one-time-job-expansion-subsidy', 'one-time-startup-subsidy', 'startup-employment-subsidy',
  'employment-internship-subsidy', 'startup-rent-subsidy', 'greater-bay-youth-living-subsidy',
]);
const PAYMENT_MATTERS = new Set([...SUBSIDY_REVIEW_MATTERS].filter((id) => id !== 'one-time-job-expansion-subsidy'));
const FLEXIBLE_SUBSIDY_MATTERS = new Set(['graduate-flexible-employment-subsidy', 'difficult-flexible-employment-subsidy']);
const APPLICANT_COUNT_MATTERS = new Set(['one-time-job-expansion-subsidy', 'startup-employment-subsidy']);
const REVIEW_MATTERS = new Set([...SUBSIDY_REVIEW_MATTERS, 'self-employment-identity', 'youth-internship-agreement']);
const AGE_BUCKETS = [
  ['under-30', '30岁以下'], ['30-39', '30–39岁'], ['40-49', '40–49岁'],
  ['50-59', '50–59岁'], ['60-plus', '60岁及以上'], ['unknown', '年龄未知'],
] as const;
const STATUS_BUCKETS = [
  ['pending', '待处理'], ['processing', '办理中'], ['awaiting-payment', '待支付'], ['paid', '已支付'],
  ['completed', '已办结 / 通过'], ['unsuccessful', '未通过 / 退回'], ['exited', '退出 / 终止'],
  ['employed', '就业 / 在岗'], ['unemployed', '失业 / 未就业'], ['unknown', '状态未知'],
] as const;
type StatusId = typeof STATUS_BUCKETS[number][0];
const STATUS_TEXT: Record<Exclude<StatusId, 'unknown'>, readonly string[]> = {
  pending: ['待提交', '待受理', '待审核', '待审批', '未备案', '未提交', '未受理', '未审核', '未审批', '待核实', '待认定', '待处理', '待初审', '待复审', '待终审'],
  processing: ['待公示', '公示环节', '公示中', '办理中', '审核中', '审批中', '核实中', '认定中', '受理中', '已受理'],
  'awaiting-payment': ['待支付', '待拨付', '待发放', '待拨款'],
  paid: ['已支付', '支付成功', '已发放', '发放成功', '支付完成', '发放完成'],
  completed: ['已办结', '办结', '已完成', '办理成功', '办理成功（审核通过）', '审核通过', '审批通过', '备案成功', '已备案', '认定成功', '已认定', '认定通过', '有效', '认定有效'],
  unsuccessful: ['审核不通过', '审批不通过', '办理失败（审核不通过）', '办理失败（审批不通过）', '办理失败（公示不通过）', '办理失败（不予受理）', '办理失败', '已驳回', '驳回', '退回', '不通过', '备案失败', '认定不通过'],
  exited: ['已退出', '已注销', '注销', '无效', '已取消', '已撤销', '撤销', '超期自动终止', '已终止', '终止'],
  employed: ['就业', '已就业', '在岗'],
  unemployed: ['失业', '未就业', '登记失业'],
};
const STATUS_LOOKUP = new Map(Object.entries(STATUS_TEXT).flatMap(([id, values]) => values.map((value) => [value, id as StatusId] as const)));
const STREET_NAMES = ['南头街道', '南山街道', '沙河街道', '蛇口街道', '招商街道', '粤海街道', '桃源街道', '西丽街道'];
const REVIEW_RULE = '列表待处理记录：申请时间距统计时点超过72小时。仅为滞留提示，不代表法定办理超期。';
const PAYMENT_RULE = '列表处于待支付：二审日期的次月结束后超过72小时。仅统计已提供二审日期的记录。';
const TASK_STATUSES: readonly string[] = ['queued', 'running', 'completed', 'failed', 'cancelled'];

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function nonnegativeCount(value: unknown): number | null {
  const count = typeof value === 'number' ? value : /^\d{1,9}$/.test(text(value)) ? Number(value) : NaN;
  return Number.isSafeInteger(count) && count >= 0 && count <= 999_999_999 ? count : null;
}
function addMetric(metric: HrssCoveredMetric, value: number | null): void {
  if (value === null) return;
  metric.value = (metric.value ?? 0) + value;
  metric.recordCount++;
}
function subsidyStreet(area: unknown): string {
  return STREET_NAMES.find((name) => text(area).includes(name)) ?? '未知街道';
}
function finiteTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime());
}
function fields(data: Record<string, unknown>, keys: readonly string[]): unknown[] {
  return keys.map((key) => data[key]).filter((value) => value !== undefined && value !== null && value !== '');
}
function buckets(definitions: readonly (readonly [string, string])[]): HrssCountBucket[] {
  return definitions.map(([id, label]) => ({ id, label, count: 0 }));
}
function shanghaiDate(now: number): { year: number; month: number; day: number } {
  const date = new Date(now + SHANGHAI_OFFSET);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
function validDateParts(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
/** Deterministic parsing: source dates without a zone are Asia/Shanghai, never OS-local time. */
function parseSourceDate(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 100_000_000_000) return null;
    return Number.isFinite(new Date(value).getTime()) ? value : null;
  }
  const source = text(value);
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(source);
  if (match) {
    const [, y, m, d, h = '0', min = '0', sec = '0', ms = '0'] = match;
    if (!validDateParts(+y, +m, +d) || +h > 23 || +min > 59 || +sec > 59) return null;
    return Date.UTC(+y, +m - 1, +d, +h, +min, +sec, +(ms.padEnd(3, '0'))) - SHANGHAI_OFFSET;
  }
  // Only accept explicit ISO zones, rejecting Date.parse's permissive date rollover.
  const iso = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(source);
  if (!iso || !validDateParts(+iso[1], +iso[2], +iso[3])) return null;
  const result = Date.parse(source);
  return Number.isFinite(result) ? result : null;
}
function birthParts(value: unknown): { year: number; month: number; day: number } | null {
  const source = text(value);
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(source);
  if (compact) return validDateParts(+compact[1], +compact[2], +compact[3])
    ? { year: +compact[1], month: +compact[2], day: +compact[3] } : null;
  const time = parseSourceDate(value);
  return time === null ? null : shanghaiDate(time);
}
function identityBirth(value: unknown): { year: number; month: number; day: number } | null {
  const card = text(value).toUpperCase();
  if (!/^[1-9]\d{16}[\dX]$/.test(card)) return null;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checksum = '10X98765432'[weights.reduce((sum, weight, i) => sum + Number(card[i]) * weight, 0) % 11];
  return checksum === card[17] ? birthParts(card.slice(6, 14)) : null;
}
function ageOf(data: Record<string, unknown>, now: number): number | null {
  for (const value of fields(data, ['age'])) {
    const age = typeof value === 'number' ? value : /^\d{1,3}$/.test(text(value)) ? Number(value) : NaN;
    if (Number.isInteger(age) && age >= 0 && age <= 120) return age;
  }
  let birth = fields(data, ['birthDate', 'birthday', 'dateOfBirth', 'aac006']).map(birthParts).find((value) => value !== null);
  birth ??= fields(data, ['cardNumber', 'idCardNumber']).map(identityBirth).find((value) => value !== null);
  if (!birth) return null;
  const current = shanghaiDate(now);
  const age = current.year - birth.year - (current.month < birth.month || (current.month === birth.month && current.day < birth.day) ? 1 : 0);
  return age >= 0 && age <= 120 ? age : null;
}
function statusOf(data: Record<string, unknown>): StatusId {
  for (const value of fields(data, ['currentLink', 'applyStatus', 'rdStatus', 'shStatus', 'currentStatus', 'taskStatus', 'payStatus', 'registrationStatus', 'employmentStatus', 'jyzt'])) {
    const status = STATUS_LOOKUP.get(text(value));
    if (status) return status;
  }
  return 'unknown';
}
function trackingOf(data: Record<string, unknown>): 'tracked' | 'untracked' | 'unknown' {
  const value = data.entryServiceSituation;
  if (value === true || value === 1 || ['是', '1', 'Y', 'yes', '已跟踪', '已服务'].includes(text(value))) return 'tracked';
  if (value === false || value === 0 || ['否', '0', 'N', 'no', '未跟踪', '未服务'].includes(text(value))) return 'untracked';
  return 'unknown';
}
function streetOf(data: Record<string, unknown>): string {
  const area = text(data.belongArea).split(/[/>]/).at(-1)?.trim().replace(/街道办事处$/, '街道') ?? '';
  return STREET_NAMES.includes(area) ? area : '未知街道';
}
function nextMonthEnd(time: number): number {
  const { year, month } = shanghaiDate(time);
  return Date.UTC(year, month + 1, 1) - SHANGHAI_OFFSET - 1;
}
function taskTime(task: HrssDashboardTask): number {
  return finiteTime(task.createdAt) ? task.createdAt : finiteTime(task.finishedAt) ? task.finishedAt : 0;
}
function coverageDate(value: unknown): string | null {
  const source = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source) || parseSourceDate(source) === null) return null;
  return source;
}

/**
 * Aggregates authorized, local list records only. No network, detail lookup, money summation,
 * mutable cache or raw status/area/identity values enter the returned object.
 */
export function buildHrssDashboard(input: HrssDashboardInput): HrssDashboardData {
  const now = input.now ?? Date.now();
  if (!finiteTime(now)) throw new Error('人社统计时间无效');
  const definitions = new Map(HRSS_MATTER_DEFINITIONS.map((matter) => [matter.id, matter]));
  const allowed = new Set(input.allowedMatterIds);
  if (!allowed.size || [...allowed].some((id) => !definitions.has(id))) throw new HrssDashboardAccessError();
  for (const item of [...input.records, ...input.tasks]) {
    if (!allowed.has(item.matterId) || (item.systemId && item.systemId !== HRSS_DASHBOARD_SYSTEM_ID)) throw new HrssDashboardAccessError();
  }
  // Preserve the catalog order. Never trust a record-provided title or arbitrary status label.
  const selected = HRSS_MATTER_DEFINITIONS.filter((matter) => allowed.has(matter.id));
  const recordsByMatter = new Map<string, HrssDashboardRecord[]>();
  for (const matter of selected) recordsByMatter.set(matter.id, []);
  const keyedRecords = new Map<string, HrssDashboardRecord>();
  for (const record of input.records) {
    if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) throw new Error('人社本地记录格式无效');
    if (record.recordKey) {
      const key = `${record.matterId}\u0000${record.recordKey}`;
      const previous = keyedRecords.get(key);
      if (!previous || (record.updatedAt ?? 0) >= (previous.updatedAt ?? 0)) keyedRecords.set(key, record);
    } else recordsByMatter.get(record.matterId)!.push(record);
  }
  for (const record of keyedRecords.values()) recordsByMatter.get(record.matterId)!.push(record);
  const tasks = input.tasks.filter((task) => !task.type || task.type === 'data-return');
  const ageCounts = buckets(AGE_BUCKETS);
  const statusCounts = buckets(STATUS_BUCKETS);
  const tracking = { total: null as number | null, tracked: 0, untracked: 0, unknown: 0, streets: [] as HrssStreetSummary[] };
  const streets = new Map<string, HrssStreetSummary>();
  let ageHasEvidence = false;
  let trackingHasEvidence = false;
  const matters: HrssMatterSummary[] = selected.map((matter) => {
    const records = recordsByMatter.get(matter.id)!;
    const matterTasks = tasks.filter((task) => task.matterId === matter.id);
    const successful = matterTasks.filter((task) => task.status === 'completed' && finiteTime(task.finishedAt) && task.finishedAt <= now);
    const lastSuccessAt = successful.length ? Math.max(...successful.map((task) => task.finishedAt!)) : null;
    const lastSuccessfulTask = successful.find((task) => task.finishedAt === lastSuccessAt);
    const pendingDates = lastSuccessfulTask?.details?.dateFilterStatus === 'pending';
    const startDate = pendingDates ? null : coverageDate(lastSuccessfulTask?.details?.startDate);
    const endDate = pendingDates ? null : coverageDate(lastSuccessfulTask?.details?.endDate);
    const coverage = startDate || endDate ? { startDate, endDate } : null;
    const latestTask = [...matterTasks].sort((a, b) => taskTime(b) - taskTime(a))[0];
    const syncState = lastSuccessAt !== null ? 'synced' : records.length ? 'local-only' : 'not-synced';
    const hasEvidence = syncState !== 'not-synced';
    const localStatuses = buckets(STATUS_BUCKETS);
    if (POPULATION_MATTERS.has(matter.id) && hasEvidence) ageHasEvidence = true;
    if (TRACKING_MATTERS.has(matter.id) && hasEvidence) trackingHasEvidence = true;
    for (const { data } of records) {
      const status = statusOf(data);
      localStatuses.find((bucket) => bucket.id === status)!.count++;
      statusCounts.find((bucket) => bucket.id === status)!.count++;
      if (POPULATION_MATTERS.has(matter.id)) {
        const age = ageOf(data, now);
        const index = age === null ? 5 : age < 30 ? 0 : age < 40 ? 1 : age < 50 ? 2 : age < 60 ? 3 : 4;
        ageCounts[index].count++;
      }
      if (TRACKING_MATTERS.has(matter.id)) {
        const status = trackingOf(data);
        tracking[status]++;
        const name = streetOf(data);
        const street = streets.get(name) ?? { name, total: 0, tracked: 0, untracked: 0, unknown: 0 };
        street.total++;
        street[status]++;
        streets.set(name, street);
      }
    }
    const latestTaskStatus = latestTask && TASK_STATUSES.includes(latestTask.status) ? latestTask.status : null;
    return { id: matter.id, name: matter.name, syncState, total: hasEvidence ? records.length : null, lastSuccessAt, latestTaskStatus, coverage, statuses: localStatuses };
  });
  tracking.total = trackingHasEvidence ? tracking.tracked + tracking.untracked + tracking.unknown : null;
  tracking.streets = [...streets.values()].sort((a, b) => b.total - a.total || STREET_NAMES.indexOf(a.name) - STREET_NAMES.indexOf(b.name));
  const agingMetric = (kind: 'review' | 'payment'): HrssAgingMetric => {
    const supported = kind === 'review' ? REVIEW_MATTERS : PAYMENT_MATTERS;
    const eligibleMatters = matters.filter((matter) => supported.has(matter.id));
    const evidence = eligibleMatters.some((matter) => matter.total !== null);
    let evaluatedCount = 0;
    let unknownCount = 0;
    let count = 0;
    for (const matter of eligibleMatters) {
      for (const { data } of recordsByMatter.get(matter.id)!) {
        const state = text(matter.id === 'youth-internship-agreement' ? data.applyStatus : data.currentLink);
        if (!STATUS_LOOKUP.has(state)) { unknownCount++; continue; }
        const reviewStates = matter.id === 'self-employment-identity' ? ['待提交', '待受理', '待审核']
          : matter.id === 'youth-internship-agreement' ? ['未备案'] : ['待审批', '待公示', '待审核'];
        const candidate = kind === 'review' ? reviewStates.includes(state) : state === '待支付';
        if (!candidate) { evaluatedCount++; continue; }
        const date = parseSourceDate(kind === 'review' ? data.applyDate : data.examineDateSeconde);
        if (date === null || date > now) { unknownCount++; continue; }
        evaluatedCount++;
        if (now > (kind === 'review' ? date : nextMonthEnd(date)) + 3 * DAY) count++;
      }
    }
    return {
      value: !evidence || (evaluatedCount === 0 && unknownCount > 0) ? null : count,
      evaluatedCount, unknownCount, supportedMatterCount: eligibleMatters.length, rule: kind === 'review' ? REVIEW_RULE : PAYMENT_RULE,
    };
  };
  const syncedMatterCount = matters.filter((matter) => matter.syncState === 'synced').length;
  const hasEvidence = matters.some((matter) => matter.total !== null);
  const totalRecords = hasEvidence ? matters.reduce((sum, matter) => sum + (matter.total ?? 0), 0) : null;
  const subsidyMatters = matters.filter((matter) => SUBSIDY_REVIEW_MATTERS.has(matter.id));
  const monthly = new Map<string, number>();
  const streetCounts = new Map<string, number>();
  const channelCounts = buckets([['online', '线上申请'], ['counter', '窗口申请'], ['matched', '免申比对'], ['unknown', '其他 / 未知']]);
  const averagePaymentDays: HrssCoveredMetric = { value: null, recordCount: 0 };
  const flexibleSubsidyMonths: HrssCoveredMetric = { value: null, recordCount: 0 };
  const reportedApplicants: HrssCoveredMetric = { value: null, recordCount: 0 };
  let missingApplyDate = 0;
  let paymentTotal = 0;
  let paid = 0;
  let awaitingPayment = 0;
  let other = 0;
  const subsidyRows: HrssSubsidyMatterSummary[] = subsidyMatters.map((matter) => {
    const paymentSupported = HRSS_MATTER_DEFINITIONS.find((item) => item.id === matter.id)?.columns.some((column) => column.key === 'payStatus') ?? false;
    let localPaid = 0;
    let localAwaiting = 0;
    let localOther = 0;
    if (matter.total !== null) for (const { data } of recordsByMatter.get(matter.id)!) {
      const appliedAt = parseSourceDate(data.applyDate);
      if (appliedAt !== null && appliedAt <= now) {
        const { year, month } = shanghaiDate(appliedAt);
        const key = `${year}-${String(month).padStart(2, '0')}`;
        monthly.set(key, (monthly.get(key) ?? 0) + 1);
      } else missingApplyDate++;
      const street = subsidyStreet(data.applyAddress ?? data.processArea);
      streetCounts.set(street, (streetCounts.get(street) ?? 0) + 1);
      const channel = text(data.applyChannel) || text(data.dataOrigin);
      const channelId = /网站|网上|线上|网办|^创业一件事（深圳）$/.test(channel) ? 'online'
        : /窗口|线下|现场/.test(channel) ? 'counter' : channel === '免申请-省比对' ? 'matched' : 'unknown';
      channelCounts.find((bucket) => bucket.id === channelId)!.count++;
      if (FLEXIBLE_SUBSIDY_MATTERS.has(matter.id)) addMetric(flexibleSubsidyMonths, nonnegativeCount(data.subsidyMonthCount));
      if (APPLICANT_COUNT_MATTERS.has(matter.id)) addMetric(reportedApplicants, nonnegativeCount(data.applyCount));
      if (paymentSupported) {
        const status = STATUS_LOOKUP.get(text(data.payStatus));
        if (status === 'paid') {
          localPaid++;
          const paidAt = parseSourceDate(data.payDate);
          if (appliedAt !== null && paidAt !== null && appliedAt <= paidAt && paidAt <= now) {
            const days = Math.floor((paidAt + SHANGHAI_OFFSET) / DAY) - Math.floor((appliedAt + SHANGHAI_OFFSET) / DAY);
            addMetric(averagePaymentDays, days);
          }
        }
        else if (status === 'awaiting-payment') localAwaiting++;
        else localOther++;
      }
    }
    if (matter.total !== null && paymentSupported) {
      paymentTotal += matter.total;
      paid += localPaid;
      awaitingPayment += localAwaiting;
      other += localOther;
    }
    return { id: matter.id, name: matter.name, total: matter.total, paymentSupported,
      paid: matter.total !== null && paymentSupported ? localPaid : null,
      awaitingPayment: matter.total !== null && paymentSupported ? localAwaiting : null,
      other: matter.total !== null && paymentSupported ? localOther : null };
  });
  const subsidyHasEvidence = subsidyMatters.some((matter) => matter.total !== null);
  const paymentHasEvidence = subsidyRows.some((matter) => matter.total !== null && matter.paymentSupported);
  if (averagePaymentDays.value !== null) averagePaymentDays.value = Math.round(10 * averagePaymentDays.value / averagePaymentDays.recordCount) / 10;
  const subsidies: HrssSubsidySummary = {
    total: subsidyHasEvidence ? subsidyMatters.reduce((sum, matter) => sum + (matter.total ?? 0), 0) : null,
    syncedMatterCount: subsidyMatters.filter((matter) => matter.syncState === 'synced').length,
    matterCount: subsidyMatters.length,
    paymentTotal: paymentHasEvidence ? paymentTotal : null,
    paid, awaitingPayment, other,
    monthly: [...monthly].sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => ({ id, label: id, count })),
    missingApplyDate,
    streets: [...streetCounts].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ id: label, label, count })),
    channels: channelCounts,
    averagePaymentDays, flexibleSubsidyMonths, reportedApplicants,
    matters: subsidyRows,
  };
  const successTimes = matters.flatMap((matter) => matter.lastSuccessAt === null ? [] : [matter.lastSuccessAt]);
  return {
    systemId: HRSS_DASHBOARD_SYSTEM_ID, generatedAt: now,
    syncState: syncedMatterCount === matters.length ? 'synced' : syncedMatterCount ? 'partial' : hasEvidence ? 'local-only' : 'not-synced',
    totalRecords, authorizedMatterCount: matters.length, syncedMatterCount,
    lastSuccessAt: successTimes.length ? Math.max(...successTimes) : null,
    matters, ages: { total: ageHasEvidence ? ageCounts.reduce((sum, bucket) => sum + bucket.count, 0) : null, buckets: ageCounts },
    tracking, statuses: { total: totalRecords, buckets: statusCounts },
    aging: { review: agingMetric('review'), payment: agingMetric('payment') },
    subsidies,
  };
}
