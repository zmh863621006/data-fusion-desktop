import { describe, expect, it, vi } from 'vitest';
import { isHuizhouCertificate, mapOversizeCertificate, oversizeDay, queryOversizeTransport } from './query';
import { AppError } from '../../core/errors/app-error';
const certificate = { id: 'one', reqNo: 'B4413002026101260031', transportName: '测试运输企业',
  handerTime: '2026-10-12 17:27:58', startTime: '2026-11-01 00:00:00', endTime: '2027-01-31 23:59:59', roadLine: '起点—终点', status: 0 };
const context = { page: 1, pageSize: 10, filters: { startDate: '2026-10-01', endDate: '2026-10-18' } };
const noApplications = { fetchApplicationRecords: async () => [] };
describe('oversize 3.0 return mapping', () => {
  it('maps reqNo/route/handling day exactly, retaining source validity and a blank remark', () => {
    expect(mapOversizeCertificate(certificate)).toMatchObject({ xkXdrMc: '测试运输企业', xkXdrShxym: '', xkFrdb: '',
      xkWsh: certificate.reqNo, xkXkbh: certificate.reqNo, xkNr: '起点—终点', xkJdrq: '2026-10-12',
      xkYxqz: '2026-11-01', xkYxqzi: '2027-01-31', bz: '', xkZt: '1' });
  });
  it.each(['B4413002026101260031', 'D4413002026101260155'])('accepts a letter immediately followed by Huizhou code: %s', (value) => expect(isHuizhouCertificate(value)).toBe(true));
  it.each(['B44010020264413001', '44130020261001', 'BB44130020261001', 'B4413oops'])('rejects unrelated or malformed region numbers: %s', (value) => expect(isHuizhouCertificate(value)).toBe(false));
  it('filters using handerTime, not validity start or certificate status', async () => {
    const source = { ...noApplications, fetchIssuedList: vi.fn(async () => [certificate,
      { ...certificate, id: 'two', reqNo: 'D4413002026101260155', status: 1, handerTime: '2026-10-18 23:59:59' },
      { ...certificate, id: 'three', reqNo: 'B44010020264413001' },
      { ...certificate, id: 'four', reqNo: 'B4413002026101260032', handerTime: '2026-10-19 00:00:00' }]) };
    const result = await queryOversizeTransport(source, context);
    expect(result.total).toBe(2); expect(result.rows[0].xkYxqz).toBe('2026-11-01'); expect(result.rows[1].xkJdrq).toBe('2026-10-18');
  });
  it('does not silently lose records with unknown handling dates or duplicate reqNo', async () => {
    await expect(queryOversizeTransport({ ...noApplications, fetchIssuedList: async () => [{ ...certificate, handerTime: '' }] }, context)).rejects.toThrow('办理日期');
    await expect(queryOversizeTransport({ ...noApplications, fetchIssuedList: async () => [certificate, { ...certificate, id: 'two' }] }, context)).rejects.toThrow('多份证件');
  });
  it('rejects impossible dates and malformed filters', async () => {
    expect(oversizeDay('2026-02-30')).toBe(''); expect(oversizeDay('2026-10-12T00:00:00')).toBe('2026-10-12');
    expect(() => mapOversizeCertificate({ ...certificate, endTime: '2026-01-01' })).toThrow('有效期');
    await expect(queryOversizeTransport({ ...noApplications, fetchIssuedList: async () => [] }, { ...context, filters: { startDate: '2026-02-30', endDate: '2026-10-18' } })).rejects.toMatchObject({ code: 'QUERY_INVALID' });
  });
  it('retains missing source route/name for the existing conspicuous export warnings, without inventing data', () => {
    expect(mapOversizeCertificate({ ...certificate, roadLine: '', transportName: '' })).toMatchObject({ xkNr: '', xkXdrMc: '', xkFrdb: '', bz: '' });
  });
  it('honors cancellation without returning partial data', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(queryOversizeTransport({ ...noApplications, fetchIssuedList: async () => [certificate] }, { ...context, signal: controller.signal })).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
  });
  it('looks up full application numbers only after region/date selection, never taking a fuzzy match', async () => {
    const source = { fetchIssuedList: async () => [certificate, { ...certificate, reqNo: 'B44010020264413001' },
      { ...certificate, reqNo: 'B4413002026101260032', handerTime: '2026-10-19' }],
      fetchApplicationRecords: vi.fn(async (reqNo: string) => [{ id: 'app-1', reqNo, transportName: certificate.transportName, transportCreditCode: '91440300123456789Q' },
        { id: 'other', reqNo: `${reqNo}9`, transportName: '其他企业', transportCreditCode: '914403000000000061' }]) };
    const result = await queryOversizeTransport(source, context);
    expect(source.fetchApplicationRecords).toHaveBeenCalledExactlyOnceWith(certificate.reqNo, undefined);
    expect(result.rows[0]).toMatchObject({ xkXdrShxym: '91440300123456789Q', xkFrdb: '', oversizeApplicationEnrichment: { status: 'matched', reqNo: certificate.reqNo, field: 'transportCreditCode' } });
  });
  it('does not mix certificates and applications across two logins in one return', async () => {
    let changed = false;
    const fetchApplicationRecords = vi.fn(async () => { changed = true; return []; });
    const source = { fetchIssuedList: async () => [certificate, { ...certificate, reqNo: 'B4413002026101260032' }],
      fetchApplicationRecords, captureQuerySession: () => () => { if (changed) throw new AppError('REMOTE_REQUEST_FAILED', 'session changed', { sessionChanged: true }); } };
    await expect(queryOversizeTransport(source, context)).rejects.toMatchObject({ details: { sessionChanged: true } });
    expect(fetchApplicationRecords).toHaveBeenCalledTimes(1);
  });
});
