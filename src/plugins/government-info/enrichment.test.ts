import { describe, expect, it, vi } from 'vitest';
import { enrichGovernmentRecord, toDoublePublicityRecord, type GovernmentDetailTransport } from './enrichment';
import { GOVERNMENT_MATTERS } from './matter-catalog';
import { NEW_DRAINAGE_PERMIT_CONTENT, NEW_DRAINAGE_PERMIT_MATTER } from './field-rules';

function transport(overrides: Partial<GovernmentDetailTransport> = {}): GovernmentDetailTransport {
  return {
    searchEntry: vi.fn(async () => ({ result: [{ wf_entry_id: 'wf' }] })),
    getRunningData: vi.fn(async () => ({ recordBean: { primaryBean: { zjbh: '许可号', zzsj: '2026-09-01', zjyxqstart: '2026-09-01', zjyxqend: '2027-09-01' } }, exRecords: [{ recordid: 'record' }] })),
    searchByPrimaryKey: vi.fn(async () => ({ result: [[0, 1, 2, 3, 4, '测试企业']] })),
    getDocument: vi.fn(async () => ({ paragraphs: [], tables: [] })),
    ...overrides,
  };
}

describe('government information enrichment flow', () => {
  it('sorts opinions before splitting the green and tree records', async () => {
    const group = (time: number, opinioncontent: string) => ({ opinions: [{ opiniontime: { time }, opinioncontent }] });
    const api = transport({ getRunningData: async () => ({
      recordBean: { primaryBean: { zjbh: '深城许字第123号、124号' } },
      opinions: [group(30, '最后意见'), group(10, '受理意见'), group(20, '临时占用城市绿地10㎡，砍伐城市树木2株。')],
    }) });
    const rows = await enrichGovernmentRecord(api, { cityLsh: 'CITY-1', sxType: '13', sxmc: '砍伐、迁移城市树木', applyer: '单位' });
    expect(rows).toEqual([
      expect.objectContaining({ cityLsh: 'CITY-1_001', xkbh: '深城许字第123号', xknr: '临时占用城市绿地10平方米' }),
      expect.objectContaining({ cityLsh: 'CITY-1', xkbh: '深城许字第124号', xknr: '砍伐城市树木2株' }),
    ]);
  });

  it('keeps other matters as raw approvals without requesting permit details', async () => {
    const api = transport();
    const input = { cityLsh: 'CITY-1', sxType: '8', sxmc: '初中、小学、幼儿园教师资格认定' };
    const [row] = await enrichGovernmentRecord(api, input);
    expect(api.searchEntry).not.toHaveBeenCalled();
    expect(toDoublePublicityRecord(row)).toEqual({ ...input, fillStatus: '0' });
  });
  it('runs entry, running-data and SearchByPK for drainage permits', async () => {
    const api = transport();
    const [result] = await enrichGovernmentRecord(api, {
      cityLsh: 'CITY-1', sxType: '1', sxmc: '污水排入排水管网许可证核发（新办）', applyer: '原申请人',
    });
    expect(api.searchEntry).toHaveBeenCalledWith('CITY-1', undefined);
    expect(api.getRunningData).toHaveBeenCalledWith('wf', undefined);
    expect(api.searchByPrimaryKey).toHaveBeenCalledWith('record', undefined);
    expect(result).toMatchObject({ qymc: '测试企业', xkbh: '许可号', fillStatus: '0' });
    expect(toDoublePublicityRecord(result)).toMatchObject({ xknr: `测试企业：${NEW_DRAINAGE_PERMIT_CONTENT}`, xkNr: `测试企业：${NEW_DRAINAGE_PERMIT_CONTENT}` });
  });

  it('normalizes new-permit fallback data while leaving renewal content unchanged', () => {
    expect(toDoublePublicityRecord({ sxType: '1', sxmc: NEW_DRAINAGE_PERMIT_MATTER, applyer: '列表企业', enrichmentStatus: 'failed',
      xknr: '旧企业前缀及旧法规内容', xkNr: '旧导出内容' })).toMatchObject({
      enrichmentStatus: 'failed', xknr: `列表企业：${NEW_DRAINAGE_PERMIT_CONTENT}`, xkNr: `列表企业：${NEW_DRAINAGE_PERMIT_CONTENT}`,
    });
    expect(toDoublePublicityRecord({ sxType: '1', sxmc: '污水排入排水管网许可证核发（变更或延续）', xknr: '原变更内容' }).xkNr).toBe('原变更内容');
  });

  it('maps water records to the original double-publicity authority fields', () => {
    expect(toDoublePublicityRecord({ sxType: '1', sxmc: '城市建筑垃圾处置（排放）核准', qymc: '企业', xkbh: '文号' })).toMatchObject({
      xkXdrMc: '企业', xkWsh: '文号', xkXklb: '普通',
      xkXkjg: '深圳市南山区水务局', xkXkjgdm: '11440305MB2D27962K',
      xkXkws: '深圳市建筑废弃物排放核准证',
    });
  });
});

