import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../core/errors/app-error';
import { GOVERNMENT_MATTERS } from './matter-catalog';
import { enrichGovernmentRecord, type GovernmentDetailTransport } from './enrichment';
import { queryApprovalData } from './query';

describe('other-matter export plus detail query', () => {
  const others = GOVERNMENT_MATTERS.filter((matter) => matter.departmentId === 'other');
  async function otherWorkbookBuffer() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('审批数据');
    sheet.addRow(['标题']); sheet.addRow(['说明']); sheet.addRow(['表头']);
    others.forEach((matter, i) => sheet.addRow([i + 1, `CITY-${i}`, `APPLY-${i}`, matter.name, '完整主体', '完整证件号',
      '网上申请', '2026-09-01', '经办人', '正常受理', '南山区', '来源部门', '办结', '2026-09-02', '2026-09-03']));
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
  const context = { page: 1, pageSize: 50, filters: { startDate: '2026-09-01', endDate: '2026-09-30' } };

  it('runs the complete export/filter/detail path for exactly five verified matters', async () => {
    const details: GovernmentDetailTransport = {
      searchEntry: vi.fn(async (cityLsh) => {
        const i = Number(cityLsh.split('-')[1]);
        return { result: [{ sblsh_short: cityLsh, sblsh: `APPLY-${i}`, sxmc: others[i].name, wf_entry_id: `wf-${i}` }] };
      }),
      getRunningData: vi.fn(async (id) => {
        const i = Number(id.split('-')[1]);
        return { recordBean: { primaryBean: { sblsh_short: `CITY-${i}`, sblsh: `APPLY-${i}`, sxmc: others[i].name,
          wf_entry_id: id, zjmc: '证件名称', zjbh: '00123', zzsj: '2026-09-04', zjyxqstart: '2026-09-05', zjyxqend: '长期',
          sqrmc: '脱*', sqrzjhm: '***' } } };
      }),
      searchByPrimaryKey: vi.fn(), getDocument: vi.fn(),
    };
    const enrichApprovalRecord = vi.fn((row, signal) => enrichGovernmentRecord(details, row, signal));
    const result = await queryApprovalData({ exportApprovalWorkbook: otherWorkbookBuffer, enrichApprovalRecord }, context);
    expect(result.total).toBe(8);
    expect(enrichApprovalRecord).toHaveBeenCalledTimes(5);
    expect(details.getRunningData).toHaveBeenCalledTimes(5);
    expect(details.searchByPrimaryKey).not.toHaveBeenCalled();
    expect(details.getDocument).not.toHaveBeenCalled();
    for (const row of result.rows) {
      expect(row).toMatchObject({ applyer: '完整主体', cardNumber: '完整证件号', approveDate: '2026-09-02', fillStatus: '0' });
      expect(row).not.toHaveProperty('xkZt');
      expect(row).not.toHaveProperty('xkCljg');
      if (others.find((matter) => matter.name === row.sxmc)?.supportsCertificateEnrichment) {
        expect(row).toMatchObject({ certificateNumber: '00123', certificateIssuedDate: '2026-09-04',
          certificateEnrichment: { status: 'partial' } });
      } else expect(row).not.toHaveProperty('certificateEnrichment');
    }
  });

  it('retains export data and failure evidence while continuing other records', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const enrichApprovalRecord = vi.fn().mockRejectedValueOnce(new Error('identity mismatch'))
        .mockImplementation(async (row) => [row]);
      const { rows } = await queryApprovalData({ exportApprovalWorkbook: otherWorkbookBuffer, enrichApprovalRecord }, context);
      expect(rows[2]).toMatchObject({ applyer: '完整主体', cardNumber: '完整证件号', enrichmentStatus: 'failed',
        certificateEnrichment: { status: 'failed', fields: { certificateNumber: { reason: 'unavailable' } } } });
      expect(rows[2]).not.toHaveProperty('xkCljg');
      expect(rows).toHaveLength(8);
      expect(enrichApprovalRecord).toHaveBeenCalledTimes(5);
    } finally { log.mockRestore(); }
  });

  it.each(['SESSION_EXPIRED', 'TASK_CANCELLED'] as const)('terminates new enrichment on %s', async (code) => {
    const enrichApprovalRecord = vi.fn(async () => { throw new AppError(code, '测试中断'); });
    await expect(queryApprovalData({ exportApprovalWorkbook: otherWorkbookBuffer, enrichApprovalRecord }, context))
      .rejects.toMatchObject({ code });
    expect(enrichApprovalRecord).toHaveBeenCalledTimes(1);
  });

  it('forwards cancellation and stops after the active detail request', async () => {
    const controller = new AbortController();
    const enrichApprovalRecord = vi.fn(async (row, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return [row];
    });
    await expect(queryApprovalData({ exportApprovalWorkbook: otherWorkbookBuffer, enrichApprovalRecord }, {
      ...context, signal: controller.signal,
    })).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    expect(enrichApprovalRecord).toHaveBeenCalledTimes(1);
  });
});
