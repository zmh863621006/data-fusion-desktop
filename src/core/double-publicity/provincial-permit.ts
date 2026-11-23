import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import descriptor from './provincial-template.json';
import type { StoredRecord } from '../storage/types';
import { exportFieldValue, type ExportValidation, type ExportFieldIssue } from './validation';
import governmentMatters from '../../plugins/government-info/matter-catalog.json';

export const PROVINCIAL_PERMIT_SHEET = '行政许可案件导入模板';
export const PROVINCIAL_FIRST_DATA_ROW = 5;
export const PROVINCIAL_PERMIT_COLUMNS = [
  ['orderNo', '序号'], ['xkXdrMc', '行政相对人名称'], ['xkXdrLb', '行政相对人类别'],
  ['xkXdrShxym', '统一社会信用代码'], ['xkFrdb', '法定代表人'], ['xkFrZjlx', '法定代表人证件类型'],
  ['xkFrZjhm', '法定代表人证件号码'], ['xkXdrZjlx', '自然人证件类型'], ['xkXdrZjhm', '自然人证件号码'],
  ['ajmc', '案件名称'], ['xkXkws', '决定书(通知书)名称'], ['xkWsh', '决定书(通知书)文号'],
  ['xkXkzs', '许可证书名称'], ['xkXkbh', '许可编号'], ['xkJdrq', '许可决定日期'],
  ['xkXklb', '许可类别'], ['xkCljg', '处理结果'], ['xkNr', '许可内容'],
  ['xkYxqz', '有效期自'], ['xkYxqzi', '有效期至'], ['xkZqly', '职权来源'],
  ['xkXkjg', '委托单位'], ['bz', '备注'], ['decisionAttachmentName', '决定书'],
] as const;
const DATE_KEYS = new Set(['xkJdrq', 'xkYxqz', 'xkYxqzi']);
const ID_TYPES = ['居民身份证','驾驶证','临时居民身份证','户口簿','居住证','港澳居民往来内地通行证','台湾居民往来大陆通行证','普通护照','外交护照','公务护照','公务普通护照','统一社会信用代码','中国人民解放军军官证','中国人民武装警察部队警官证','士兵证','中国人民解放军士兵证','中国人民解放军警察部队士兵证','中国人民解放军文职人员证','中国武装警察部队文职人员证','旅行证','出生医学证明','其他'];
const CHOICES: Record<string, readonly string[]> = {
  xkXdrLb: ['法人及非法人组织','自然人','个体工商户'], xkFrZjlx: ID_TYPES, xkXdrZjlx: ID_TYPES,
  xkXklb: ['特许','认可','核准','登记','其他','普通'], xkCljg: ['不予受理','予以许可','不予许可','撤销许可'],
  xkZqly: ['依职权','依授权','依委托'],
};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const WATER_AUTHORITY = '深圳市南山区水务局';
const waterMatters = new Set(governmentMatters.filter(matter => matter.departmentId === 'water-affairs').map(matter => matter.id));

export function provincialValue(record: StoredRecord, key: string): string {
  // As in the original gdSgsExport, no attachment names without an attached PDF.
  if (key === 'decisionAttachmentName') return '';
  let value = text(exportFieldValue(record, key));
  if (key === 'xkXkjg' && record.systemId === 'government-info') {
    // Only the water department has been confirmed for this new export. Preserve
    // explicit authorities of other departments; never default them to water.
    if (waterMatters.has(record.matterId)) return WATER_AUTHORITY;
    return value === WATER_AUTHORITY ? '' : value;
  }
  // The neutral detail field is a certificate name, never a decision document number/date.
  if (key === 'xkXkzs' && !value) value = text(record.data.certificateName);
  if (['xkFrZjlx', 'xkXdrZjlx'].includes(key) && value === '身份证') return '居民身份证';
  return value;
}

function dateValue(value: string): Date | undefined {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/.exec(value);
  if (!match) return undefined;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d) ? date : undefined;
}

