import { describe, expect, it, vi } from 'vitest';
import { enrichHrssStreetRecord, HRSS_STREET_PROFILES, isHrssStreetPendingAcceptance } from './street';

const rawCase = { bbe955: '07', bbe955Name: '办理成功', bzd417: 'CASE-1', bke910: 'BATCH-NOT-THE-JOIN-ID' };
const log = (id: string) => ({ bcea9j: id, bzd408Name: '受理', bae045Name: '受理通过', bee071: '符合条件', bcbpjb: '2026-10-01 10:20:30', bae046Name: '窗口人员', bab019Name: '街道办', secret: 'discard', attachments: ['discard'] });

describe('街道办现代补贴列表与办理记录', () => {
  it('registers three distinct read-only lists without unit/person detail endpoints', () => {
    expect(Object.keys(HRSS_STREET_PROFILES)).toHaveLength(3);
    for (const profile of Object.values(HRSS_STREET_PROFILES)) {
      expect(profile.sources).toHaveLength(1);
      expect(profile.sources[0]).toMatchObject({ method: 'GET', identity: [['applyBh']] });
      expect(profile.sources[0].path).toMatch(/\/progress\/unit\/list$/);
      expect(profile.columns.some(column => column.key === 'handlingRecordCount')).toBe(true);
    }
  });
  it('retains verified 待受理 code 02 with zero records without requesting history or requiring its join id', async () => {
    const requestHandlingRecords = vi.fn();
    expect(await enrichHrssStreetRecord({ requestHandlingRecords }, { bbe955: '02', bbe955Name: '待受理' })).toEqual({handlingRecordCount:0,handlingRecordStatus:'skipped-pending',handlingRecords:[]});
    expect(await enrichHrssStreetRecord({ requestHandlingRecords }, { bbe955Name: '待受理' })).toEqual({handlingRecordCount:0,handlingRecordStatus:'skipped-pending',handlingRecords:[]});
    expect(requestHandlingRecords).not.toHaveBeenCalled();
    expect(isHrssStreetPendingAcceptance({ bbe955: '01', bbe955Name: '待提交' })).toBe(false);
  });
  it('rejects unknown, missing, or contradictory statuses instead of guessing', async () => {
    const requestHandlingRecords = vi.fn();
    for (const status of [{}, { bbe955: '20' }, { bbe955Name: '未知' }, { bbe955: '03', bbe955Name: '待受理' }]) {
      await expect(enrichHrssStreetRecord({ requestHandlingRecords }, { ...rawCase, bbe955: undefined, bbe955Name: undefined, ...status })).rejects.toThrow(/办理状态/);
    }
    expect(requestHandlingRecords).not.toHaveBeenCalled();
  });
  it('uses bzd417 rather than bke910 and retains all handling dates independently of the application range', async () => {
    const requestHandlingRecords = vi.fn(async () => ({ total: 2, rows: [log('LOG-1'), { ...log('LOG-2'), bcbpjb: '2026-12-01 09:00:00' }] }));
    const result = await enrichHrssStreetRecord({ requestHandlingRecords }, rawCase);
    expect(requestHandlingRecords).toHaveBeenCalledWith({ current: 1, size: 200, bzd417: 'CASE-1', aaa025: '02' }, undefined);
    expect(result).toMatchObject({ handlingRecordCount: 2, handlingRecordStatus: 'collected' });
    expect(result?.handlingRecords).toEqual([
      { step: '受理', action: '受理通过', opinion: '符合条件', handledAt: '2026-10-01 10:20:30', operator: '窗口人员', organization: '街道办', result: '' },
      { step: '受理', action: '受理通过', opinion: '符合条件', handledAt: '2026-12-01 09:00:00', operator: '窗口人员', organization: '街道办', result: '' },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('accepts an explicitly empty log list, including non-pending 待提交 cases', async () => {
    const requestHandlingRecords = vi.fn(async () => ({ total: 0, rows: [] }));
    expect(await enrichHrssStreetRecord({ requestHandlingRecords }, { ...rawCase, bbe955: '01', bbe955Name: '待提交' })).toEqual({ handlingRecordCount: 0, handlingRecordStatus: 'collected', handlingRecords: [] });
  });
  it('paginates records and rejects short pages, duplicate ids, and changed totals', async () => {
    const first = Array.from({ length: 200 }, (_, i) => log(`LOG-${i}`));
    const requestHandlingRecords = vi.fn().mockResolvedValueOnce({ total: 201, rows: first }).mockResolvedValueOnce({ total: 201, rows: [log('LOG-200')] });
    expect((await enrichHrssStreetRecord({ requestHandlingRecords }, rawCase))?.handlingRecordCount).toBe(201);
    expect(requestHandlingRecords).toHaveBeenNthCalledWith(2, { current: 2, size: 200, bzd417: 'CASE-1', aaa025: '02' }, undefined);
    await expect(enrichHrssStreetRecord({ requestHandlingRecords: vi.fn(async () => ({ total: 2, rows: [log('ONE')] })) }, rawCase)).rejects.toThrow('分页条数');
    await expect(enrichHrssStreetRecord({ requestHandlingRecords: vi.fn(async () => ({ total: 2, rows: [log('SAME'), log('SAME')] })) }, rawCase)).rejects.toThrow('重复');
    const changed = vi.fn().mockResolvedValueOnce({ total: 201, rows: first }).mockResolvedValueOnce({ total: 202, rows: [log('LOG-200')] });
    await expect(enrichHrssStreetRecord({ requestHandlingRecords: changed }, rawCase)).rejects.toThrow('总数发生变化');
  });
  it('preserves identical source events when no record id is returned, including across page boundaries', async () => {
    const noId = { ...log('NOT-RETURNED'), bcea9j: undefined };
    const requestHandlingRecords = vi.fn().mockResolvedValueOnce({ total: 201, rows: Array.from({ length: 200 }, () => ({ ...noId })) }).mockResolvedValueOnce({ total: 201, rows: [{ ...noId }] });
    const result = await enrichHrssStreetRecord({ requestHandlingRecords }, rawCase);
    expect(result?.handlingRecordCount).toBe(201);
    expect(result?.handlingRecords).toHaveLength(201);
    expect(new Set(result?.handlingRecords.map(row => JSON.stringify(row))).size).toBe(1);
  });
  it('detects a repeated full page even if the source omits every record id', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ ...log(''), bcea9j: undefined, bee071: `原始意见${i}` }));
    const requestHandlingRecords = vi.fn(async () => ({ total: 400, rows }));
    await expect(enrichHrssStreetRecord({ requestHandlingRecords }, rawCase)).rejects.toThrow('重复分页');
    expect(requestHandlingRecords).toHaveBeenCalledTimes(2);
  });
  it('propagates record failures without reporting partial success and validates join ids before request', async () => {
    const requestHandlingRecords = vi.fn(async () => { throw new Error('日志读取失败'); });
    await expect(enrichHrssStreetRecord({ requestHandlingRecords }, rawCase)).rejects.toThrow('日志读取失败');
    requestHandlingRecords.mockClear();
    for (const bzd417 of ['', undefined, 'MASKED***']) await expect(enrichHrssStreetRecord({ requestHandlingRecords }, { ...rawCase, bzd417 })).rejects.toThrow('关联编号');
    expect(requestHandlingRecords).not.toHaveBeenCalled();
  });
  it('checks cancellation before and after each request', async () => {
    const aborted = new AbortController(); aborted.abort();
    const requestHandlingRecords = vi.fn();
    await expect(enrichHrssStreetRecord({ requestHandlingRecords }, rawCase, aborted.signal)).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    expect(requestHandlingRecords).not.toHaveBeenCalled();
    const controller = new AbortController();
    const during = vi.fn(async () => { controller.abort(); return { total: 0, rows: [] }; });
    await expect(enrichHrssStreetRecord({ requestHandlingRecords: during }, rawCase, controller.signal)).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
  });
});
