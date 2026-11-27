import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../core/errors/app-error';
import { SHENZHEN_INSURANCE_MATTER, SHENZHEN_MATTERS, SHENZHEN_POST_MATTER, SHENZHEN_SYSTEM_ID, createDefaultShenzhenContext, shenzhenRecordMatterId } from './catalog';
import { mergeShenzhenRecord, normalizeShenzhenFilters, projectShenzhenHandling, queryShenzhenCases, shenzhenDateTime, shenzhenListParameters } from './query';

const matter = SHENZHEN_MATTERS.find(m => m.id === 'small-enterprise-social-insurance-subsidy')!;
const context = () => ({ page: 1, pageSize: 10, filters: { dateType: 'received', startDate: '2026-11-01', endDate: '2026-11-30' } });
const source = (id = 'CASE-A', extra: Record<string, unknown> = {}) => ({
  ywlsh: id, lsh: '', sxid: matter.sourceIds[0], sxmc: '小微企业社保补贴申领', qxmc: '续发情形', ywztlx: 'org', ywztmc: '合成测试单位',
  ywztbh: 'SYNTHETIC-ORG', kqsj: '2026-11-01 00:00:00', sqsj: '2026-10-30 09:00:00', slsj: '2026-11-02 10:00:00', bjsj: '2026-11-30 23:59:59', ywzt: '受理通过', ...extra,
});
const history = (extra: Record<string, unknown> = {}) => ({ logid: null, hjbt: '受理', hjlx: 'shouli', czr: '合成操作员', czsj: '20261102100000', spr: '合成审批员', sprq: '20261102103000',
  cjsj: '20261030100000', wcsj: '20261102110000', spyjmc: '受理通过', spsm: '合成办理意见', ...extra });
const client = (rows = [source()], logs = [history()]) => ({ list: vi.fn(async () => rows), handling: vi.fn(async (_p: { ywlsh?: string; lsh?: string }) => logs) });

describe('Shenzhen source dates and catalog', () => {
  it('keeps ten licensed entry ids and a single storage scope for the merged source', () => {
    expect(SHENZHEN_MATTERS).toHaveLength(10);
    expect(shenzhenRecordMatterId(SHENZHEN_SYSTEM_ID, SHENZHEN_POST_MATTER)).toBe(SHENZHEN_INSURANCE_MATTER);
    expect(shenzhenRecordMatterId('another-system', SHENZHEN_POST_MATTER)).toBe(SHENZHEN_POST_MATTER);
    expect(createDefaultShenzhenContext(Date.parse('2026-11-26T17:00:00Z')).filters).toEqual({ dateType: 'received', startDate: '2026-11-01', endDate: '2026-11-27' });
  });
  it.each([
    ['received', 'jssj', 'jsqssj', 'jszzsj'], ['accepted', 'slsj', 'slqssj', 'slzzsj'], ['finished', 'bjsj', 'bjqssj', 'bjzzsj'],
  ])('uses complete civil days for %s without inventing a server page', (dateType, range, start, end) => {
    const filters = normalizeShenzhenFilters({ ...context().filters, dateType });
    expect(shenzhenListParameters(filters)).toEqual({ [range]: ['20261101000000', '20261130235959'], [start]: '20261101000000', [end]: '20261130235959' });
  });
  it.each([{ startDate: '2026-02-30' }, { startDate: '2026-12-01' }, { endDate: '' }, { dateType: 'applied' }, { startDate: '2000-01-01' }])('rejects invalid or unsupported ranges before sending a request', async extra => {
    const c = client(); await expect(queryShenzhenCases(c, matter, { ...context(), filters: { ...context().filters, ...extra } })).rejects.toMatchObject({ code: 'QUERY_INVALID' });
    expect(c.list).not.toHaveBeenCalled();
  });
  it('parses source timestamp formats without rolling impossible dates or host timezone changes', () => {
    expect(shenzhenDateTime('20261127010203')).toBe('2026-11-27 01:02:03');
    expect(shenzhenDateTime('2026-11-27T01:02:03')).toBe('2026-11-27 01:02:03');
    for (const value of ['20260230000000', '20261127240100', '20261127006000', '20261127000060', '2026-11-27', null, {}]) expect(shenzhenDateTime(value)).toBe('');
  });
});

