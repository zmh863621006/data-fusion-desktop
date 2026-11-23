import { EQUIPMENT_SYSTEM_ID } from '../../plugins/guangdong-special-equipment/catalog';
import { FOOD_DRUG_SYSTEM_ID } from '../../plugins/guangdong-food-drug/catalog';

export type GovernmentExportTarget = 'nanshan' | 'guangdong-law';

/** Systems whose returned permit records support both publication templates. */
export function supportsGovernmentExport(systemId: string): boolean {
  return systemId === 'government-info' || systemId === 'shenzhen-hazardous-chemicals'
    || systemId === EQUIPMENT_SYSTEM_ID || systemId === FOOD_DRUG_SYSTEM_ID;
}

export function parseGovernmentExportTarget(value: unknown): GovernmentExportTarget | undefined {
  if (value === undefined) return undefined;
  if (value !== 'nanshan' && value !== 'guangdong-law') throw new Error('双公示导出模板无效');
  return value;
}

export function assertGovernmentExportTarget(target: GovernmentExportTarget | undefined, format: string, systems: string[]): void {
  parseGovernmentExportTarget(target);
  if (target && (format !== 'xlsx' || !systems.length || new Set(systems).size !== 1 || systems.some(system => !supportsGovernmentExport(system)))) {
    throw new Error('省执法和南山模板仅支持政务综合信息、危化品管理、特种设备监管或食药监的单系统 Excel 导出');
  }
}

export const GOVERNMENT_EXPORT_LABELS: Record<GovernmentExportTarget, string> = {
  nanshan: '南山双公示', 'guangdong-law': '省执法双公示',
};
