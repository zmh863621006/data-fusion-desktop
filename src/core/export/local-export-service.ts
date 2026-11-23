import ExcelJS from 'exceljs';
import { writeFile } from 'node:fs/promises';
import type { StoredRecord } from '../storage/types';
import type { ExportFormat, ExportResult } from './types';
import { DOUBLE_PUBLICITY_TEMPLATE, isDoublePublicityData } from '../double-publicity/template';
import { exportFieldValue, validateExport, type ConfirmExport, type ExportRowIssue } from '../double-publicity/validation';
import { createPermitWorkbook, fillPermitRow, PERMIT_FIRST_DATA_ROW } from '../double-publicity/permit-workbook';
import { createProvincialPermitWorkbook, validateProvincialPermit } from '../double-publicity/provincial-permit';
import { assertGovernmentExportTarget, supportsCollectionExport, type GovernmentExportTarget } from './government-target';
import { createNanshanPermitWorkbook, validateNanshanPermit } from '../double-publicity/nanshan-permit';
import { EQUIPMENT_SYSTEM_ID } from '../../plugins/guangdong-special-equipment/catalog';
import { FOOD_DRUG_SYSTEM_ID } from '../../plugins/guangdong-food-drug/catalog';
import { createCollectionJudicialWorkbook } from './collection-judicial-workbook';

const permitSystems = new Set(['government-info', 'oversize-transport', 'online-car-permit', 'transport-practitioner',
  'health-publicity', 'shenzhen-hazardous-chemicals', EQUIPMENT_SYSTEM_ID, FOOD_DRUG_SYSTEM_ID]);

function highlight(sheet: ExcelJS.Worksheet, issue: ExportRowIssue, rowNumber: number, columns: string[]) {
  const row = sheet.getRow(rowNumber);
  for (let i = 1; i <= columns.length; i++) {
    const cell = row.getCell(i);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCCCC' } };
    cell.font = { ...cell.font, color: { argb: 'FF9C0006' } };
  }
  row.getCell(1).note = `导出校验：${issue.fields.map(field => `${field.label}：${field.message}`).join('；')}`;
  for (const field of issue.fields) {
    const index = columns.findIndex(key => field.sourceKeys.includes(key));
    if (index >= 0) row.getCell(index+1).note = `${field.label}：${field.message}`;
  }
}