describe('verified other-matter detail enrichment', () => {
  const matters = GOVERNMENT_MATTERS.filter((matter) => matter.supportsCertificateEnrichment);
  const input = { cityLsh: 'CITY-1', sblsh: 'APPLY-1', sxType: matters[0].sxType, sxmc: matters[0].name, applyer: '导出完整申请人' };
  const identity = { sblsh_short: input.cityLsh, sblsh: input.sblsh, sxmc: input.sxmc, wf_entry_id: 'wf-exact' };
  const primary = { ...identity, zjmc: '证明', zjbh: '00123', zzsj: '2026-09-01', zjyxqstart: '2026-09-02', zjyxqend: '长期' };

  it.each(matters)('enriches $id without using water forms or the double-publicity permit template', async (matter) => {
    const row = { ...input, sxType: matter.sxType, sxmc: matter.name };
    const api = transport({
      searchEntry: vi.fn(async () => ({ result: [{ ...identity, sblsh_short: 'OTHER' }, { ...identity, sxmc: row.sxmc }] })),
      getRunningData: vi.fn(async () => ({ recordBean: { primaryBean: { ...primary, sxmc: row.sxmc } }, exRecords: [] })),
    });
    const controller = new AbortController();
    const [result] = await enrichGovernmentRecord(api, row, controller.signal);
    expect(api.searchEntry).toHaveBeenCalledWith('CITY-1', controller.signal);
    expect(api.getRunningData).toHaveBeenCalledWith('wf-exact', controller.signal);
    expect(api.searchByPrimaryKey).not.toHaveBeenCalled();
    expect(api.getDocument).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ...row, certificateName: '证明', certificateNumber: '00123', fillStatus: '0',
      certificateEnrichment: { status: 'partial' } });
    const mapped = toDoublePublicityRecord(result);
    expect(mapped).toEqual(result);
    expect(mapped).not.toHaveProperty('xkCljg');
    expect(mapped).not.toHaveProperty('xkZt');
    expect(mapped).not.toHaveProperty('xkjdrq');
  });

  it.each([
    [], [{ ...identity, sblsh_short: 'PREFIX-CITY-1' }], [{ ...identity, sblsh: 'OTHER' }],
    [{ ...identity, sxmc: '其他事项' }], [identity, { ...identity, wf_entry_id: 'wf-second' }],
    [{ wf_entry_id: 'wf' }],
  ].map((result) => ({ result })))('rejects absent, fuzzy, mismatched or ambiguous search results ($result)', async ({ result }) => {
    const api = transport({ searchEntry: vi.fn(async () => ({ result })) });
    await expect(enrichGovernmentRecord(api, input)).rejects.toThrow('未唯一匹配');
    expect(api.getRunningData).not.toHaveBeenCalled();
  });

  it.each(['sblsh_short', 'sblsh', 'sxmc', 'wf_entry_id'])('rejects conflicting primary identity (%s)', async (key) => {
    const api = transport({ searchEntry: async () => ({ result: [identity] }),
      getRunningData: async () => ({ recordBean: { primaryBean: { ...primary, [key]: 'wrong' } } }),
    });
    await expect(enrichGovernmentRecord(api, input)).rejects.toThrow('身份不一致');
  });

  it('treats a verified primary with absent certificate fields as empty, not a complete record', async () => {
    const api = transport({ searchEntry: async () => ({ result: [identity] }),
      getRunningData: async () => ({ recordBean: { primaryBean: identity } }) });
    expect(await enrichGovernmentRecord(api, input)).toEqual([expect.objectContaining({
      fillStatus: '0', certificateEnrichment: expect.objectContaining({ status: 'empty' }),
    })]);
  });

  it.each(GOVERNMENT_MATTERS.filter((matter) => !matter.supportsDoublePublicityEnrichment && !matter.supportsCertificateEnrichment))(
    'does not request unverified details for $id', async (matter) => {
      const api = transport();
      const [result] = await enrichGovernmentRecord(api, { ...input, sxType: matter.sxType, sxmc: matter.name });
      expect(api.searchEntry).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('certificateEnrichment');
    },
  );
});
