import { describe, expect, it } from 'vitest';
import { GOVERNMENT_MATTERS } from './matter-catalog';

describe('government information matter catalog', () => {
  it('enables only five partial certificate matters without broadening double-publicity support', () => {
    expect(GOVERNMENT_MATTERS.filter((matter) => matter.supportsCertificateEnrichment).map((matter) => matter.id)).toEqual([
      'commercial-performance-change', 'hazardous-chemicals-license-new', 'hazardous-chemicals-license-renewal',
      'precursor-chemicals-filing-new', 'precursor-chemicals-filing-cancellation',
    ]);
    expect(GOVERNMENT_MATTERS.filter((matter) => matter.supportsDoublePublicityEnrichment)).toHaveLength(10);
    expect(GOVERNMENT_MATTERS.some((matter) => matter.supportsCertificateEnrichment && matter.supportsDoublePublicityEnrichment)).toBe(false);
  });
  it('groups all 18 source matters into three departments', () => {
    expect(GOVERNMENT_MATTERS).toHaveLength(18);
    expect(Object.fromEntries(['水务局', '城管局', '其他'].map((name) => [
      name,
      GOVERNMENT_MATTERS.filter((matter) => matter.departmentName === name).length,
    ]))).toEqual({ '水务局': 8, '城管局': 2, '其他': 8 });
  });

  it('keeps construction waste under water affairs like the source project', () => {
    expect(GOVERNMENT_MATTERS.find((matter) => matter.name === '城市建筑垃圾处置（排放）核准'))
      .toMatchObject({ departmentName: '水务局', sxType: '1' });
  });
});
