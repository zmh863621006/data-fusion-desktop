import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { HousingImportIssue } from './types';
import { normalizeHousingCode } from './code';

export const MAX_HOUSING_CODES = 5000;
export interface ParsedHousingWorkbook {
  codes: Array<{ rowNumber: number; code: string }>;
  issues: HousingImportIssue[]; totalRows: number; duplicateCount: number;
}
const header = (value: string) => value.replace(/[\s（）()]/g, '').trim();
function text(cell: ExcelJS.Cell): string | null {
  const value = cell.value;
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && 'richText' in value) return value.richText.map(item => item.text).join('').trim();
  if (value && typeof value === 'object' && 'hyperlink' in value && typeof value.text === 'string') return value.text.trim();
  return null;
}

export async function parseHousingWorkbook(bytes: Buffer): Promise<ParsedHousingWorkbook> {
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('请选择不超过10MB的Excel工作簿（.xlsx）');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new Error('文件不是有效的.xlsx工作簿，请另存为Excel工作簿后重试'); }
  const entries = Object.values(zip.files);
  const sizes = entries.map(entry => (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
  if (entries.length > 1000 || sizes.some(size => size > 32 * 1024 * 1024) || sizes.reduce((sum, size) => sum + size, 0) > 64 * 1024 * 1024) {
    throw new Error('工作簿内容过大，请只保留本次需要绑定的房屋编码');
  }
  if (!zip.file('xl/workbook.xml')) throw new Error('文件不是有效的.xlsx工作簿');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(new Uint8Array(bytes).buffer); } catch { throw new Error('无法读取工作簿，请确认文件未加密且保存完整'); }
  const candidates: Array<{ sheet: ExcelJS.Worksheet; row: number; column: number }> = [];
  for (const sheet of workbook.worksheets.filter(value => value.state === 'visible')) {
    for (let row = 1; row <= Math.min(sheet.rowCount, 20); row++) {
      sheet.getRow(row).eachCell((cell, column) => {
        const value = header(text(cell) ?? '');
        if (value === '房屋编码' || /^房屋编码\d+位$/.test(value)) candidates.push({ sheet, row, column });
      });
    }
  }
  if (candidates.length !== 1) throw new Error(candidates.length ? '发现多个房屋编码列，请使用单一清单或下载模板' : '前20行未找到“房屋编码”列，请使用导入模板');
  const { sheet, row: start, column } = candidates[0];
  if (sheet.rowCount - start > MAX_HOUSING_CODES + 100) throw new Error(`每次最多导入${MAX_HOUSING_CODES}行，请拆分工作簿`);
  const codes: ParsedHousingWorkbook['codes'] = [], issues: HousingImportIssue[] = [], seen = new Set<string>();
  let totalRows = 0, duplicateCount = 0;
  for (let rowNumber = start + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const cell = sheet.getCell(rowNumber, column);
    if (cell.value === null || cell.value === undefined || text(cell) === '') continue;
    totalRows++;
    if (totalRows > MAX_HOUSING_CODES) throw new Error(`每次最多导入${MAX_HOUSING_CODES}行`);
    const code = text(cell);
    if (typeof cell.value === 'number') { issues.push({ rowNumber, message: '房屋编码被保存为数字，可能已丢失精度；请从原始资料重新粘贴为文本' }); continue; }
    if (code === null) { issues.push({ rowNumber, message: '房屋编码须为文本，不能使用公式或其他单元格类型' }); continue; }
    try { normalizeHousingCode(code); }
    catch { issues.push({ rowNumber, message: '请填写完整房屋编码，不能含空格或不支持的符号' }); continue; }
    if (seen.has(code)) { duplicateCount++; continue; }
    seen.add(code); codes.push({ rowNumber, code });
  }
  if (!totalRows) throw new Error('工作簿没有房屋编码，请填写后重新上传');
  return { codes, issues, totalRows, duplicateCount };
}

export async function createHousingTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('房屋编码');
  sheet.columns = [{ header: '房屋编码', key: 'code', width: 36, style: { numFmt: '@' } }, { header: '填写说明', key: 'note', width: 72 }];
  sheet.getRow(1).font = { bold: true };
  sheet.getCell('B2').value = '在A列逐行填写完整房屋编码，不限固定位数；保留文本格式和前导零，本列不参与导入。';
  sheet.getCell('A2').numFmt = '@';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
