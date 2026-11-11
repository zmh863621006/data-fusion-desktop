export type GovernmentExportTarget = 'nanshan' | 'guangdong-law';

export function parseGovernmentExportTarget(value: unknown): GovernmentExportTarget | undefined {
  if (value === undefined) return undefined;
  if (value !== 'nanshan' && value !== 'guangdong-law') throw new Error('双公示导出模板无效');
  return value;
}

export function assertGovernmentExportTarget(target: GovernmentExportTarget | undefined, format: string, systems: string[]): void {
  parseGovernmentExportTarget(target);
  if (target && (format !== 'xlsx' || !systems.length || systems.some(system => system !== 'government-info'))) {
    throw new Error('省执法和南山模板仅支持政务综合信息系统的 Excel 导出');
  }
}

export const GOVERNMENT_EXPORT_LABELS: Record<GovernmentExportTarget, string> = {
  nanshan: '南山双公示', 'guangdong-law': '省执法双公示',
};
