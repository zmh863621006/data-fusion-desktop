import { AppError } from '../../core/errors/app-error';
import type { HrssColumn, HrssMatterDefinition } from './catalog';

/** Verified against the source BBE955 dictionary, not inferred from the print button. */
const STATUS_NAMES: Readonly<Record<string, string>> = {
  '01': '待提交', '02': '待受理', '03': '待审核', '04': '待公示', '05': '待审批', '06': '待支付',
  '07': '办理成功', '08': '办理失败（不予受理）', '09': '办理失败（审核不通过）',
  '10': '办理失败（公示不通过）', '11': '办理失败（审批不通过）', '12': '办理失败（不予支付）', '99': '取消申请',
};
const STATUS_CODES = new Map(Object.entries(STATUS_NAMES).map(([code, name]) => [name, code]));
const column = (key: string, label: string, source = key, sensitive = false): HrssColumn => ({ key, label, sources: [source], ...(sensitive ? { sensitive: true } : {}) });
export const HRSS_HANDLING_COLUMNS: HrssColumn[] = [
  column('handlingRecordCount', '办理记录数'), column('handlingRecordStatus', '办理记录状态'),
];

const streetColumns: HrssColumn[] = [
  column('unitName', '单位名称', 'aab004'), column('unitNumber', '统一社会信用代码', 'bcea9y'),
  column('applyName', '联系人', 'aae004', true), column('applyNumber', '联系人手机', 'aae005', true),
  column('applyCount', '申请人数', 'number'), column('applyChannel', '办理渠道', 'bae025Name'),
  column('applyBh', '申请编号', 'bce097'), column('applyDate', '申请日期', 'adc705'),
  column('applyAddress', '申请受理地点', 'bdezh2Name'), column('currentLink', '当前环节', 'bbe955Name'),
  column('examineDateFirst', '审核汇总日期', 'shhzDate'), column('examineDateSeconde', '审批汇总日期', 'sphzDate'),
  column('payDate', '支付日期', 'bczf52'), column('payStatus', '支付状态', 'bccfa4Name'),
  ...HRSS_HANDLING_COLUMNS,
];

/** These are list sources only. The sole additional read is the source's handling-record list. */
export const HRSS_STREET_PROFILES: Record<string, Pick<HrssMatterDefinition, 'columns' | 'sources'>> = Object.fromEntries([
  ['enterprise-hiring-difficult-personnel-subsidy', 'xnjyknrysbbt'],
  ['enterprise-hiring-difficult-personnel-post-subsidy', 'ybxgwbt'],
  ['retired-military-employment-subsidy', 'xntyjrjybt'],
].map(([id, kind]) => [id, {
  columns: streetColumns,
  sources: [{ id: kind, path: `/subsidize/main/rest/subsidy/${kind}/progress/unit/list`, method: 'GET', identity: [['applyBh']] }],
}]));

export const HRSS_HANDLING_RECORD_PATH = '/subsidize/main/rest/subsidy/common/operate-log';
export interface HrssStreetHandlingClient {
  requestHandlingRecords(params: Record<string, unknown>, signal?: AbortSignal): Promise<{ rows: Record<string, unknown>[]; total: number }>;
}
export interface HrssStreetHandlingRecord {
  step: string;
  operator: string;
  organization: string;
  handledAt: string;
  action: string;
  result: string;
  opinion: string;
}
export interface HrssStreetHandlingResult {
  handlingRecordCount: number;
  handlingRecordStatus: 'collected' | 'skipped-pending';
  handlingRecords: HrssStreetHandlingRecord[];
}

const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new AppError('TASK_CANCELLED', '回流任务已取消'); };
const failed = (message: string) => new AppError('REMOTE_REQUEST_FAILED', `${message}，未保存本次结果`, { retryable: false });
const scalar = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const normalizeName = (value: string): string => value.replace(/\(/g, '（').replace(/\)/g, '）');

export function isHrssStreetPendingAcceptance(raw: Record<string, unknown>): boolean {
  const code = scalar(raw.bbe955), name = normalizeName(scalar(raw.bbe955Name));
  const nameCode = STATUS_CODES.get(name);
  if (code && !Object.hasOwn(STATUS_NAMES, code)) throw failed('街道办列表包含无法识别的办理状态');
  if (code && nameCode && code !== nameCode) throw failed('街道办列表的办理状态与名称不一致');
  const status = code || nameCode;
  if (!status) throw failed('街道办列表缺少可核验的办理状态');
  return status === '02';
}

/** Source SpHandlingRecord uses bzd417/aaa025, not the list's batch id bke910. */
export async function enrichHrssStreetRecord(client: HrssStreetHandlingClient, raw: Record<string, unknown>, signal?: AbortSignal): Promise<HrssStreetHandlingResult> {
  cancelled(signal);
  if (isHrssStreetPendingAcceptance(raw)) return { handlingRecordCount: 0, handlingRecordStatus: 'skipped-pending', handlingRecords: [] };
  const businessId = scalar(raw.bzd417);
  if (!businessId || businessId.length > 256 || /[\s*•●\u0000-\u001f]/.test(businessId)) throw failed('街道办列表缺少可用的办理记录关联编号');
  const records: HrssStreetHandlingRecord[] = [], ids = new Set<string>(), pageFingerprints = new Set<string>();
  let expected: number | undefined;
  const pageSize = 200, maxRecords = 10_000;
  for (let current = 1; current <= maxRecords / pageSize; current++) {
    cancelled(signal);
    const response = await client.requestHandlingRecords({ current, size: pageSize, bzd417: businessId, aaa025: '02' }, signal);
    cancelled(signal);
    if (!Number.isSafeInteger(response.total) || response.total < 0 || response.total > maxRecords || !Array.isArray(response.rows)) throw failed('办理记录总数无效或超出保护限制');
    expected ??= response.total;
    if (response.total !== expected) throw failed('回流期间办理记录总数发生变化');
    if (response.rows.length !== Math.min(pageSize, expected - records.length)) throw failed('办理记录分页条数与总数不一致');
    const pageRecords: HrssStreetHandlingRecord[] = [];
    const pageIds: string[] = [];
    for (const row of response.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw failed('办理记录包含无法识别的数据');
      const id = scalar(row.bcea9j);
      // Some source responses omit the component's configured bcea9j row key entirely.
      // Optional real ids provide extra validation; absent ids never cause legitimate identical events to be merged.
      if (id && !/[*•●]/.test(id)) {
        if (ids.has(id)) throw failed('办理记录包含重复分页或重复编号');
        ids.add(id);
      }
      pageIds.push(id);
      pageRecords.push({
        step: scalar(row.bzd408Name), action: scalar(row.bae045Name), opinion: scalar(row.bee071),
        handledAt: scalar(row.bcbpjb), operator: scalar(row.bae046Name), organization: scalar(row.bab019Name), result: '',
      });
    }
    const fingerprint = JSON.stringify([pageIds, pageRecords]);
    if (pageRecords.length && pageFingerprints.has(fingerprint)) throw failed('办理记录包含重复分页');
    pageFingerprints.add(fingerprint);
    records.push(...pageRecords);
    if (records.length === expected) return { handlingRecordCount: records.length, handlingRecordStatus: 'collected', handlingRecords: records };
  }
  throw failed('办理记录尚未获取完整');
}
