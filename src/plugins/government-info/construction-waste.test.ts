import { describe, expect, it } from 'vitest';
import { constructionWastePrincipalFields, constructionWasteContractors, isDelegatedConstructionWaste } from './construction-waste';
import { enrichConstructionWaste } from './field-rules';
import { toDoublePublicityRecord } from './enrichment';
import { applyEnterpriseResult, enterpriseInput, mergeEnterpriseRecord } from '../../core/enterprise/service';

const applicant = '深圳市南山区水务局';
const record = { cityLsh: 'TEST-CITY', sxType: '1', sxmc: '城市建筑垃圾处置（排放）核准',
  applyer: applicant, cardNumber: '11440305MB2D27962K' };
const document = { paragraphs: [], tables: [[['许可正文发证机关：水务局', '', '工程名称', '测试工程'],
  ['', '', '施工单位', '测试施工有限公司']]] };

describe('construction-waste proxy applicant', () => {
  it('uses the contractor label, retains the proxy source, and clears all proxy identity fields', () => {
    const result = toDoublePublicityRecord(enrichConstructionWaste({ ...record, frdb: '原机关法人',
      xkFrdb: '原机关法人', xydm: record.cardNumber, xkXdrShxym: record.cardNumber }, { zjbh: '编号：TEST-PERMIT' }, document));
    expect(result).toMatchObject({ applyer: applicant, cardNumber: record.cardNumber, qymc: '测试施工有限公司',
      xkXdrMc: '测试施工有限公司', xydm: '', frdb: '', xkFrdb: '', xkXdrShxym: '', xknr: '许可正文',
      ajmc: '测试施工有限公司城市建筑废弃物排放核准证', constructionWastePrincipal: { status: 'resolved', contractorName: '测试施工有限公司' } });
    const input = enterpriseInput('government-info', result)!;
    expect(input).toEqual({ name: '测试施工有限公司', creditCode: '', applicantCode: '' });
    const enriched = applyEnterpriseResult('government-info', result, input, { requestId: 'fixture', status: 'success', reason: '',
      enterprise: { id: 'fixture', name: input.name, creditCode: '91440300123456789Q', legalPerson: '施工单位法人', source: 'cache', updatedAt: 1 } });
    expect(enriched).toMatchObject({ xkXdrMc: input.name, xkXdrShxym: '91440300123456789Q', xkFrdb: '施工单位法人',
      applyer: applicant, cardNumber: record.cardNumber });
    const old = applyEnterpriseResult('government-info', { applyer: applicant, cardNumber: record.cardNumber },
      { name: applicant, creditCode: '', applicantCode: record.cardNumber }, { requestId: 'old', status: 'success', reason: '',
        enterprise: { id: 'old', name: applicant, creditCode: record.cardNumber, legalPerson: '机关法人', source: 'cache', updatedAt: 1 } });
    expect(mergeEnterpriseRecord('government-info', result, old)).toEqual(result);
  });

  it('accepts whitespace/colon labels at different row positions and deduplicates repeated names', () => {
    expect(constructionWasteContractors([[['注意事项：施工单位应妥善保管证书'], ['施 工\n单 位：', '', '测试施工有限公司']],
      [['施工单位', '测试施工有限公司']]])).toEqual(['测试施工有限公司']);
  });

  it.each([
    [], [[['施工单位', '']]], [[['施工单位', '***有限公司']]], [[['施工单位', applicant]]],
    [[['施工单位', '甲施工公司'], ['施工单位', '乙施工公司']]],
  ].map(tables => ({ tables })))('leaves missing, masked and ambiguous contractors unresolved without querying the proxy ($tables)', ({ tables }) => {
    const next = { ...record, ...constructionWastePrincipalFields(record, tables) };
    expect(next).toMatchObject({ qymc: '', xydm: '', frdb: '', fillStatus: '0', enrichmentStatus: 'failed' });
    expect(enterpriseInput('government-info', next)).toBeNull();
  });

  it('marks an attachment failure without falling back to the applicant', () => {
    expect(constructionWastePrincipalFields(record, [], true)).toMatchObject({ qymc: '', constructionWastePrincipal: { status: 'failed' } });
    expect(enterpriseInput('government-info', { ...record, qymc: applicant, xydm: record.cardNumber })).toBeNull();
  });

  it('retains the existing rules for company applicants and other matters', () => {
    const result = enrichConstructionWaste({ ...record, applyer: '原施工公司' }, {}, document);
    expect(result).toMatchObject({ qymc: '原施工公司', xydm: record.cardNumber });
    expect(result).not.toHaveProperty('constructionWastePrincipal');
    expect(isDelegatedConstructionWaste({ ...record, sxmc: '其他事项' })).toBe(false);
  });
});
