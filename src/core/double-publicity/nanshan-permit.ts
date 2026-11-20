import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import descriptor from './nanshan-template.json';
import governmentMatters from '../../plugins/government-info/matter-catalog.json';
import { HAZCHEM_MATTERS, HAZCHEM_SYSTEM_ID } from '../../plugins/shenzhen-hazardous-chemicals/catalog';
import type { StoredRecord } from '../storage/types';
import { exportFieldValue, validateExport, type ExportFieldIssue, type ExportValidation } from './validation';

export const NANSHAN_PERMIT_SHEET = 'Sheet1';
export const NANSHAN_RULE_SHEET = '行政许可字段标准及校验规则';
export const NANSHAN_FIRST_DATA_ROW = 2;
// Order is the original teacher exportSGSData(type=2), also used by nsSgsExport.
// There is no sequence column, permit-project column or matter-code column.
export const NANSHAN_PERMIT_COLUMNS = [
  ['xkXdrMc','行政相对人名称'], ['xkXdrLb','行政相对人类别'],
  ['xkXdrShxym','行政相对人代码_1(统一社会信用代码)'], ['xkXdrGszc','行政相对人代码_2（工商注册号）'],
  ['xkXdrZzjg','行政相对人代码_3(组织机构代码)'], ['xkXdrSwdj','行政相对人代码_4（税务登记号）'],
  ['xkXdrSydw','行政相对人代码_5（事业单位证书号）'], ['xkXdrShzz','行政相对人代码_6（社会组织登记证号）'],
  ['xkFrdb','法定代表人'], ['xkFrZjlx','法定代表人证件类型'], ['xkFrZjhm','法定代表人证件号码'],
  ['xkXdrZjlx','证件类型'], ['xkXdrZjhm','证件号码'], ['xkXkws','行政许可决定文书名称'],
  ['xkWsh','行政许可决定文书号'], ['xkXklb','许可类别'], ['xkXkzs','许可证书名称'], ['xkXkbh','许可编号'],
  ['xkNr','许可内容'], ['xkJdrq','许可决定日期'], ['xkYxqz','有效期自'], ['xkYxqzi','有效期至'],
  ['xkZt','当前状态'], ['ajmc','案件名称'], ['xkZqly','职权来源'], ['xkCljg','处理结果'],
  ['xkXkjg','许可机关'], ['xkXkjgdm','许可机关统一社会信用代码'],
  ['xkLydw','数据来源单位'], ['xkLydwdm','数据来源单位统一社会信用代码'], ['bz','备注'],
] as const;
const WATER_NAME = '深圳市南山区水务局', WATER_CODE = '11440305MB2D27962K';
const waterMatters = new Set(governmentMatters.filter(matter => matter.departmentId === 'water-affairs').map(matter => matter.id));
const hazardousPermitMatters = new Set(HAZCHEM_MATTERS.filter(matter => matter.departmentId === 'hazardous-chemicals').map(matter => matter.id));
const authorities: Record<string, string> = { xkXkjg: WATER_NAME, xkXkjgdm: WATER_CODE, xkLydw: WATER_NAME, xkLydwdm: WATER_CODE };
const dateKeys = new Set(['xkJdrq','xkYxqz','xkYxqzi']);
const labels = new Map<string,string>(NANSHAN_PERMIT_COLUMNS);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';

/** Projection only: never change the stored record or copy the teacher's education bureau. */
export function nanshanValue(record: StoredRecord, key: string): string {
  if (record.systemId === HAZCHEM_SYSTEM_ID) {
    if (key === 'xkFrZjlx' || key === 'xkFrZjhm') return '';
    if (hazardousPermitMatters.has(record.matterId)) {
      if (key === 'xkXkws') return '危险化学品经营许可证';
      if (key === 'xkWsh') return text(exportFieldValue(record, 'xkXkbh'));
    }
  }
  let value = text(exportFieldValue(record, key));
  if (Object.hasOwn(authorities, key) && record.systemId === 'government-info') {
    if (waterMatters.has(record.matterId)) return authorities[key];
    // A non-water record must not retain an incorrectly inherited water authority.
    return value === WATER_NAME || value === WATER_CODE ? '' : value;
  }
  // The rule worksheet explicitly defines this sentinel as "长期".
  if (key === 'xkYxqzi' && value === '长期') return '2099/12/31';
  if (['xkFrZjlx','xkXdrZjlx'].includes(key) && value === '居民身份证') value = '身份证';
  return value;
}

function dateValue(value: string): Date | undefined {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/.exec(value);
  if (!match) return undefined;
  const [, y, m, d] = match, result = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return result.getUTCFullYear() === Number(y) && result.getUTCMonth() === Number(m) - 1 && result.getUTCDate() === Number(d) ? result : undefined;
}

