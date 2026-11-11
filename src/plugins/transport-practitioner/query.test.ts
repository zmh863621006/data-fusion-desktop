import { describe, expect, it, vi } from 'vitest';
import { mapPractitionerRecord, pickTaxiDates, queryPractitionerData, type PractitionerQueryTransport } from './query';

describe('transport practitioner query', () => {
  it('uses the newer taxi certificate date group', () => {
    expect(pickTaxiDates({
      WangYueCongYeZiGeZhengFaZhengRiQi: '2026-09-10',
      WangYueCongYeZiGeZhengYouXiaoRiQi: '2032-09-10',
      XunYouCongYeZiGeZhengFaZhengRiQi: '2024-01-01',
      XunYouCongYeZiGeZhengYouXiaoRiQi: '2030-01-01',
    })).toEqual(['2026-09-10', '2032-09-10']);
  });

  it('maps the legacy double-publicity fields without dropping the source identity', () => {
    expect(mapPractitionerRecord({
      XingMing: '测试人员', CongYeZiGeZhengHao: 'CERT-1', CongYeZiGeLeiBie: '道路货物运输驾驶员',
      CongYeZiGeZhengFaZhengRiQi: '2026-09-01', CongYeZiGeZhengYouXiaoRiQi: '2032-09-01',
    }, 'road')).toEqual(expect.objectContaining({
      xkXdrMc: '测试人员', xkXdrZjhm: 'CERT-1', xkJdrq: '2026-09-01',
      xkXkjgdm: '114413000071877877', xkNr: '从业资格证核发',
    }));
  });

  it('paginates both archive categories and merges them', async () => {
    const fetchArchivePage = vi.fn(async (category: 'road' | 'taxi', _start: string, _end: string, page: number) => {
      if (category === 'road' && page === 1) return { total: 1001, items: [{ CongYeZiGeZhengHao: 'R1' }] };
      if (category === 'road' && page === 2) return { total: 1001, items: [{ CongYeZiGeZhengHao: 'R2' }] };
      return { total: 1, items: [{ CongYeZiGeZhengHao: 'T1' }] };
    });
    const result = await queryPractitionerData({ fetchArchivePage } as PractitionerQueryTransport, {
      page: 1, pageSize: 10, filters: { startDate: '2026-09-01', endDate: '2026-09-18' },
    });
    expect(result.total).toBe(3);
    expect(fetchArchivePage).toHaveBeenCalledTimes(3);
    expect(fetchArchivePage.mock.calls.every(call => call[1] === '2026-08-31' && call[2] === '2026-09-18')).toBe(true);
  });

  it.each([['2026-10-13','2026-10-12'],['2026-01-01','2025-12-31'],['2024-03-01','2024-02-29']])('adjusts both businesses for same-day query %s', async (date, expected) => {
    const fetchArchivePage = vi.fn(async () => ({ total: 0, items: [] }));
    const context = { page: 1, pageSize: 10, filters: { startDate: date, endDate: date } };
    await queryPractitionerData({ fetchArchivePage }, context);
    expect(fetchArchivePage).toHaveBeenCalledWith('road', expected, date, 1, 1000, undefined);
    expect(fetchArchivePage).toHaveBeenCalledWith('taxi', expected, date, 1, 1000, undefined);
    expect(context.filters.startDate).toBe(date);
  });
});
