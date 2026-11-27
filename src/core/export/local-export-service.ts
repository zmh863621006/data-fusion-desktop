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
import { handlingColumns, hasHandlingRecords, handlingCountLabel, hrssHandlingStatusLabel, readHandlingRecords } from '../hrss/handling-records';

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
    if (records.some(record => ['guangdong-hrss', 'shenzhen-integrated-services'].includes(record.systemId))) {
      const systemId = records[0].systemId, shenzhen = systemId === 'shenzhen-integrated-services';
      const exportError = shenzhen ? '请按深圳一体化业务事项单独导出台账' : '请按人社业务事项单独导出台账';
      if (!records.every(record => record.systemId === systemId) || !listColumns?.length) throw new Error(exportError);
      const columns = listColumns.filter(column => column.key !== 'handlingRecords');
      if (!columns.length) throw new Error(exportError);
      const values = records.map(record => Object.fromEntries(columns.map(column => [column.key, column.key === 'handlingRecordStatus'
        ? hrssHandlingStatusLabel(record.data[column.key]) : column.key === 'handlingRecordCount'
          ? handlingCountLabel(record.data[column.key], record.data) : cellValue(record.data[column.key])])));
      if (format === 'xlsx') {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = '数据融合助手';
        const sheet = workbook.addWorksheet(shenzhen ? '办件列表' : '业务列表台账');
        sheet.columns = columns.map(column => ({ header: column.label, key: column.key, width: Math.max(16, Math.min(36, column.label.length * 2 + 4)) }));
        values.forEach(row => sheet.addRow(row));
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF007AFF' } };
        sheet.views = [{ state: 'frozen', ySplit: 1 }];
        sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: values.length + 1, column: columns.length } };
        records.forEach((record, index) => {
          if (record.data.handlingRecordStatus !== 'failed') return;
          const row = sheet.getRow(index + 2);
          row.getCell(1).note = '本次办理过程尚未补齐，当前办件资料已保留；存在历史记录时另表保留上次采集内容。重新回流可补齐。';
          for (let i = 1; i <= columns.length; i++) row.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3D6' } };
        });
        const handlingCases = records.filter(record => hasHandlingRecords(record.systemId, record.matterId));
        if (handlingCases.length) {
          const history = workbook.addWorksheet('办理记录');
          const historyColumns = handlingColumns(systemId, true);
          history.columns = [
            ...(shenzhen ? [
              { header: '办件编号', key: 'caseNumber', width: 26 }, { header: '申办流水号', key: 'applicationNumber', width: 26 },
              { header: '业务流水号', key: 'processNumber', width: 26 }, { header: '事项名称', key: 'sourceMatterName', width: 36 },
              { header: '申请人 / 单位', key: 'subjectName', width: 36 }, { header: '过程采集状态', key: 'historyStatus', width: 24 },
            ] : [
              { header: '申请编号', key: 'applyBh', width: 26 }, { header: '单位名称', key: 'unitName', width: 36 },
              { header: '申请日期', key: 'applyDate', width: 18 },
            ]),
            { header: '记录序号', key: 'historyNo', width: 12 },
            ...historyColumns.map(column => ({ header: column.label, key: column.key, width: column.key === 'opinion' || column.key === 'step' ? 48 : /At$/.test(column.key) ? 24 : 22 })),
          ];
          for (const record of handlingCases) {
            for (const [index, item] of readHandlingRecords(record.data.handlingRecords, systemId).entries()) {
              const businessFields = shenzhen ? {
                caseNumber: cellValue(record.data.caseNumber ?? record.data.applicationNumber ?? record.data.processNumber),
                applicationNumber: cellValue(record.data.applicationNumber), processNumber: cellValue(record.data.processNumber),
                sourceMatterName: cellValue(record.data.sourceMatterName), subjectName: cellValue(record.data.subjectName),
                historyStatus: record.data.handlingRecordStatus === 'failed' ? '待补齐（保留上次记录）' : hrssHandlingStatusLabel(record.data.handlingRecordStatus),
              } : { applyBh: cellValue(record.data.applyBh), unitName: cellValue(record.data.unitName), applyDate: cellValue(record.data.applyDate) };
              history.addRow({ ...businessFields, historyNo: index + 1,
                ...Object.fromEntries(historyColumns.map(({ key }) => [key, key === 'withdrawn' ? item[key] ? '是' : '否' : cellValue(item[key])])) });
            }
          }
          history.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
          history.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF007AFF' } };
          history.views = [{ state: 'frozen', ySplit: 1 }];
          history.autoFilter = { from: { row: 1, column: 1 }, to: { row: history.rowCount, column: history.columnCount } };
          history.getColumn('opinion').alignment = { vertical: 'top', wrapText: true };
        }
        await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer()), { flag: 'wx' });
      } else if (format === 'csv') {
        const lines = [columns.map(column => csvCell(column.label)).join(','), ...values.map(row => columns.map(column => csvCell(row[column.key])).join(','))];
        await writeFile(path, `\uFEFF${lines.join('\r\n')}`, { encoding: 'utf8', flag: 'wx' });
      } else await writeFile(path, JSON.stringify(shenzhen
        ? values.map((row, index) => ({ ...row, handlingRecords: readHandlingRecords(records[index].data.handlingRecords, systemId) })) : values, null, 2), { encoding: 'utf8', flag: 'wx' });
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