function cellValue(value: unknown): string | number | boolean | Date {
  if (value instanceof Date || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function csvCell(value: unknown): string {
  const text = String(cellValue(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export class LocalExportService {
  async export(path: string, format: ExportFormat, records: StoredRecord[], confirm?: ConfirmExport,
    listColumns?: readonly { key: string; label: string }[], target?: GovernmentExportTarget): Promise<ExportResult | null> {
    const systems = records.map(record => record.systemId);
    const selectedTarget = target ?? (format === 'xlsx' && systems.some(supportsCollectionExport) ? 'collection-disclosure' : undefined);
    assertGovernmentExportTarget(selectedTarget, format, systems);
    if (selectedTarget === 'collection-judicial') {
      const buffer = await createCollectionJudicialWorkbook(records);
      await writeFile(path, buffer, { flag: 'wx' });
      return { path, rowCount: records.length, createdAt: Date.now(), warningCount: 0, missingRequiredCount: 0 };
    }
    if (target === 'nanshan') {
      const validation = validateNanshanPermit(records);
      if (validation.invalid && confirm && !await confirm(validation, format)) return null;
      const buffer = await createNanshanPermitWorkbook(records, validation);
      await writeFile(path, buffer, { flag: 'wx' });
      return { path, rowCount: records.length, createdAt: Date.now(), warningCount: validation.invalid, missingRequiredCount: validation.missingRows };
    }
    if (target === 'guangdong-law') {
      const validation = validateProvincialPermit(records);
      if (validation.invalid && confirm && !await confirm(validation, format)) return null;
      const buffer = await createProvincialPermitWorkbook(records, validation);
      await writeFile(path, buffer, { flag: 'wx' });
      return { path, rowCount: records.length, createdAt: Date.now(), warningCount: validation.invalid, missingRequiredCount: validation.missingRows };
    }
    if (records.some(record => record.systemId === 'guangdong-hrss')) {
      if (!records.every(record => record.systemId === 'guangdong-hrss') || !listColumns?.length) throw new Error('请按人社业务事项单独导出台账');
      const values = records.map(record => Object.fromEntries(listColumns.map(column => [column.key, cellValue(record.data[column.key])])));
      if (format === 'xlsx') {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = '数据融合助手';
        const sheet = workbook.addWorksheet('业务列表台账');
        sheet.columns = listColumns.map(column => ({ header: column.label, key: column.key, width: Math.max(16, Math.min(36, column.label.length * 2 + 4)) }));
        values.forEach(row => sheet.addRow(row));
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF007AFF' } };
        sheet.views = [{ state: 'frozen', ySplit: 1 }];
        sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: values.length + 1, column: listColumns.length } };
        await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer()), { flag: 'wx' });
      } else if (format === 'csv') {
        const lines = [listColumns.map(column => csvCell(column.label)).join(','), ...values.map(row => listColumns.map(column => csvCell(row[column.key])).join(','))];
        await writeFile(path, `\uFEFF${lines.join('\r\n')}`, { encoding: 'utf8', flag: 'wx' });
      } else await writeFile(path, JSON.stringify(values, null, 2), { encoding: 'utf8', flag: 'wx' });
      return { path, rowCount: records.length, createdAt: Date.now(), warningCount: 0, missingRequiredCount: 0 };
    }
    const permitCount = records.filter(record => permitSystems.has(record.systemId) || isDoublePublicityData(record.data)).length;
    if (format === 'xlsx' && permitCount > 0 && permitCount !== records.length) {
      throw new Error('行政许可数据与普通查询数据不能混合导出，请分别选择后导出。');
    }
    const validation = validateExport(records);
    if (validation.invalid && confirm && !await confirm(validation, format)) return null;
    const summary = { warningCount: validation.invalid, missingRequiredCount: validation.missingRows };
    const useDoublePublicityTemplate = records.length > 0 && permitCount === records.length;
    if (useDoublePublicityTemplate && format === 'xlsx') {
      const { workbook, sheet } = createPermitWorkbook();
      records.forEach((record, index) => fillPermitRow(sheet, index + PERMIT_FIRST_DATA_ROW, [
        index + 1, ...DOUBLE_PUBLICITY_TEMPLATE.map(([key]) => {
          const value = cellValue(exportFieldValue(record, key) ?? record.data[key]);
          if (selectedTarget === 'collection-disclosure' && key === 'xkXdrZjlx'
            && typeof value === 'string' && value.includes('身份证')) return '身份证';
          return value === '' ? null : value;
        }),
      ]));
      for (const issue of validation.issues) highlight(sheet, issue, issue.rowNumber + PERMIT_FIRST_DATA_ROW - 1, ['orderNo', ...DOUBLE_PUBLICITY_TEMPLATE.map(([key]) => key)]);
      await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer()), { flag: 'wx' });
      return { path, rowCount: records.length, createdAt: Date.now(), ...summary };
    }
    const businessColumns = [...new Set(records.flatMap((record) => Object.keys(record.data)))];
    const columns = ['systemId', 'matterId', 'recordKey', 'updatedAt', ...businessColumns];
    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = '数据融合助手';
      const sheet = workbook.addWorksheet('本地数据');
      sheet.columns = columns.map((key) => ({ header: key, key, width: Math.min(40, Math.max(14, key.length * 2)) }));
      for (const record of records) {
        sheet.addRow({ systemId: record.systemId, matterId: record.matterId, recordKey: record.recordKey,
          updatedAt: new Date(record.updatedAt), ...Object.fromEntries(Object.entries(record.data).map(([key, value]) => [key, cellValue(value)])) });
      }
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F73FF' } };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      for (const issue of validation.issues) highlight(sheet, issue, issue.rowNumber+1, columns);
      await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer()), { flag: 'wx' });
    } else if (format === 'csv') {
      const lines = [columns.map(csvCell).join(',')];
      for (const record of records) {
        const values: Record<string, unknown> = { systemId: record.systemId, matterId: record.matterId,
          recordKey: record.recordKey, updatedAt: new Date(record.updatedAt).toISOString(), ...record.data };
        lines.push(columns.map((key) => csvCell(values[key])).join(','));
      }
      await writeFile(path, `\uFEFF${lines.join('\r\n')}`, { encoding: 'utf8', flag: 'wx' });
    } else {
      await writeFile(path, JSON.stringify(records, null, 2), { encoding: 'utf8', flag: 'wx' });
    }
    return { path, rowCount: records.length, createdAt: Date.now(), ...summary };
  }
}
