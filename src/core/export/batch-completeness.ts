import type ExcelJS from 'exceljs';
import type { ExportBatchContext } from './types';

const count = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : 0;

export function batchCompleteness(context: ExportBatchContext, exportedRows: number, incompleteHandling = 0) {
  const skippedRequests = count(context.skippedRequests);
  const incomplete = Math.max(count(context.incompleteHandling), count(incompleteHandling));
  const partial = Boolean(context.partial || skippedRequests || incomplete || context.status && context.status !== 'completed');
  const warning = partial
    ? '本批次包含未完成的采集或办理过程，仅导出已保存数据；请勿视为所选范围的完整数据。'
    : context.status !== 'completed' ? '未提供完整的批次完成状态，请核对本次导出范围。' : undefined;
  const entries: Array<[string, string | number]> = [
    ['批次编号', context.taskId],
    ['业务事项', context.businessName || context.matterId || '未提供'],
    ['采集完整性', partial ? '部分完成 / 待补齐' : context.status === 'completed' ? '本次采集已完成' : '尚未确认'],
    ['说明', warning || '未记录跳过请求；本表描述本次采集结果，不代表原系统未查询范围的数据。'],
    ['日期口径', context.dateFiltering === false ? '本业务未按日期筛选；所选日期仅作记录' : context.dateBasis || '未提供，请核对原查询条件'],
    ['所选开始日期', context.startDate || '未指定'],
    ['所选结束日期', context.endDate || '未指定'],
    ['本批次已保存条数', context.batchRowCount === undefined ? '未提供' : count(context.batchRowCount)],
    ['本次导出条数', exportedRows],
    ['跳过请求次数', skippedRequests],
    ['跳过请求说明', '按请求计数，不能换算为缺失数据条数；超时等请求达到重试限制后可能跳过。'],
    ['办理过程待补齐条数', incomplete],
  ];
  if (context.batchRowCount !== undefined && exportedRows < context.batchRowCount) entries.push(['导出范围', '仅导出所选或筛选后的部分记录，未包含该批次全部已保存数据。']);
  if (!exportedRows && partial) entries.push(['空表说明', count(context.batchRowCount) > 0
    ? '当前筛选条件没有匹配记录；本批次已保存数据，请调整筛选条件后查看。'
    : '本批次未取得可导出的记录，不代表原系统在所选范围内没有数据。']);
  return { entries, warning };
}

export function appendBatchCompleteness(workbook: ExcelJS.Workbook, context: ExportBatchContext, exportedRows: number, incompleteHandling = 0): string | undefined {
  const { entries, warning } = batchCompleteness(context, exportedRows, incompleteHandling);
  const sheet = workbook.addWorksheet('批次说明');
  sheet.columns = [{ header: '项目', key: 'name', width: 26 }, { header: '内容', key: 'value', width: 100 }];
  entries.forEach(([name, value]) => sheet.addRow({ name, value }));
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF007AFF' } };
  sheet.getColumn('value').alignment = { vertical: 'top', wrapText: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (warning) {
    for (const index of [4, 5]) {
      sheet.getRow(index).font = { bold: true, color: { argb: 'FF9C0006' } };
      sheet.getRow(index).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3D6' } };
    }
  }
  return warning;
}
