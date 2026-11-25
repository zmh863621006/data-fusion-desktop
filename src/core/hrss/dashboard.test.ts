import { describe, expect, it } from 'vitest';
import { HRSS_SUBDISTRICT_MATTERS } from '../../plugins/guangdong-hrss/catalog';
import { buildHrssDashboard, HrssDashboardAccessError, type HrssDashboardInput, type HrssDashboardRecord, type HrssDashboardTask } from './dashboard';

const NOW = Date.parse('2026-11-04T04:00:00Z');
const POPULATION = 'employment-difficulty-recognition';
const TRACKING = 'unemployment-tracking-service';
const SUBSIDY = 'job-seeking-startup-subsidy';
const record = (data: Record<string, unknown>, matterId = POPULATION): HrssDashboardRecord => ({ matterId, data });
const success = (matterId = POPULATION, finishedAt = NOW - 1_000): HrssDashboardTask => ({ matterId, type: 'data-return', status: 'completed', createdAt: finishedAt - 1_000, finishedAt });
const build = (overrides: Partial<HrssDashboardInput> = {}) => buildHrssDashboard({ allowedMatterIds: [POPULATION], records: [], tasks: [], now: NOW, ...overrides });
const count = (buckets: { id: string; count: number }[], id: string) => buckets.find((bucket) => bucket.id === id)?.count;
function syntheticCard(birth: string): string {
  // Deliberately fictional region; checksum is computed to test the date extractor.
  const prefix = `990000${birth}001`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  return prefix + '10X98765432'[weights.reduce((sum, weight, i) => sum + Number(prefix[i]) * weight, 0) % 11];
}

