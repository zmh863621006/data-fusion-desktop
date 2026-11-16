import { describe, expect, it, vi } from 'vitest';
import { HAZCHEM_MATTERS, HAZCHEM_AUTHORITY_CODE } from './catalog';
import { mapHazardousRecord, queryHazardous } from './query';
import type { HazardousTransport } from './client';
const matter = HAZCHEM_MATTERS[0], context = { page: 1, pageSize: 100, filters: {} };
const done = { sblshShort: 'fixture-serial', sxmc: matter.name, sxbmShort: matter.sourceCode, lczt: '流程结束', zzjgmc: '测试企业' };
const report = { sblshShort: 'fixture-serial', number: 1, serviceItemName: matter.name, administrativeName: '测试企业', unifiedSocialCreditCode: '91440300MAA5DL1LTT', legalRepresentative: '测试法人', caseName: '测试行政许可案件', licenseName: '危险化学品经营许可证', licenseNumber: '许可001', permissionDecisionDate: '2026-11-10', startTime: '2026-11-10', endTime: '2029-11-09', licenseContent: '原始经营范围', result: '予以许可' };
const certificate = { bizNum: 'fixture-serial', companyName: '测试企业', dataFields: JSON.stringify({ data_fields: { ZZMC: '危险化学品经营许可证', ZZHM: '许可001', FZRQ: '2026-11-11', FZJGZZJGDM: '123456789', XKFW: '原始经营范围' }, operator: { identity_num: 'PRIVATE-PERSON' } }), authCode: 'PRIVATE-CODE', locaPdfUrl: 'https://private.test/document' };
function transport(overrides: Partial<HazardousTransport> = {}): HazardousTransport {
  return { done: vi.fn(async () => [done]), report: vi.fn(async () => [report]), certificates: vi.fn(async () => [certificate]), ...overrides };
}
describe('危化品流水号关联回流', () => {
  it('selects completed matching matters, exact serials, and collapses report duplicates differing only by number', async () => {
    const t = transport({ done: vi.fn(async () => [done, { ...done, sblshShort: 'unfinished', lczt: '审查' }, { ...done, sblshShort: 'other', sxmc: '其他事项', sxbmShort: 'other' }]), report: vi.fn(async () => [report, { ...report, number: 2 }, { ...report, sblshShort: 'not-in-done' }]) });
    const result = await queryHazardous(t, matter, context); expect(result.total).toBe(1);
    expect(t.certificates).toHaveBeenCalledExactlyOnceWith('fixture-serial', undefined);
    expect(result.rows[0]).toMatchObject({ sourceSerial: 'fixture-serial', xkJdrq: '2026-11-10', xkXkjgdm: HAZCHEM_AUTHORITY_CODE, xkLydwdm: HAZCHEM_AUTHORITY_CODE, xkFrdb: '测试法人', xkNr: '原始经营范围' });
    expect(JSON.stringify(result.rows)).not.toMatch(/PRIVATE-PERSON|PRIVATE-CODE|private\.test/);
  });
  it('filters by the explicit decision date without substituting issuance dates and validates range first', async () => {
    const t = transport(); expect((await queryHazardous(t, matter, { ...context, filters: { startDate: '2026-11-11', endDate: '2026-11-11' } })).total).toBe(0);
    expect(t.certificates).not.toHaveBeenCalled();
    await expect(queryHazardous(t, matter, { ...context, filters: { startDate: '2026-02-30', endDate: '2026-03-01' } })).rejects.toMatchObject({ code: 'QUERY_INVALID' });
  });
  it('keeps unassociated completed records as incomplete for all-record reflow and refuses an unverifiable date filter', async () => {
    const t = transport({ report: async () => [], certificates: async () => [] });
    const result = await queryHazardous(t, matter, context); expect(result.rows[0]).toMatchObject({ xkXdrMc: '测试企业', xkJdrq: '', xkFrdb: '', xkXkjgdm: HAZCHEM_AUTHORITY_CODE });
    expect(String(result.rows[0].bz)).toContain('尚未关联');
    await expect(queryHazardous(t, matter, { ...context, filters: { startDate: '2026-11-01', endDate: '2026-11-30' } })).rejects.toThrow('缺少可核对的许可决定日期');
  });
  it('blocks conflicting report duplicates instead of selecting an arbitrary revision', async () => {
    await expect(queryHazardous(transport({ report: async () => [report, { ...report, number: 2, licenseContent: '不同范围' }] }), matter, context)).rejects.toThrow('内容不一致');
  });
  it('preserves missing cancellation fields and original result without inventing revocation or normal-license defaults', () => {
    const cancel = HAZCHEM_MATTERS.find(m => m.id === 'hazchem-business-cancel')!;
    const row = mapHazardousRecord(cancel, done, { ...report, licenseName: '危险化学品经营许可证注销通知书', licenseContent: '' }, [certificate]);
    expect(row).toMatchObject({ xkNr: '', xkCljg: '', xkZt: '', xkXklb: '', xkXkws: '危险化学品经营许可证注销通知书', xkWsh: '许可001' });
    expect(row.hazardousEvidence).toMatchObject({ originalResult: '予以许可' });
  });
  it('does not relabel a 9-digit organization code or an operator identity as credit/legal person', () => {
    const row = mapHazardousRecord(matter, done, { ...report, unifiedSocialCreditCode: '123456789', legalRepresentative: '' }, [certificate]);
    expect(row.xkXdrShxym).toBe(''); expect(row.xkFrdb).toBe(''); expect(row.xkXkjgdm).toBe('11440305MB2D288348');
    expect(row.xkXkws).toBe(''); expect(row.xkWsh).toBe('');
  });
  it('handles the unsampled filing matter without inferring an administrative permission decision', () => {
    const filing = HAZCHEM_MATTERS.find(m => m.id === 'hazchem-precursor-filing')!;
    const row = mapHazardousRecord(filing, done, undefined, []); expect(row).toMatchObject({ xkXklb: '', xkCljg: '', xkZt: '', xkNr: '' });
  });
  it('cancels without returning partial data', async () => {
    const controller = new AbortController(); const t = transport({ certificates: async () => { controller.abort(); return [certificate]; } });
    await expect(queryHazardous(t, matter, { ...context, signal: controller.signal })).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
  });
});
