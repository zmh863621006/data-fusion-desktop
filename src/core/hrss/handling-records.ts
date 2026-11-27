import shenzhenCatalog from '../../plugins/shenzhen-integrated-services/matter-catalog.json';

/** These four street-office matters collect workflow history in addition to their list rows. */
const handlingMatterIds = new Set([
  'enterprise-hiring-difficult-personnel-subsidy',
  'enterprise-hiring-difficult-personnel-post-subsidy',
  'startup-training',
  'retired-military-employment-subsidy',
]);

export function hasHrssHandlingRecords(systemId: string, matterId: string): boolean {
  return systemId === 'guangdong-hrss' && handlingMatterIds.has(matterId);
}

const shenzhenMatterIds = new Set(shenzhenCatalog.matters.map(matter => matter.id));

export function hasHandlingRecords(systemId: string, matterId: string): boolean {
  return hasHrssHandlingRecords(systemId, matterId)
    || systemId === shenzhenCatalog.id && shenzhenMatterIds.has(matterId);
}

export interface HrssHandlingRecord {
  operator: string;
  organization: string;
  handledAt: string;
  step: string;
  action: string;
  result: string;
  opinion: string;
}

export const HRSS_HANDLING_COLUMNS: ReadonlyArray<{ key: keyof HrssHandlingRecord; label: string }> = [
  { key: 'operator', label: '办理人员' },
  { key: 'organization', label: '办理机构' },
  { key: 'handledAt', label: '办理时间' },
  { key: 'step', label: '办理环节' },
  { key: 'action', label: '办理操作' },
  { key: 'result', label: '办理结果' },
  { key: 'opinion', label: '办理意见' },
];

export interface HandlingRecord extends HrssHandlingRecord {
  reviewer?: string;
  receivedAt?: string;
  operatedAt?: string;
  reviewedAt?: string;
  completedAt?: string;
  publicityStartedAt?: string;
  stageType?: string;
  rawResult?: string;
  withdrawn?: boolean;
  sourceRecordId?: string;
}

export type HandlingColumn = { key: keyof HandlingRecord; label: string };

export const SHENZHEN_HANDLING_COLUMNS: readonly HandlingColumn[] = [
  { key: 'step', label: '办理环节' },
  { key: 'action', label: '环节类型' },
  { key: 'operator', label: '操作人' },
  { key: 'operatedAt', label: '操作时间' },
  { key: 'reviewer', label: '审批人' },
  { key: 'reviewedAt', label: '审批时间' },
  { key: 'result', label: '办理结果' },
  { key: 'opinion', label: '办理意见' },
  { key: 'receivedAt', label: '环节接收时间' },
  { key: 'completedAt', label: '完成时间' },
  { key: 'publicityStartedAt', label: '公示开始时间' },
  { key: 'organization', label: '办理机构' },
  { key: 'withdrawn', label: '是否撤回' },
];

/** Export preserves the complete declared process snapshot, including optional source identifiers. */
export const SHENZHEN_HANDLING_EXPORT_COLUMNS: readonly HandlingColumn[] = [
  ...SHENZHEN_HANDLING_COLUMNS,
  { key: 'handledAt', label: '办理时间' },
  { key: 'rawResult', label: '原始办理结果' },
  { key: 'stageType', label: '环节类型代码' },
  { key: 'sourceRecordId', label: '记录编号' },
];

export function handlingColumns(systemId: string, forExport = false): readonly HandlingColumn[] {
  return systemId === shenzhenCatalog.id
    ? forExport ? SHENZHEN_HANDLING_EXPORT_COLUMNS : SHENZHEN_HANDLING_COLUMNS
    : HRSS_HANDLING_COLUMNS;
}

const scalar = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** Only the declared business fields leave storage; arbitrary response properties are never rendered/exported. */
export function readHrssHandlingRecords(value: unknown): HrssHandlingRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map(item => Object.fromEntries(HRSS_HANDLING_COLUMNS.map(({ key }) => [key, scalar(item[key])])) as unknown as HrssHandlingRecord);
}

export function readHandlingRecords(value: unknown, systemId: string): HandlingRecord[] {
  if (systemId !== shenzhenCatalog.id) return readHrssHandlingRecords(value);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map(item => Object.fromEntries(SHENZHEN_HANDLING_EXPORT_COLUMNS.map(({ key }) =>
      [key, key === 'withdrawn' ? item[key] === true : scalar(item[key])])) as unknown as HandlingRecord);
}

export function hrssHandlingStatusLabel(value: unknown): string {
  if (value === 'collected') return '已采集';
  if (value === 'skipped-pending') return '待受理，暂无办理记录';
  if (value === 'failed') return '办理过程待补齐';
  return '尚未采集办理记录';
}

/** A failed read is not evidence that a case has no history. */
export function handlingCountLabel(value: unknown, data: Record<string, unknown>): string | number {
  if (data.handlingRecordStatus === 'failed') {
    const previousCount = Array.isArray(data.handlingRecords) ? data.handlingRecords.length : 0;
    return previousCount ? `${previousCount}（上次）` : '待补齐';
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : scalar(value);
}
