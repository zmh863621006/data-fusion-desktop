import ExcelJS from 'exceljs';
import { AppError } from '../../core/errors/app-error';
import { describe, expect, it, vi } from 'vitest';
import { parseApprovalWorkbook, queryApprovalData, type GovernmentInfoQueryTransport } from './query';
import { NEW_DRAINAGE_PERMIT_CONTENT, NEW_DRAINAGE_PERMIT_MATTER } from './field-rules';
import { GOVERNMENT_MATTERS } from './matter-catalog';

async function workbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('审批数据');
  sheet.addRow(['标题']);
  sheet.addRow(['说明']);
  sheet.addRow(['序号', '市流水号', '申办流水号', '事项名称', '申请人', '证件号码', '收件方式', '申请日期', '创建人', '处理结果', '区域', '部门', '当前环节', '审批日期', '法定审批日期']);
  sheet.addRow([1, 'CITY-1', 'APPLY-1', '污水排入排水管网许可证核发（新办）', '示例公司', 'CODE-1', '网上申请', '2026-09-01 10:00:00', '经办人', '正常受理', '南山区', '水务局', '办结', '2026-09-02 11:00:00', '2026-09-03 11:00:00']);
  sheet.addRow([2, 'CITY-2', 'APPLY-2', '不支持的事项', '忽略公司', '', '', '', '', '正常受理', '', '', '', '2026-09-02', '']);
  sheet.addRow([3, 'CITY-3', 'APPLY-3', '城市建筑垃圾处置（排放）核准', '建筑公司', '', '', '', '', '正常受理', '', '水务局', '', '2026-09-02', '']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('government information approval query', () => {
  it('retains the fixed new-permit content after detail failure or when details are unavailable', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const enrichApprovalRecord of [undefined, async () => { throw new Error('detail unavailable'); }]) {
        const result = await queryApprovalData({ exportApprovalWorkbook: workbookBuffer, enrichApprovalRecord }, {
          page: 1, pageSize: 50, filters: { startDate: '2026-09-01', endDate: '2026-09-30', matterName: NEW_DRAINAGE_PERMIT_MATTER },
        });
        expect(result.rows).toEqual([expect.objectContaining({ xknr: `示例公司：${NEW_DRAINAGE_PERMIT_CONTENT}`, xkNr: `示例公司：${NEW_DRAINAGE_PERMIT_CONTENT}` })]);
      }
    } finally { log.mockRestore(); }
  });
  it('retains the raw proxy but leaves its contractor unresolved after an attachment failure', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(await workbookBuffer()).buffer);
    workbook.worksheets[0].getRow(6).getCell(5).value = '深圳市南山区水务局';
    workbook.worksheets[0].getRow(6).getCell(6).value = '11440305MB2D27962K';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await queryApprovalData({ exportApprovalWorkbook: async () => Buffer.from(await workbook.xlsx.writeBuffer()),
        enrichApprovalRecord: async () => { throw new Error('attachment unavailable'); } }, {
        page: 1, pageSize: 50, filters: { startDate: '2026-09-01', endDate: '2026-09-30', matterName: '城市建筑垃圾处置（排放）核准' },
      });
      expect(result.rows).toEqual([expect.objectContaining({ applyer: '深圳市南山区水务局', cardNumber: '11440305MB2D27962K',
        qymc: '', xkXdrMc: '', xydm: '', xkXdrShxym: '', constructionWastePrincipal: { ruleVersion: 1, status: 'failed',
          contractorName: '', reason: expect.stringContaining('读取失败'), source: 'recordBean.primaryBean.cgwfj', field: '施工单位' } })]);
    } finally { log.mockRestore(); }
  });
  it('stops on cancellation and does not continue the next record', async () => {
    const controller = new AbortController();
    const enrichApprovalRecord = vi.fn(async () => { controller.abort(); throw new Error('aborted'); });
    await expect(queryApprovalData({ exportApprovalWorkbook: workbookBuffer, enrichApprovalRecord }, {
      page: 1, pageSize: 50, filters: { startDate: '2026-09-01', endDate: '2026-09-30' }, signal: controller.signal,
    })).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    expect(enrichApprovalRecord).toHaveBeenCalledTimes(1);
  });

  it('fails an expired session instead of reporting a successful batch', async () => {
    await expect(queryApprovalData({ exportApprovalWorkbook: workbookBuffer,
      enrichApprovalRecord: async () => { throw new AppError('SESSION_EXPIRED', 'expired'); },
    }, { page: 1, pageSize: 50, filters: { startDate: '2026-09-01', endDate: '2026-09-30' } }))
      .rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('retains failed records and continues independent enrichment', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const enrichApprovalRecord = vi.fn().mockRejectedValueOnce(new Error('bad attachment'))
        .mockImplementationOnce(async (row) => [row]);
      const result = await queryApprovalData({ exportApprovalWorkbook: workbookBuffer, enrichApprovalRecord }, {
        page: 1, pageSize: 50, filters: { startDate: '2026-09-01', endDate: '2026-09-30' },
      });
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].enrichmentStatus).toBe('failed');
      expect(enrichApprovalRecord).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });
  it('parses and classifies supported approval rows', async () => {
    const rows = await parseApprovalWorkbook(await workbookBuffer());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(expect.objectContaining({ cityLsh: 'CITY-1', sxType: '1', applyer: '示例公司' }));
    expect(rows[1]).toEqual(expect.objectContaining({ cityLsh: 'CITY-3', sxType: '1', departmentName: '水务局' }));
  });

  it('filters the exported workbook before returning rows', async () => {
    const exportApprovalWorkbook = vi.fn(async () => workbookBuffer());
    const transport: GovernmentInfoQueryTransport = { exportApprovalWorkbook };
    const result = await queryApprovalData(transport, {
      page: 1,
      pageSize: 50,
      filters: { startDate: '2026-09-01', endDate: '2026-09-30', matterName: '污水排入排水管网许可证核发（新办）' },
    });
    expect(exportApprovalWorkbook).toHaveBeenCalledWith('2026-09-01', '2026-09-30');
    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it.each([
    {}, { startDate: '2026-09-01' }, { endDate: '2026-09-30' },
  ])('requires both completion dates: %j', async (filters) => {
    const transport: GovernmentInfoQueryTransport = { exportApprovalWorkbook: vi.fn() };
    await expect(queryApprovalData(transport, { page: 1, pageSize: 50, filters }))
      .rejects.toThrow('办结开始日期和办结截止日期');
    expect(transport.exportApprovalWorkbook).not.toHaveBeenCalled();
  });

  it.each([
    { startDate: '2026-09-30', endDate: '2026-09-01' },
    { startDate: '2026-02-30', endDate: '2026-03-01' },
    { startDate: '2026-09-01', endDate: '2026-09-30 23:59:59' },
  ])('rejects invalid completion ranges before making a request: %j', async filters => {
    const exportApprovalWorkbook = vi.fn();
    await expect(queryApprovalData({ exportApprovalWorkbook }, { page: 1, pageSize: 50, filters })).rejects.toMatchObject({ code: 'QUERY_INVALID' });
    expect(exportApprovalWorkbook).not.toHaveBeenCalled();
  });

  it.each(GOVERNMENT_MATTERS)('filters $id by completion day even when application dates fall outside the range', async matter => {
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('审批数据');
    sheet.addRow(['标题']); sheet.addRow(['说明']); sheet.addRow(['表头']);
    const add = (id: string, completionDate: string, applicationDate: string) => sheet.addRow([
      1, id, id, matter.name, '示例主体', '', '', applicationDate, '', '正常受理', '', '', '', completionDate, '',
    ]);
    add('BEFORE', '2026-09-30 23:59:59', '2026-10-15');
    add('FIRST', '2026-10-01 00:00:00', '2025-01-01');
    add('LAST', '2026-11-03 23:59:59', '2026-11-04');
    add('AFTER', '2026-11-04 00:00:00', '2026-10-15');
    add('INVALID', '未办结', '2026-10-15');
    const exportApprovalWorkbook = vi.fn(async () => Buffer.from(await workbook.xlsx.writeBuffer()));
    const controller = new AbortController();
    const result = await queryApprovalData({ exportApprovalWorkbook }, { page: 1, pageSize: 50, signal: controller.signal,
      filters: { startDate: '2026-10-01', endDate: '2026-11-03', matterName: matter.name, sxType: matter.sxType } });
    expect(exportApprovalWorkbook).toHaveBeenCalledWith('2026-10-01', '2026-11-03', controller.signal);
    expect(result.rows.map(row => row.cityLsh)).toEqual(['FIRST', 'LAST']);
  });

  it('does not substitute the permit decision date for the completion-date filter', async () => {
    const result = await queryApprovalData({ exportApprovalWorkbook: workbookBuffer,
      enrichApprovalRecord: async row => [{ ...row, xkjdrq: '2025-01-01' }] }, {
      page: 1, pageSize: 50, filters: { startDate: '2026-09-01', endDate: '2026-09-30', matterName: NEW_DRAINAGE_PERMIT_MATTER },
    });
    expect(result.rows).toEqual([expect.objectContaining({ approveDate: '2026-09-02 11:00:00', xkJdrq: '2025-01-01' })]);
  });
});
