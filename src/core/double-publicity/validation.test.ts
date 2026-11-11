import { describe, expect, it } from 'vitest';
import { exportFieldValue, validateExport } from './validation';
import type { StoredRecord } from '../storage/types';

const common = { xkXdrMc:'测试企业', xkXdrLb:'法人及非法人组织', xkXkws:'许可决定书', xkWsh:'许可字001', xkXklb:'普通',
  xkNr:'许可内容', xkJdrq:'2026-09-23', xkYxqz:'2026-09-23', xkYxqzi:'2027-09-23', xkXkjg:'许可机关',
  xkXkjgdm:'机关代码', xkZt:'1', xkLydw:'来源单位', xkLydwdm:'来源代码' };
function record(data: Record<string,unknown>, systemId='oversize-transport'): StoredRecord {
  return {systemId,matterId:'test',recordKey:'record',data,firstSeenAt:1,updatedAt:1};
}
describe('unified double publicity export validation',()=>{
  it('does not export a proxy bureau as the contractor, including old rows without extraction evidence', () => {
    const data = { ...common, sxmc: '城市建筑垃圾处置（排放）核准', applyer: '深圳市南山区水务局',
      qymc: '深圳市南山区水务局', xkXdrMc: '深圳市南山区水务局', xkFrdb: '机关法人', xkXdrShxym: '机关代码' };
    const stored = record(data, 'government-info');
    expect(exportFieldValue(stored, 'xkXdrMc')).toBe('');
    expect(exportFieldValue(stored, 'xkXdrShxym')).toBe('');
    expect(exportFieldValue(stored, 'xkFrdb')).toBe('');
    const report = validateExport([stored]);
    expect(report.missingRows).toBe(1);
    expect(report.issues[0].fields.find(field => field.key === 'xkXdrMc')?.message).toContain('施工单位');
    const resolved = record({ ...data, xkXdrMc: '施工公司', xkFrdb: '施工公司法人', xkXdrShxym: '施工公司代码',
      constructionWastePrincipal: { status: 'resolved', contractorName: '施工公司' } }, 'government-info');
    expect(exportFieldValue(resolved, 'xkXdrMc')).toBe('施工公司');
    expect(validateExport([resolved]).invalid).toBe(0);
  });
  it.each(['oversize-transport','online-car-permit','transport-practitioner','government-info'])('checks all 14 base requirements for %s',system=>{
    const value=validateExport([record({},system)]);
    expect(value.issues[0].fields).toHaveLength(14); expect(value.missingRows).toBe(1);
  });
  it.each(['法人及非法人组织','个体工商户'])('requires code and representative for %s without special placeholder validation',category=>{
    expect(validateExport([record({...common,xkXdrLb:category})]).issues[0].fields.map(f=>f.key)).toEqual(['xkXdrShxym','xkFrdb']);
    expect(validateExport([record({...common,xkXdrLb:category,xkXdrShxym:'00000000000000000X',xkFrdb:'经营者'})]).invalid).toBe(0);
  });
  it('requires natural-person credentials and requires enterprise fields to be blank',()=>{
    const row={...common,xkXdrLb:'自然人'};
    expect(validateExport([record(row)]).issues[0].fields.map(f=>f.key)).toEqual(['xkXdrZjlx','xkXdrZjhm']);
    expect(validateExport([record({...row,xkXdrZjlx:'身份证',xkXdrZjhm:'证件号码'})]).invalid).toBe(0);
    const report=validateExport([record({...row,xkXdrZjlx:'身份证',xkXdrZjhm:'证件号码',xkFrdb:'不应填写'})]);
    expect(report.missingRows).toBe(0);expect(report.invalid).toBe(1);expect(report.issues[0].fields[0].message).toContain('留空');
  });
  it('representative identity number depends on the optional type',()=>{
    const row={...common,xkXdrShxym:'信用代码',xkFrdb:'法人'};
    expect(validateExport([record({...row,xkFrZjlx:'身份证',xkFrZjhm:'  '})]).issues[0].fields[0].key).toBe('xkFrZjhm');
    expect(validateExport([record({...row,xkFrZjhm:'123'})]).issues[0].fields[0].message).toContain('留空');
    expect(validateExport([record({...row,xkFrZjlx:'身份证',xkFrZjhm:'123'})]).invalid).toBe(0);
  });
  it('maps government equivalents but does not infer document number/title, category or certificate dates',()=>{
    const row={applyer:'企业',qylx:'法人及非法人组织',xydm:'代码',frdb:'法人',xknr:'内容',xkjdrq:'日期',yxqs:'日期',yxqe:'日期',xkbh:'证照号',ajmc:'案件',certificateIssueDate:'日期'};
    const keys=validateExport([record(row,'government-info')]).issues[0].fields.map(f=>f.key);
    expect(keys).not.toContain('xkXdrMc'); expect(keys).not.toContain('xkFrdb');
    expect(keys).toContain('xkWsh'); expect(keys).toContain('xkXkws'); expect(keys).toContain('xkXklb');
    const copy=structuredClone(row);validateExport([record(row,'government-info')]);expect(row).toEqual(copy);
  });
  it('skips other systems and retains export row numbering',()=>{
    const report=validateExport([record({},'market-access'),record({})]);
    expect(report.checked).toBe(1);expect(report.issues[0].rowNumber).toBe(2);
  });
  it('marks source/backend identity conflicts even when mandatory cells are all nonempty', () => {
    const complete = { ...common, xkXdrShxym: '91440300123456789Q', xkFrdb: '法人',
      oversizeApplicationEnrichment: { status: 'conflict', reason: '办件信用代码冲突', reqNo: 'B4413002026101260031', path: '/selectRequest', checkedAt: 1 } };
    const report = validateExport([record(complete)]);
    expect(report.invalid).toBe(1); expect(report.missingRows).toBe(0); expect(report.issues[0].fields[0].message).toContain('冲突');
    expect(validateExport([record({ ...common, xkXdrShxym: '91440300123456789Q', xkFrdb: '法人', enterpriseEnrichment: { status: 'review', reason: '企业库冲突' } })]).invalid).toBe(1);
  });
});
