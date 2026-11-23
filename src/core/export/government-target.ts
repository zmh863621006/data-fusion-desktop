import { EQUIPMENT_SYSTEM_ID } from '../../plugins/guangdong-special-equipment/catalog';
import { FOOD_DRUG_SYSTEM_ID } from '../../plugins/guangdong-food-drug/catalog';

export type GovernmentExportTarget = 'nanshan' | 'guangdong-law' | 'collection-disclosure' | 'collection-judicial';

/** Systems whose returned permit records support both publication templates. */
export function supportsGovernmentExport(systemId: string): boolean {
  return systemId === 'government-info' || systemId === 'shenzhen-hazardous-chemicals';
}

export function supportsCollectionExport(systemId: string): boolean {
  return systemId === EQUIPMENT_SYSTEM_ID || systemId === FOOD_DRUG_SYSTEM_ID;
}

export function permitExportTargets(systemId: string): readonly GovernmentExportTarget[] {
  if (supportsCollectionExport(systemId)) return ['collection-disclosure', 'collection-judicial'];
  if (supportsGovernmentExport(systemId)) return ['guangdong-law', 'nanshan'];
  return [];
}

export function parseGovernmentExportTarget(value: unknown): GovernmentExportTarget | undefined {
  if (value === undefined) return undefined;
  if (value !== 'nanshan' && value !== 'guangdong-law' && value !== 'collection-disclosure' && value !== 'collection-judicial') {
    throw new Error('公示导出模板无效');
  }
  return value;
}

export function assertGovernmentExportTarget(target: GovernmentExportTarget | undefined, format: string, systems: string[]): void {
  parseGovernmentExportTarget(target);
  if (target && (format !== 'xlsx' || !systems.length || new Set(systems).size !== 1 || !permitExportTargets(systems[0]).includes(target))) {
    const collection = target === 'collection-disclosure' || target === 'collection-judicial';
    throw new Error(collection ? '归集公示模板仅支持特种设备监管或食药监的单系统 Excel 导出'
      : '省执法和南山模板仅支持政务综合信息、危化品管理的单系统 Excel 导出');
  }
}

export const GOVERNMENT_EXPORT_LABELS: Record<GovernmentExportTarget, string> = {
  nanshan: '南山双公示', 'guangdong-law': '省执法双公示',
  'collection-disclosure': '双公示', 'collection-judicial': '司法公示',
};