describe('authorized local HRSS dashboard', () => {
  it('never turns pending requested dates into an effective dashboard coverage range', () => {
    const data = build({ tasks: [{ ...success(), details: { dateFilterStatus: 'pending', requestedStartDate: '2026-01-01',
      requestedEndDate: '2026-10-31', startDate: '2026-01-01', endDate: '2026-10-31' } }] });
    expect(data.matters[0].coverage).toBeNull();
    expect(JSON.stringify(data)).not.toContain('2026-10-31');
  });
  it('rejects empty/unknown scope and unauthorized records or tasks before aggregation', () => {
    for (const input of [
      { allowedMatterIds: [] }, { allowedMatterIds: ['unknown-matter'] },
      { records: [record({}, TRACKING)] }, { tasks: [success(TRACKING)] },
      { records: [{ ...record({}), systemId: 'another-system' }] },
      { tasks: [{ ...success(), systemId: 'another-system' }] },
    ]) expect(() => build(input)).toThrow(HrssDashboardAccessError);
  });

  it('distinguishes never synced from a successfully synced empty result', () => {
    const absent = build();
    expect(absent.syncState).toBe('not-synced');
    expect(absent.totalRecords).toBeNull();
    expect(absent.ages.total).toBeNull();
    expect(absent.matters[0].total).toBeNull();
    const empty = build({ tasks: [success()] });
    expect(empty.syncState).toBe('synced');
    expect(empty.totalRecords).toBe(0);
    expect(empty.ages.total).toBe(0);
    expect(empty.matters[0].total).toBe(0);
    expect(empty.lastSuccessAt).toBe(NOW - 1_000);
  });

  it('opens the dashboard for a street office grant and counts only matters with a list source', () => {
    const streetMatter = HRSS_SUBDISTRICT_MATTERS[0].id;
    expect(build({ allowedMatterIds: [streetMatter] })).toMatchObject({
      authorizedMatterCount: 1, matters: [expect.objectContaining({id:streetMatter})], syncState: 'not-synced', totalRecords: null,
    });
    expect(build({ allowedMatterIds: [POPULATION, streetMatter], tasks: [success()] })).toMatchObject({
      authorizedMatterCount: 2, syncState: 'partial', totalRecords: 0,
    });
    expect(build({ allowedMatterIds: [streetMatter], records: [record({}, streetMatter)] })).toMatchObject({
      authorizedMatterCount: 1, syncState: 'local-only', totalRecords: 1,
    });
  });

  it('does not treat failed, cancelled, unrelated, incomplete or future tasks as successful evidence', () => {
    const tasks: HrssDashboardTask[] = [
      { ...success(), status: 'failed' }, { ...success(), status: 'cancelled' },
      { ...success(), type: 'export' }, { ...success(), finishedAt: undefined }, success(POPULATION, NOW + 1),
    ];
    expect(build({ tasks }).totalRecords).toBeNull();
    expect(build({ records: [record({})], tasks }).syncState).toBe('local-only');
  });

  it('does not reflect unexpected persisted task status text into the aggregate', () => {
    const data = build({ tasks: [{ ...success(), status: 'unexpected-private-text' as HrssDashboardTask['status'] }] });
    expect(data.matters[0].latestTaskStatus).toBeNull();
    expect(JSON.stringify(data)).not.toContain('unexpected-private-text');
    expect(() => build({ now: Number.MAX_VALUE })).toThrow('统计时间无效');
  });

  it('keeps successful snapshot evidence while displaying a later failure and its safe query dates', () => {
    const data = build({ tasks: [
      { ...success(), details: { startDate: '2026-10-01', endDate: '2026-11-03', account: 'must-not-return' } },
      { ...success(), status: 'failed', createdAt: NOW, finishedAt: NOW },
    ] });
    expect(data.matters[0]).toMatchObject({ total: 0, latestTaskStatus: 'failed', coverage: { startDate: '2026-10-01', endDate: '2026-11-03' } });
    expect(JSON.stringify(data)).not.toContain('must-not-return');
    expect(build({ tasks: [{ ...success(), details: { startDate: '2026-02-30', endDate: 'private query text' } }] }).matters[0].coverage).toBeNull();
  });

  it('does not use a timeout-skipped completion as complete coverage and exposes its skipped count',()=>{
    const partial = { ...success(), progress: { skippedRequests: 2 }, details: { startDate: '2026-11-04', endDate: '2026-11-04' } };
    expect(build({ tasks: [partial] })).toMatchObject({ totalRecords: null, lastSuccessAt: null,
      matters: [expect.objectContaining({ latestSkippedRequests: 2, coverage: null })] });
    const data = build({ tasks: [ { ...success(POPULATION, NOW - 10_000), details: { startDate: '2026-10-01', endDate: '2026-11-03' } }, partial ] });
    expect(data.matters[0]).toMatchObject({ latestSkippedRequests: 2, lastSuccessAt: NOW - 10_000,
      coverage: { startDate: '2026-10-01', endDate: '2026-11-03' } });
  });

  it('counts latest keyed local records once, preserves unkeyed rows and never mutates inputs', () => {
    const records = [
      { ...record({ age: 29 }), recordKey: 'same', updatedAt: 1 },
      { ...record({ age: 30 }), recordKey: 'same', updatedAt: 2 }, record({ age: 40 }),
    ];
    const before = structuredClone(records);
    const data = build({ records });
    expect(data.totalRecords).toBe(2);
    expect(count(data.ages.buckets, 'under-30')).toBe(0);
    expect(count(data.ages.buckets, '30-39')).toBe(1);
    expect(records).toEqual(before);
  });

  it('uses mutually exclusive age bands and includes older, invalid and unknown ages', () => {
    const ages = [0, 29, 30, 39, 40, 49, 50, 59, 60, 120, 121, -1, 29.5, 'invalid', null];
    const data = build({ records: ages.map((age) => record({ age })) });
    expect(data.ages.buckets.map((bucket) => bucket.count)).toEqual([2, 2, 2, 2, 2, 5]);
    expect(data.ages.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(ages.length);
  });

  it('derives age from list birth dates or checksum-valid identity only, using Shanghai birthday boundaries', () => {
    const privateCard = syntheticCard('19961105');
    const data = build({ records: [
      record({ birthDate: '1996-11-04' }), record({ birthDate: '1996-11-05' }),
      record({ cardNumber: privateCard }), record({ cardNumber: '990000199611050010' }),
      record({ cardNumber: '990000********001X' }), record({ birthDate: '2027-01-01' }),
      record({ birthDate: '1996-02-30' }), record({ age: 60, birthDate: '2000-01-01' }),
    ] });
    expect(count(data.ages.buckets, 'under-30')).toBe(2);
    expect(count(data.ages.buckets, '30-39')).toBe(1);
    expect(count(data.ages.buckets, '60-plus')).toBe(1);
    expect(count(data.ages.buckets, 'unknown')).toBe(4);
    expect(JSON.stringify(data)).not.toContain(privateCard);
    const midnight = build({ now: Date.parse('2026-11-03T16:00:00Z'), records: [record({ birthDate: '1996-11-04' })] });
    expect(count(midnight.ages.buckets, '30-39')).toBe(1);
  });

  it('does not count subsidy applicant identities as population age records', () => {
    const data = build({ allowedMatterIds: [SUBSIDY], records: [record({ age: 30 }, SUBSIDY)], tasks: [success(SUBSIDY)] });
    expect(data.totalRecords).toBe(1);
    expect(data.ages.total).toBeNull();
  });

  it('counts yes/no/unknown tracking and keeps missing or unrecognized streets in an unknown bucket', () => {
    const rows = [
      { belongArea: '广东省/深圳市/南山区/粤海街道办事处', entryServiceSituation: '是' },
      { belongArea: '粤海街道', entryServiceSituation: '否' },
      { belongArea: '粤海街道', entryServiceSituation: null },
      { belongArea: 'unexpected-private-location', entryServiceSituation: '是' },
      { entryServiceSituation: false },
    ];
    const data = build({ allowedMatterIds: [TRACKING], records: rows.map((data) => record(data, TRACKING)), tasks: [success(TRACKING)] });
    expect(data.tracking).toMatchObject({ total: 5, tracked: 2, untracked: 2, unknown: 1 });
    expect(data.tracking.streets).toEqual([
      { name: '粤海街道', total: 3, tracked: 1, untracked: 1, unknown: 1 },
      { name: '未知街道', total: 2, tracked: 1, untracked: 1, unknown: 0 },
    ]);
    expect(JSON.stringify(data)).not.toContain('unexpected-private-location');
  });

  it('returns canonical business states, does not guess unknown codes, sum money or expose identity values', () => {
    const secretName = 'synthetic-private-person';
    const data = build({ records: [
      record({ currentLink: '待审核', name: secretName, cardNumber: syntheticCard('19800101'), amount: 99_999 }),
      record({ currentLink: '待支付' }), record({ rdStatus: '认定有效' }),
      record({ employmentStatus: '已就业' }), record({ jyzt: '失业' }),
      record({ currentLink: secretName }), record({ currentLink: '01' }),
    ] });
    expect(count(data.statuses.buckets, 'pending')).toBe(1);
    expect(count(data.statuses.buckets, 'awaiting-payment')).toBe(1);
    expect(count(data.statuses.buckets, 'completed')).toBe(1);
    expect(count(data.statuses.buckets, 'employed')).toBe(1);
    expect(count(data.statuses.buckets, 'unemployed')).toBe(1);
    expect(count(data.statuses.buckets, 'unknown')).toBe(2);
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(secretName);
    expect(serialized).not.toContain('99999');
    expect(serialized).not.toContain('cardNumber');
    expect(serialized).not.toContain('amount');
  });

  it('reports review aging only with matching list states and valid elapsed times, preserving unknown evidence', () => {
    const dateAt = (time: number) => new Date(time).toISOString();
    const data = build({ allowedMatterIds: [SUBSIDY], records: [
      record({ currentLink: '待审核', applyDate: dateAt(NOW - 72 * 3_600_000 - 1) }, SUBSIDY),
      record({ currentLink: '待审批', applyDate: dateAt(NOW - 72 * 3_600_000) }, SUBSIDY),
      record({ currentLink: '待公示', applyDate: null }, SUBSIDY),
      record({ currentLink: '已支付', applyDate: '2000-01-01' }, SUBSIDY),
      record({ currentLink: '待审核', applyDate: '2026-11-05' }, SUBSIDY),
      record({ currentLink: 'private-status', applyDate: '2026-11-01' }, SUBSIDY),
    ], tasks: [success(SUBSIDY)] });
    expect(data.aging.review).toMatchObject({ value: 1, evaluatedCount: 3, unknownCount: 3 });
    expect(build({ allowedMatterIds: [SUBSIDY], tasks: [success(SUBSIDY)] }).aging.review.value).toBe(0);
    expect(build({ allowedMatterIds: [SUBSIDY], records: [record({ currentLink: '待审核' }, SUBSIDY)] }).aging.review.value).toBeNull();
    expect(build().aging.review.value).toBeNull();
  });

  it('uses next calendar month end for payment aging, without manufacturing unsupported alerts', () => {
    const paymentNow = Date.parse('2026-03-03T16:00:00Z');
    const data = build({ allowedMatterIds: [SUBSIDY], now: paymentNow, records: [
      record({ currentLink: '待支付', examineDateSeconde: '2026-01-15' }, SUBSIDY),
      record({ currentLink: '待支付', examineDateSeconde: '2026-02-01' }, SUBSIDY),
      record({ currentLink: '待支付', examineDateSeconde: '2026-02-30' }, SUBSIDY),
      record({ currentLink: '待支付' }, SUBSIDY),
    ] });
    expect(data.aging.payment).toMatchObject({ value: 1, evaluatedCount: 2, unknownCount: 2 });
    const unsupported = build({ allowedMatterIds: ['one-time-job-expansion-subsidy', 'youth-internship-unit'], tasks: [success('one-time-job-expansion-subsidy'), success('youth-internship-unit')] });
    expect(unsupported.aging.payment.value).toBeNull();
  });

  it('limits aggregates and coverage to the authorized subset and rejects malformed records', () => {
    const data = build({ allowedMatterIds: [POPULATION, TRACKING], records: [record({})], tasks: [success()] });
    expect(data.authorizedMatterCount).toBe(2);
    expect(data.syncedMatterCount).toBe(1);
    expect(data.syncState).toBe('partial');
    expect(data.tracking.total).toBeNull();
    expect(data.matters.map((matter) => matter.id)).toEqual([POPULATION, TRACKING]);
    expect(() => build({ now: NaN })).toThrow('统计时间无效');
    expect(() => build({ records: [record([] as unknown as Record<string, unknown>)] })).toThrow('本地记录格式无效');
  });

  it('builds subsidy charts from list fields without counting unsupported payment fields', () => {
    const expansion = 'one-time-job-expansion-subsidy';
    const data = build({ allowedMatterIds: [SUBSIDY, expansion], records: [
      record({ applyDate: '2026-10-01', applyAddress: '深圳市南山区粤海街道', applyChannel: '网站申请', payStatus: '支付成功', unitName: 'private-synthetic-unit' }, SUBSIDY),
      record({ applyDate: '2026-10-02', applyAddress: '蛇口街道办事处', applyChannel: '窗口申请', payStatus: '待支付' }, SUBSIDY),
      record({ applyDate: '2026-02-30', applyAddress: 'private-synthetic-address', applyChannel: 'private-synthetic-channel' }, expansion),
    ], tasks: [success(SUBSIDY), success(expansion)] });
    expect(data.subsidies.total).toBe(3);
    expect(data.subsidies.paymentTotal).toBe(2);
    expect([data.subsidies.paid, data.subsidies.awaitingPayment, data.subsidies.other]).toEqual([1, 1, 0]);
    expect(data.subsidies.monthly).toEqual([{ id: '2026-10', label: '2026-10', count: 2 }]);
    expect(data.subsidies.missingApplyDate).toBe(1);
    expect(data.subsidies.streets).toEqual([
      { id: '粤海街道', label: '粤海街道', count: 1 },
      { id: '蛇口街道', label: '蛇口街道', count: 1 },
      { id: '未知街道', label: '未知街道', count: 1 },
    ]);
    expect(data.subsidies.channels.map((item) => item.count)).toEqual([1, 1, 0, 1]);
    expect(JSON.stringify(data)).not.toMatch(/private-synthetic/);
  });

  it('uses confirmed payment dates, flexible subsidy months and employer applicant counts with coverage', () => {
    const flexible = 'graduate-flexible-employment-subsidy', expansion = 'one-time-job-expansion-subsidy';
    const data = build({ allowedMatterIds: [SUBSIDY, flexible, expansion], records: [
      record({ applyDate: '2026-10-01 23:59:00', payDate: '2026-10-04 00:00:00', payStatus: '支付成功', applyCount: 99 }, SUBSIDY),
      record({ applyDate: '2026-10-04', payDate: '2026-10-03', payStatus: '支付成功' }, SUBSIDY),
      record({ applyDate: '2026-10-03', payDate: '2026-10-04', payStatus: '待支付', subsidyMonthCount: '3' }, flexible),
      record({ subsidyMonthCount: 'invalid', applyCount: -3 }, flexible),
      record({ applyCount: 0, dataOrigin: '免申请-省比对' }, expansion),
      record({ applyCount: '5', dataOrigin: '窗口受理', processArea: '南山区/西丽街道' }, expansion),
    ] });
    expect(data.subsidies.averagePaymentDays).toEqual({ value: 3, recordCount: 1 });
    expect(data.subsidies.flexibleSubsidyMonths).toEqual({ value: 3, recordCount: 1 });
    expect(data.subsidies.reportedApplicants).toEqual({ value: 5, recordCount: 2 });
    expect(count(data.subsidies.channels, 'matched')).toBe(1);
    expect(count(data.subsidies.channels, 'counter')).toBe(1);
    expect(count(data.subsidies.streets, '西丽街道')).toBe(1);
    expect(build().subsidies.averagePaymentDays).toEqual({ value: null, recordCount: 0 });
  });
});
