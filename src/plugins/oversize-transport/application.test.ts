import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../core/errors/app-error';
import { enterpriseInput } from '../../core/enterprise/service';
import { supplementOversizeApplication } from './application';

const code = '91440300123456789Q', otherCode = '914403000000000061';
const row = { xkWsh: 'B4413002026101260031', xkXdrMc: '测试公司（深圳）', xkXdrShxym: '', xkFrdb: '', xkXdrLb: '法人及非法人组织' };
const application = { id: 'app-1', reqNo: row.xkWsh, transportName: '测试公司(深圳)', transportCreditCode: code };
const source = (...records: typeof application[]) => ({ fetchApplicationRecords: vi.fn(async () => records) });

describe('oversize source application identity evidence', () => {
  it('takes only the verified source code, not agent/legal-like fields; passes source identity to backend', async () => {
    const next = await supplementOversizeApplication(source({ ...application, agentName: '不是法人', agentId: '不保存', tel: '不保存' } as typeof application), row);
    expect(next).toMatchObject({ xkXdrShxym: code, xkFrdb: '', oversizeApplicationEnrichment: { status: 'matched', field: 'transportCreditCode', creditCode: code } });
    expect(JSON.stringify(next)).not.toMatch(/不是法人|不保存|agentName|agentId/);
    expect(enterpriseInput('oversize-transport', next)).toEqual({ name: row.xkXdrMc, creditCode: code, applicantCode: '' });
  });
  it.each([{ records: [] }, { records: [{ ...application, reqNo: `${row.xkWsh}9` }] }])('never uses another application or invents a missing code', async ({ records }) => {
    const next = await supplementOversizeApplication(source(...records), row);
    expect(next).toMatchObject({ xkXdrShxym: '', oversizeApplicationEnrichment: { status: 'missing' } });
    expect(enterpriseInput('oversize-transport', next)?.name).toBe(row.xkXdrMc);
  });
  it.each([
    { records: [application, { ...application, id: 'app-2' }] },
    { records: [{ ...application, transportName: '不同企业' }] },
  ])('pauses automatic lookup for duplicate numbers or inconsistent names', async ({ records }) => {
    const next = await supplementOversizeApplication(source(...records), row);
    expect(next).toMatchObject({ xkXdrShxym: '', oversizeApplicationEnrichment: { status: 'conflict' } });
    expect(enterpriseInput('oversize-transport', next)).toBeNull();
  });
  it('preserves an existing valid code and manual legal person when source code conflicts', async () => {
    const next = await supplementOversizeApplication(source(application), { ...row, xkXdrShxym: otherCode, xkFrdb: '手工法人' });
    expect(next).toMatchObject({ xkXdrShxym: otherCode, xkFrdb: '手工法人', oversizeApplicationEnrichment: { status: 'conflict', creditCode: code } });
    expect(enterpriseInput('oversize-transport', next)).toBeNull();
  });
  it.each(['91440300123456789A', '11010519491231002X', 'not-a-credit-code'])('never forwards an invalid checksum or personal identity: %s', async transportCreditCode => {
    const next = await supplementOversizeApplication(source({ ...application, transportCreditCode }), row);
    expect(next).toMatchObject({ xkXdrShxym: '', oversizeApplicationEnrichment: { status: 'invalid' } });
    expect(JSON.stringify(next)).not.toContain(transportCreditCode);
  });
  it('retains the row and a safe reason on a temporary detail failure', async () => {
    const next = await supplementOversizeApplication({ fetchApplicationRecords: async () => { throw new Error('secret upstream token'); } }, row);
    expect(next).toMatchObject({ ...row, oversizeApplicationEnrichment: { status: 'error' } });
    expect(JSON.stringify(next)).not.toContain('secret');
  });
  it.each([new AppError('SESSION_EXPIRED', 'expired'), new AppError('TASK_CANCELLED', 'cancelled'), new AppError('REMOTE_REQUEST_FAILED', 'changed', { sessionChanged: true })])('stops the entire return for auth changes/cancellation', async error => {
    await expect(supplementOversizeApplication({ fetchApplicationRecords: async () => { throw error; } }, row)).rejects.toBe(error);
  });
  it('checks cancellation even when a request resolves successfully', async () => {
    const controller = new AbortController();
    await expect(supplementOversizeApplication({ fetchApplicationRecords: async () => { controller.abort(); return [application]; } }, row, controller.signal)).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
  });
});
