import { describe, expect, it } from 'vitest';
import { hrssDateFilter, hrssDefaultDateFilters, hrssReturnDateDetails, hrssTaskDateLabel, validateHrssDateFilters } from './date-filters';

describe('requested dates and effective HRSS query scope', () => {
  it('preserves the existing unemployment start and defaults other controls to the Shanghai calendar month', () => {
    const now = Date.parse('2026-10-31T23:30:00Z');
    expect(hrssDefaultDateFilters('unemployment', now)).toEqual({ startDate: '2025-05-01', endDate: '2026-11-01' });
    expect(hrssDefaultDateFilters('job-seeking-startup-subsidy', now)).toEqual({ startDate: '2026-11-01', endDate: '2026-11-01' });
  });
  it('separately records pending selection without claiming it is the remote query range', () => {
    const filters = { startDate: '2026-10-01', endDate: '2026-10-31' };
    const details = hrssReturnDateDetails('job-seeking-startup-subsidy', filters);
    expect(details).toEqual({ requestedStartDate: filters.startDate, requestedEndDate: filters.endDate, dateFilterStatus: 'pending', dateScope: 'original-list' });
    expect(details).not.toHaveProperty('startDate'); expect(details).not.toHaveProperty('endDate');
    expect(hrssTaskDateLabel(details)).toContain('所选 2026-10-01 至 2026-10-31（日期筛选待接入）');
    expect(hrssReturnDateDetails('unemployment-tracking-service', filters)).toMatchObject({ dateFilterStatus: 'pending', dateScope: 'current-month' });
    expect(hrssDateFilter('unemployment-tracking-service').message).toContain('本月');
  });
  it('keeps effective date metadata for the existing unemployment API only', () => {
    const filters = { startDate: '2026-10-01', endDate: '2026-10-31' };
    expect(hrssReturnDateDetails('unemployment', filters)).toMatchObject({ ...filters, dateFilterStatus: 'applied', dateBasis: 'bce089' });
    expect(hrssTaskDateLabel(hrssReturnDateDetails('unemployment', filters))).toBe('2026-10-01 至 2026-10-31');
  });
  it.each([
    { startDate: '2026-02-30', endDate: '2026-03-01' }, { startDate: '2026-11-05', endDate: '2026-11-01' },
    { startDate: '', endDate: '2026-11-05' }, { startDate: '2026-11-01' },
  ])('rejects invalid selected date ranges before any remote query: %j', filters => {
    expect(() => validateHrssDateFilters(filters)).toThrow();
  });
});