describe('Shenzhen cases with complete handling history', () => {
  it('queries the all-user source once and reads only the selected matter with explicit ids', async () => {
    const c = client([source(), source('OTHER', { sxid: 'OTHER-MATTER', sxmc: matter.name }), source('OUTSIDE', { kqsj: '2026-10-31 23:59:59' })]);
    const result = await queryShenzhenCases(c, matter, context());
    expect(result.total).toBe(1); expect(c.list).toHaveBeenCalledExactlyOnceWith(shenzhenListParameters(normalizeShenzhenFilters(context().filters)), undefined);
    expect(c.handling).toHaveBeenCalledExactlyOnceWith({ ywlsh: 'CASE-A' }, undefined);
    expect(result.rows[0]).toMatchObject({ caseNumber: 'CASE-A', scenarioName: '续发情形', subjectType: 'org', handlingRecordStatus: 'collected', handlingRecordCount: 1 });
  });
  it('uses the application branch without a workflow number and keeps equal valid events with missing ids', async () => {
    const c = client([source('', { lsh: 'APPLICATION-A', ywzt: '受理不通过' })], [history(), history()]);
    const result = await queryShenzhenCases(c, matter, context());
    expect(c.handling).toHaveBeenCalledExactlyOnceWith({ lsh: 'APPLICATION-A' }, undefined);
    expect(result.rows[0]).toMatchObject({ businessState: '受理不通过', handlingRecordStatus: 'collected', handlingRecordCount: 2 });
    expect(result.rows[0].handlingRecords.map(r => r.sourceIndex)).toEqual([1, 2]);
  });
  it('preserves operations outside the selected case date and all separate operators and timestamps', async () => {
    const rows = projectShenzhenHandling([history({ cjsj: '20261201000000', czsj: '20261001000000', secretToken: 'DO-NOT-STORE' }), history({ cjsj: '20260901000000', spyjmc: '无异议', zhbz: '1' })]);
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ operator: '合成操作员', reviewer: '合成审批员', receivedAt: '2026-12-01 00:00:00', operatedAt: '2026-10-01 00:00:00', reviewedAt: '2026-11-02 10:30:00', completedAt: '2026-11-02 11:00:00' });
    expect(rows[1]).toMatchObject({ rawResult: '无异议', result: '公示通过', withdrawn: true }); expect(JSON.stringify(rows)).not.toContain('DO-NOT-STORE');
  });
  it('does not fabricate ids or a date for invalid matching rows', async () => {
    const c = client([source('', { lsh: '' })]); await expect(queryShenzhenCases(c, matter, context())).rejects.toMatchObject({ code: 'REMOTE_REQUEST_FAILED' });
    expect(c.handling).not.toHaveBeenCalled();
    const missing = await queryShenzhenCases(client([source('MISSING', { kqsj: null })]), matter, context());
    expect(missing).toMatchObject({ total: 0, undatedExcludedCount: 1 });
  });
  it('merges repeated source rows before querying a case and keeps a stable application key on workflow creation', async () => {
    const c = client([source('PROCESS'), source('PROCESS', { lsh: 'APPLICATION' })]);
    const one = await queryShenzhenCases(c, matter, context()); expect(one.total).toBe(1); expect(c.handling).toHaveBeenCalledTimes(1);
    const before = await queryShenzhenCases(client([source('', { lsh: 'APPLICATION' })]), matter, context());
    expect(one.rows[0].recordKey).toBe(before.rows[0].recordKey);
  });
  it('rejects conflicting identity links instead of merging unrelated cases', async () => {
    const c = client([source('PROCESS-A', { lsh: 'APPLICATION' }), source('PROCESS-B', { lsh: 'APPLICATION' })]);
    await expect(queryShenzhenCases(c, matter, context())).rejects.toThrow('冲突'); expect(c.handling).not.toHaveBeenCalled();
  });
  it('uses exact configured names for matters without captured public codes', async () => {
    const unseen = SHENZHEN_MATTERS.find(m => m.id === 'housekeeping-commercial-insurance-subsidy')!;
    const c = client([source('RIGHT', { sxid: 'NEW-PUBLIC-ID', sxmc: unseen.name }), source('WRONG', { sxmc: unseen.name + '其他业务' })]);
    expect((await queryShenzhenCases(c, unseen, context())).total).toBe(1);
  });
  it('keeps two shared entries tied to the same source identity', async () => {
    const post = SHENZHEN_MATTERS.find(m => m.id === SHENZHEN_POST_MATTER)!, insurance = SHENZHEN_MATTERS.find(m => m.id === SHENZHEN_INSURANCE_MATTER)!;
    const raw = source('SHARED', { sxid: post.sourceIds[0], sxmc: post.sourceNames[0] });
    const a = await queryShenzhenCases(client([raw]), post, context()), b = await queryShenzhenCases(client([raw]), insurance, context());
    expect(a.rows[0].recordKey).toBe(b.rows[0].recordKey); expect(a.rows[0].sourceMatterName).toBe('吸纳脱贫人口社保补贴和岗位补贴');
  });
  it('keeps a failed history as incomplete and continues the next case serially', async () => {
    const c = client([source('A'), source('B')]); c.handling.mockRejectedValueOnce(new AppError('REMOTE_TIMEOUT', '合成超时')).mockResolvedValueOnce([history()]);
    const result = await queryShenzhenCases(c, matter, context());
    expect(result).toMatchObject({ total: 2, skippedRequestCount: 1 }); expect(result.rows[0].handlingRecordStatus).toBe('failed'); expect(result.rows[1].handlingRecordStatus).toBe('collected');
    const refreshed = mergeShenzhenRecord(result.rows[0], { ...result.rows[0], handlingRecordStatus: 'collected', handlingRecords: [history()] });
    expect(refreshed).toMatchObject({ handlingRecordStatus: 'failed', handlingRecordCount: 1 });
    expect(mergeShenzhenRecord({ ...result.rows[0], handlingRecordStatus: 'collected' }, refreshed).handlingRecords).toEqual([]);
  });
  it.each(['SESSION_EXPIRED', 'REMOTE_RATE_LIMITED', 'TASK_CANCELLED'] as const)('stops promptly on %s instead of hammering further cases', async code => {
    const c = client([source('A'), source('B')]); c.handling.mockRejectedValueOnce(new AppError(code, '合成状态'));
    await expect(queryShenzhenCases(c, matter, context())).rejects.toMatchObject({ code }); expect(c.handling).toHaveBeenCalledTimes(1);
  });
  it('cancels after an awaited request without continuing other cases', async () => {
    const abort = new AbortController(), c = client([source('A'), source('B')]); c.handling.mockImplementationOnce(async () => { abort.abort(); return [history()]; });
    await expect(queryShenzhenCases(c, matter, { ...context(), signal: abort.signal })).rejects.toMatchObject({ code: 'TASK_CANCELLED' }); expect(c.handling).toHaveBeenCalledTimes(1);
  });
});
