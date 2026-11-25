import { describe, expect, it } from 'vitest';
import { hrssDateBasis, hrssDateFilter, hrssDefaultDateFilters, hrssReturnDateDetails, hrssTaskDateLabel, validateHrssDateFilters } from './date-filters';

describe('requested dates and effective HRSS query scope', () => {
  it('preserves the existing unemployment start and defaults other controls to the Shanghai calendar month', () => {
    const now = Date.parse('2026-10-31T23:30:00Z');
    expect(hrssDefaultDateFilters('unemployment', now)).toEqual({ startDate: '2025-05-01', endDate: '2026-11-01' });
    expect(hrssDefaultDateFilters('job-seeking-startup-subsidy', now)).toEqual({ startDate: '2026-11-01', endDate: '2026-11-01' });
  });
  it('keeps an unverified poverty selection separate and states that no unconstrained query runs', () => {
    const filters = { startDate: '2026-10-01', endDate: '2026-10-31' };
    const details = hrssReturnDateDetails('poverty-alleviation-personnel', filters);
    expect(details).toEqual({ requestedStartDate: filters.startDate, requestedEndDate: filters.endDate, dateFilterStatus: 'pending', dateScope: 'blocked-unverified-date' });
    expect(details).not.toHaveProperty('startDate'); expect(details).not.toHaveProperty('endDate');
    expect(hrssTaskDateLabel(details)).toContain('所选 2026-10-01 至 2026-10-31（原站日期条件未确认，已暂停回流）');
    expect(hrssDateFilter('poverty-alleviation-personnel').message).toContain('暂停');
  });
  it.each([
    ['unemployment','bce089','登记日期'],['job-seeking-startup-subsidy','adc705','申请日期'],
    ['employment-difficulty-recognition','cdc138','申请日期'],['youth-internship-unit','cdc111','申请日期'],
    ['unemployment-tracking-service','bae003','服务对象创建日期'],['startup-training','BCE089','申请日期'],
    ['enterprise-hiring-difficult-personnel-subsidy','adc705','申请日期'],
  ])('keeps source-specific effective dates for %s', (matterId,field,label) => {
    const filters = { startDate: '2026-10-01', endDate: '2026-10-31' };
    expect(hrssReturnDateDetails(matterId, filters)).toMatchObject({ ...filters, dateFilterStatus: 'applied', dateBasis: field, dateBasisLabel:label });
    expect(hrssTaskDateLabel(hrssReturnDateDetails(matterId, filters))).toBe('2026-10-01 至 2026-10-31');
    expect(hrssDateFilter(matterId).message).toContain(label);
  });
  it('does not label the internship personnel date as an application date',()=>{
    expect(hrssDateBasis('youth-internship-agreement')).toEqual({field:'review:cdc111;registration:bae062',label:'审核申请日期／查询见习开始日期'});
    expect(hrssDateFilter('youth-internship-agreement').message).toContain('查询列表按见习开始日期');
    expect(hrssDateFilter('one-time-job-expansion-subsidy').mode).toBe('pending');
  });
  it.each([
    { startDate: '2026-02-30', endDate: '2026-03-01' }, { startDate: '2026-11-05', endDate: '2026-11-01' },
    { startDate: '', endDate: '2026-11-05' }, { startDate: '2026-11-01' },
  ])('rejects invalid selected date ranges before any remote query: %j', filters => {
    expect(() => validateHrssDateFilters(filters)).toThrow();
  });
});
