import type { StoredRecord } from '../storage/types';
import { DOUBLE_PUBLICITY_TEMPLATE } from './template';
import { readOversizeApplicationEvidence } from '../../plugins/oversize-transport/application';
import { isDelegatedConstructionWaste, resolvedConstructionWasteContractor } from '../../plugins/government-info/construction-waste';
import { EQUIPMENT_SYSTEM_ID } from '../../plugins/guangdong-special-equipment/catalog';
import { FOOD_DRUG_SYSTEM_ID } from '../../plugins/guangdong-food-drug/catalog';

const systems = new Set(['government-info', 'oversize-transport', 'online-car-permit', 'transport-practitioner',
  'health-publicity', 'shenzhen-hazardous-chemicals', EQUIPMENT_SYSTEM_ID, FOOD_DRUG_SYSTEM_ID]);
const common = ['xkXdrMc','xkXdrLb','xkXkws','xkWsh','xkXklb','xkNr','xkJdrq','xkYxqz','xkYxqzi','xkXkjg','xkXkjgdm','xkZt','xkLydw','xkLydwdm'];
const labels = new Map<string,string>(DOUBLE_PUBLICITY_TEMPLATE);
// Only semantic equivalents. Never substitute certificate dates, license number or case title.
const governmentAliases: Record<string,string[]> = {
  xkXdrMc: ['qymc','applyer'], xkXdrLb: ['qylx'], xkXdrShxym: ['xydm'], xkFrdb: ['frdb'],
  xkNr: ['xknr'], xkJdrq: ['xkjdrq'], xkYxqz: ['yxqs'], xkYxqzi: ['yxqe'],
};
const present = (value: unknown) => (typeof value === 'string' && value.trim().length > 0) || (typeof value === 'number' && Number.isFinite(value));
type PublicityRow = Pick<StoredRecord, 'systemId' | 'matterId' | 'recordKey' | 'data'>;
export function exportFieldValue(record: PublicityRow, key: string): unknown {
  if (record.systemId === 'government-info' && isDelegatedConstructionWaste(record.data)
    && !resolvedConstructionWasteContractor(record.data) && ['xkXdrMc', 'xkXdrShxym', 'xkFrdb'].includes(key)) return '';
  const keys = [key, ...(record.systemId === 'government-info' ? governmentAliases[key] ?? [] : [])];
  return keys.map(name => record.data[name]).find(present);
}
export interface ExportFieldIssue { key: string; label: string; message: string; sourceKeys: string[] }
export interface ExportRowIssue { rowNumber: number; recordKey: string; subject: string; fields: ExportFieldIssue[] }
export interface ExportValidation { total: number; checked: number; invalid: number; missingRows: number; issues: ExportRowIssue[] }
export type ConfirmExport = (validation: ExportValidation, format: 'xlsx' | 'csv' | 'json') => Promise<boolean>;

export function validateExport(records: readonly PublicityRow[]): ExportValidation {
  const issues: ExportRowIssue[] = []; let checked = 0, missingRows = 0;
  records.forEach((record,index) => {
    if (!systems.has(record.systemId)) return;
    checked++;
    const keys = (key: string) => [key, ...(record.systemId === 'government-info' ? governmentAliases[key] ?? [] : [])];
    const value = (key: string) => exportFieldValue(record, key);
    const fields: ExportFieldIssue[] = []; let missing = false;
    const add = (key: string, message: string) => fields.push({key,label:labels.get(key) ?? key,message,sourceKeys:keys(key)});
    const require = (key: string) => { if (!present(value(key))) {
      const delegated = record.systemId === 'government-info' && isDelegatedConstructionWaste(record.data)
        && !resolvedConstructionWasteContractor(record.data);
      add(key, key === 'xkXdrMc' && delegated ? '水务局为代申请人，未从成果附件唯一取得施工单位，请人工核对' : '缺少必填字段');
      missing = true;
    } };
    const blank = (key: string) => { if (present(value(key))) add(key,'当前主体类别下应留空'); };
    if (record.systemId === 'oversize-transport') {
      const source = readOversizeApplicationEvidence(record.data.oversizeApplicationEnrichment);
      if (source?.status === 'conflict') add('xkXdrShxym', source.reason);
      const enterprise = record.data.enterpriseEnrichment as { status?: string; reason?: string } | undefined;
      if (enterprise?.status === 'review') add('xkFrdb', typeof enterprise.reason === 'string' ? enterprise.reason : '企业补充信息待人工核对');
    }
    common.forEach(require);
    const category = String(value('xkXdrLb') ?? '').trim();
    if (category === '法人及非法人组织' || category === '个体工商户') {
      require('xkXdrShxym'); require('xkFrdb');
      if (present(value('xkFrZjlx'))) require('xkFrZjhm'); else blank('xkFrZjhm');
      blank('xkXdrZjlx'); blank('xkXdrZjhm');
    } else if (category === '自然人') {
      require('xkXdrZjlx'); require('xkXdrZjhm');
      ['xkXdrShxym','xkXdrGszc','xkXdrZzjg','xkXdrSwdj','xkXdrSydw','xkXdrShzz','xkFrdb','xkFrZjlx','xkFrZjhm'].forEach(blank);
    } else if (category) add('xkXdrLb','应为法人及非法人组织、个体工商户或自然人');
    if (fields.length) issues.push({rowNumber:index+1,recordKey:record.recordKey,subject:String(value('xkXdrMc') ?? ''),fields});
    if (missing) missingRows++;
  });
  return {total:records.length,checked,invalid:issues.length,missingRows,issues};
}