/** Validate this template independently of Nanshan's different required columns. */
export function validateProvincialPermit(records: StoredRecord[]): ExportValidation {
  const issues: ExportValidation['issues'] = []; let missingRows = 0;
  records.forEach((record, index) => {
    const fields: ExportFieldIssue[] = []; let missing = false;
    const value = (key: string) => provincialValue(record, key);
    const add = (key: string, message: string) => {
      const label = PROVINCIAL_PERMIT_COLUMNS.find(column => column[0] === key)?.[1] ?? key;
      fields.push({ key, label, message, sourceKeys: [key] });
    };
    const require = (key: string) => { if (!value(key)) { add(key, '缺少省执法模板必填字段'); missing = true; } };
    // These columns carry a red asterisk in the supplied workbook.
    // The original gdSgsExport maps its "委托单位" column to xkJg (our xkXkjg).
    ['xkXdrMc','xkXdrLb','ajmc','xkXkzs','xkJdrq','xkXklb','xkCljg','xkNr','xkZqly','xkXkjg'].forEach(require);
    const category = value('xkXdrLb');
    if (['法人及非法人组织','个体工商户'].includes(category)) {
      require('xkXdrShxym'); require('xkFrdb');
      if (value('xkFrZjlx')) require('xkFrZjhm');
      else if (value('xkFrZjhm')) add('xkFrZjlx', '已填写法定代表人证件号码，请补充证件类型');
      for (const key of ['xkXdrZjlx','xkXdrZjhm']) if (value(key)) add(key, '当前主体类别下应留空');
    } else if (category === '自然人') {
      require('xkXdrZjlx'); require('xkXdrZjhm');
      for (const key of ['xkXdrShxym','xkFrdb','xkFrZjlx','xkFrZjhm']) if (value(key)) add(key, '自然人不应填写法人及组织信息');
    }
    for (const [key, choices] of Object.entries(CHOICES)) if (value(key) && !choices.includes(value(key))) add(key, `应选择：${choices.join('、')}`);
    for (const key of DATE_KEYS) if (value(key) && !dateValue(value(key))) add(key, '省模板要求有效日期，格式为 yyyy/mm/dd，请核对原值');
    if (fields.length) issues.push({ rowNumber: index + 1, recordKey: record.recordKey, subject: value('xkXdrMc'), fields });
    if (missing) missingRows++;
  });
  return { total: records.length, checked: records.length, invalid: issues.length, missingRows, issues };
}

export async function createProvincialPermitWorkbook(records: StoredRecord[], validation: ExportValidation): Promise<Buffer> {
  const original = await JSZip.loadAsync(Buffer.from(descriptor.base64, 'base64'));
  const source = await original.file('xl/worksheets/sheet1.xml')!.async('string');
  const rules = source.match(/<dataValidations\b[\s\S]*?<\/dataValidations>/)?.[0];
  // ExcelJS eagerly expands whole-column validation and blank styled columns.
  // Load just the 24 template columns; restore the exact native validation XML below.
  const input = source.replace(/<dataValidations\b[\s\S]*?<\/dataValidations>/, '')
    .replace(/<col\b(?=[^>]*\bmin="25")[^>]*\/>/g, '');
  original.file('xl/worksheets/sheet1.xml', input);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await original.generateAsync({ type: 'arraybuffer' }));
  workbook.creator = '数据融合助手';
  const sheet = workbook.getWorksheet(PROVINCIAL_PERMIT_SHEET)!;
  const issueMap = new Map(validation.issues.map(issue => [issue.rowNumber, issue]));
  records.forEach((record, index) => {
    const row = sheet.getRow(index + PROVINCIAL_FIRST_DATA_ROW);
    let lines = 1;
    PROVINCIAL_PERMIT_COLUMNS.forEach(([key], column) => {
      const cell = row.getCell(column + 1), value = provincialValue(record, key);
      const width = Math.max(4, (sheet.getColumn(column + 1).width ?? 10) - 1);
      const displayed = DATE_KEYS.has(key) && dateValue(value) ? value.slice(0, 10) : value;
      const wrapped = displayed.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].reduce((units, char) => units + (char.charCodeAt(0) > 255 ? 2 : 1), 0) / width)), 0);
      lines = Math.max(lines, wrapped);
      cell.font = { name: '宋体', size: 11 };
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
      cell.numFmt = '@';
      if (key === 'orderNo') { cell.value = index + 1; cell.numFmt = '0'; }
      else if (DATE_KEYS.has(key) && dateValue(value)) { cell.value = dateValue(value)!; cell.numFmt = 'yyyy/mm/dd'; }
      else cell.value = value || null;
    });
    row.height = Math.min(409.5, Math.max(30, lines * 15 + 6));
    const issue = issueMap.get(index + 1);
    if (issue) {
      for (let column = 1; column <= 24; column++) {
        const cell = row.getCell(column);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCCCC' } };
        cell.font = { ...cell.font, color: { argb: 'FF9C0006' } };
      }
      row.getCell(1).note = `省执法导出校验：${issue.fields.map(field => `${field.label}：${field.message}`).join('；')}`;
      for (const field of issue.fields) {
        const column = PROVINCIAL_PERMIT_COLUMNS.findIndex(([key]) => key === field.key);
        if (column >= 0) row.getCell(column + 1).note = `${field.label}：${field.message}`;
      }
    }
  });
  const output = await JSZip.loadAsync(Buffer.from(await workbook.xlsx.writeBuffer()));
  if (rules) {
    let xml = await output.file('xl/worksheets/sheet1.xml')!.async('string');
    // Native worksheet element order: dataValidations precede hyperlinks/printing/legacyDrawing.
    xml = xml.replace(/(?=<(?:hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|drawing|legacyDrawing)\b|<\/worksheet>)/, rules);
    output.file('xl/worksheets/sheet1.xml', xml);
  }
  return output.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