export function validateNanshanPermit(records: StoredRecord[]): ExportValidation {
  const issues: ExportValidation['issues'] = []; let missingRows = 0;
  records.forEach((record,index) => {
    const values = Object.fromEntries(NANSHAN_PERMIT_COLUMNS.map(([key]) => [key,nanshanValue(record,key)]));
    // Retain provenance for the existing construction-waste subject checks.
    const existing = validateExport([{ ...record, data: { ...record.data, ...values } }]);
    const fields: ExportFieldIssue[] = (existing.issues[0]?.fields ?? []).map(field => ({ ...field, label: labels.get(field.key) ?? field.label }));
    let missing = existing.missingRows > 0;
    const add = (key: string, message: string) => fields.push({ key, label: labels.get(key) ?? key, sourceKeys: [key], message });
    for (const key of ['ajmc','xkZqly','xkCljg']) if (!values[key]) { add(key,'缺少南山模板必填字段'); missing = true; }
    const choices = { xkZqly: ['依职权','依授权','依委托'], xkCljg: ['不予受理','予以许可','不予许可','撤销许可'], xkZt: ['1','2'] };
    for (const [key, allowed] of Object.entries(choices)) if (values[key] && !allowed.includes(values[key])) add(key,`应选择：${allowed.join('、')}`);
    const dates = new Map<string,Date>();
    for (const key of dateKeys) if (values[key]) {
      const date = dateValue(values[key]);
      if (!date || date < new Date('1949-10-01T00:00:00Z') || date > new Date('2099-12-31T00:00:00Z')) {
        add(key,'请填写1949/10/01至2099/12/31范围内的有效日期，格式为yyyy/mm/dd');
      } else dates.set(key,date);
    }
    const decision = dates.get('xkJdrq'), start = dates.get('xkYxqz'), end = dates.get('xkYxqzi');
    if (decision && start && start < decision) add('xkYxqz','有效期自不能早于许可决定日期');
    if (start && end && end <= start) add('xkYxqzi','有效期至须晚于有效期自');
    if (fields.length) issues.push({ rowNumber: index+1, recordKey: record.recordKey, subject: values.xkXdrMc, fields });
    if (missing) missingRows++;
  });
  return { total: records.length, checked: records.length, invalid: issues.length, missingRows, issues };
}

export async function createNanshanPermitWorkbook(records: StoredRecord[], validation: ExportValidation): Promise<Buffer> {
  const template = await JSZip.loadAsync(Buffer.from(descriptor.base64,'base64'));
  // The rule sheet has a styled blank tail through XFD. Avoid materializing
  // 16,384 empty columns; its actual A1:F35 values and formatting are retained.
  const rules = await template.file('xl/worksheets/sheet2.xml')!.async('string');
  template.file('xl/worksheets/sheet2.xml',rules.replace(/<col\b(?=[^>]*\bmin="7")[^>]*\/>/g,''));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await template.generateAsync({ type:'arraybuffer' }));
  workbook.creator = '数据融合助手';
  const sheet = workbook.getWorksheet(NANSHAN_PERMIT_SHEET)!;
  NANSHAN_PERMIT_COLUMNS.forEach(([key],index) => { if (dateKeys.has(key)) sheet.getColumn(index+1).width = 14; });
  const byRow = new Map(validation.issues.map(issue => [issue.rowNumber,issue]));
  records.forEach((record,index) => {
    const row = sheet.getRow(index+NANSHAN_FIRST_DATA_ROW); let lines = 1;
    NANSHAN_PERMIT_COLUMNS.forEach(([key],column) => {
      const cell = row.getCell(column+1), value = nanshanValue(record,key);
      cell.font = { name:'宋体', size:11 }; cell.alignment = { vertical:'middle', wrapText:true };
      cell.border = { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} };
      cell.numFmt = '@';
      const date = dateKeys.has(key) ? dateValue(value) : undefined;
      if (date) { cell.value = date; cell.numFmt = 'yyyy/mm/dd'; }
      else cell.value = value || null;
      const width = Math.max(4,(sheet.getColumn(column+1).width ?? sheet.properties.defaultColWidth ?? 9.5)-1);
      const display = date ? value.slice(0,10) : value;
      lines = Math.max(lines,display.split('\n').reduce((sum,line) => sum+Math.max(1,Math.ceil([...line].reduce((units,char) => units+(char.charCodeAt(0)>255?2:1),0)/width)),0));
    });
    row.height = Math.min(409.5,Math.max(30,lines*15+6));
    const issue = byRow.get(index+1);
    if (issue) {
      for (let column=1;column<=31;column++) {
        const cell = row.getCell(column); cell.fill = { type:'pattern',pattern:'solid',fgColor:{argb:'FFFFCCCC'} };
        cell.font = { ...cell.font,color:{argb:'FF9C0006'} };
      }
      row.getCell(1).note = `南山导出校验：${issue.fields.map(field => `${field.label}：${field.message}`).join('；')}`;
      for (const field of issue.fields) {
        const column = NANSHAN_PERMIT_COLUMNS.findIndex(([key]) => field.sourceKeys.includes(key));
        if (column>=0) row.getCell(column+1).note = `${field.label}：${field.message}`;
      }
    }
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
