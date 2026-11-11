import ExcelJS from 'exceljs';
import { AppError } from '../../core/errors/app-error';
import type { QueryContext, QueryPage } from '../../core/query/types';
import { GOVERNMENT_MATTER_BY_NAME } from './matter-catalog';
import { toDoublePublicityRecord } from './enrichment';
import { supplementCertificateFields } from './certificate-fields';
import { constructionWastePrincipalFields } from './construction-waste';
import { applyFixedDrainagePermitContent } from './field-rules';

export interface GovernmentInfoQueryTransport {
  exportApprovalWorkbook(startDate: string, endDate: string, signal?: AbortSignal): Promise<Buffer>;
  enrichApprovalRecord?(record: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>[]>;
}

function formatDate(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19).replace('T', ' ');
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatDate(value);
  if (typeof value === 'object') {
    if ('result' in value && value.result !== undefined) return cellText(value.result as ExcelJS.CellValue);
    if ('text' in value) return String(value.text ?? '').trim();
    if ('richText' in value) return value.richText.map((part) => part.text).join('').trim();
  }
  return String(value).trim();
}

function datePart(value: string): string {
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  const date = match?.[0] ?? '';
  if (!date) return '';
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : '';
}

export async function parseApprovalWorkbook(data: Buffer): Promise<Record<string, unknown>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(data).buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new AppError('REMOTE_REQUEST_FAILED', '综合信息平台导出文件没有工作表');

  const rows: Record<string, unknown>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < 4) return;
    const cityLsh = cellText(row.getCell(2).value);
    const sxmc = cellText(row.getCell(4).value);
    if (!cityLsh || !sxmc) return;
    const matter = GOVERNMENT_MATTER_BY_NAME.get(sxmc);
    if (!matter) return;
    rows.push({
      cityLsh,
      sblsh: cellText(row.getCell(3).value),
      sxType: matter.sxType,
      departmentId: matter.departmentId,
      departmentName: matter.departmentName,
      sxmc,
      applyer: cellText(row.getCell(5).value),
      cardNumber: cellText(row.getCell(6).value),
      receiveType: cellText(row.getCell(7).value),
      applyDate: cellText(row.getCell(8).value),
      creater: cellText(row.getCell(9).value),
      processResult: cellText(row.getCell(10).value),
      area: cellText(row.getCell(11).value),
      department: cellText(row.getCell(12).value),
      currentLink: cellText(row.getCell(13).value),
      approveDate: cellText(row.getCell(14).value),
      fdApproveDate: cellText(row.getCell(15).value),
      fillStatus: '0',
    });
  });
  return rows;
}

export async function queryApprovalData(
  transport: GovernmentInfoQueryTransport,
  context: QueryContext,
): Promise<QueryPage<Record<string, unknown>>> {
  const startDate = typeof context.filters.startDate === 'string' ? context.filters.startDate : '';
  const endDate = typeof context.filters.endDate === 'string' ? context.filters.endDate : '';
  const sxType = typeof context.filters.sxType === 'string' ? context.filters.sxType : '';
  const matterName = typeof context.filters.matterName === 'string' ? context.filters.matterName.trim() : '';
  const subjectName = typeof context.filters.subjectName === 'string'
    ? context.filters.subjectName.trim().toLocaleLowerCase()
    : '';
  const configuredLimit = typeof context.filters.maxRows === 'number' ? context.filters.maxRows : 500;
  const maxRows = Math.min(Math.max(Math.trunc(configuredLimit), 1), 5_000);
  if (!startDate || !endDate) throw new AppError('QUERY_INVALID', '请选择办结开始日期和办结截止日期');
  if (datePart(startDate) !== startDate || datePart(endDate) !== endDate) throw new AppError('QUERY_INVALID', '办结日期范围无效');
  if (startDate > endDate) throw new AppError('QUERY_INVALID', '办结开始日期不能晚于办结截止日期');
  const checkCancelled = () => {
    if (context.signal?.aborted) throw new AppError('TASK_CANCELLED', '回流任务已取消');
  };
  checkCancelled();

  const workbook = context.signal
    ? await transport.exportApprovalWorkbook(startDate, endDate, context.signal)
    : await transport.exportApprovalWorkbook(startDate, endDate);
  const parsed = await parseApprovalWorkbook(workbook);
  const seen = new Set<string>();
  const filtered = parsed.filter((row) => {
    if (row.processResult !== '正常受理' || !row.approveDate) return false;
    if (matterName && row.sxmc !== matterName) return false;
    const approved = datePart(String(row.approveDate));
    if (!approved || approved < startDate || approved > endDate) return false;
    if (sxType && row.sxType !== sxType) return false;
    if (subjectName && !String(row.applyer ?? '').toLocaleLowerCase().includes(subjectName)) return false;
    const cityLsh = String(row.cityLsh);
    if (seen.has(cityLsh)) return false;
    seen.add(cityLsh);
    return true;
  });
  const selected = filtered.slice(0, maxRows);
  if (filtered.length > maxRows) {
    throw new AppError('QUERY_INVALID', `符合条件的数据超过 ${maxRows} 条，请缩小日期范围后回流`);
  }
  const rows: Record<string, unknown>[] = [];
  for (const row of selected) {
    checkCancelled();
    const matter = GOVERNMENT_MATTER_BY_NAME.get(String(row.sxmc));
    if (!transport.enrichApprovalRecord || !(matter?.supportsDoublePublicityEnrichment || matter?.supportsCertificateEnrichment)) {
      rows.push(row);
      continue;
    }
    try {
      const enriched = await transport.enrichApprovalRecord(row, context.signal);
      checkCancelled();
      rows.push(...enriched.map(toDoublePublicityRecord));
    } catch (error) {
      checkCancelled();
      if (error instanceof AppError && ['SESSION_EXPIRED', 'TASK_CANCELLED'].includes(error.code)) throw error;
      console.error('政务综合信息平台单条数据补全失败', {
        cityLsh: row.cityLsh, sxmc: row.sxmc, error,
      });
      const failed = { ...row, enrichmentStatus: 'failed', ...constructionWastePrincipalFields(row, [], true) };
      rows.push(matter?.supportsCertificateEnrichment
        ? supplementCertificateFields(failed, {}, true) : toDoublePublicityRecord(failed));
    }
  }
  return { rows: rows.map(applyFixedDrainagePermitContent), page: 1, pageSize: rows.length || maxRows, total: rows.length };
}

export const governmentInfoMatterOptions = [
  { label: '全部双公示事项', value: '' },
  { label: '水务许可', value: '1' },
  { label: '教师资格', value: '8' },
  { label: '残疾儿童康复补贴', value: '9' },
  { label: '营业性演出', value: '10' },
  { label: '房屋租赁备案', value: '11' },
  { label: '危化品及易制毒备案', value: '12' },
  { label: '城管许可', value: '13' },
];
