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

const scalar = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** Only the declared business fields leave storage; arbitrary response properties are never rendered/exported. */
export function readHrssHandlingRecords(value: unknown): HrssHandlingRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map(item => Object.fromEntries(HRSS_HANDLING_COLUMNS.map(({ key }) => [key, scalar(item[key])])) as unknown as HrssHandlingRecord);
}

export function hrssHandlingStatusLabel(value: unknown): string {
  if (value === 'collected') return '已采集';
  if (value === 'skipped-pending') return '待受理，未查询办理记录';
  return '尚未采集办理记录';
}
