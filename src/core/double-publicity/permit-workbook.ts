import ExcelJS from 'exceljs';
import descriptor from './permit-template.json';

export const PERMIT_SHEET_NAME = descriptor.name;
export const PERMIT_FIRST_DATA_ROW = 3;

// This descriptor is a mechanical, read-only capture of the supplied BIFF8 file.
// It keeps the original two-row header, rich-text required marks and input prompts,
// without requiring the original E: drive or an XLS parser on a colleague's machine.
export function createPermitWorkbook(): { workbook: ExcelJS.Workbook; sheet: ExcelJS.Worksheet } {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '数据融合助手';
  const sheet = workbook.addWorksheet(PERMIT_SHEET_NAME);
  sheet.properties.defaultRowHeight = descriptor.defaultRowHeight;
  sheet.views = [{ showGridLines: descriptor.showGridLines }];
  descriptor.columns.forEach((column, index) => {
    const target = sheet.getColumn(index + 1);
    target.width = column.width;
    target.hidden = column.hidden;
    target.style = structuredClone(column.style) as unknown as Partial<ExcelJS.Style>;
  });
  descriptor.headerRows.forEach((source, index) => {
    const row = sheet.getRow(index + 1);
    row.height = source.height;
    source.cells.forEach((cell, column) => {
      row.getCell(column + 1).value = structuredClone(cell.value) as ExcelJS.CellValue;
      row.getCell(column + 1).style = structuredClone(cell.style) as unknown as Partial<ExcelJS.Style>;
    });
  });
  descriptor.merges.forEach(range => sheet.mergeCellsWithoutStyle(range));
  // ExcelJS supports whole-range validation without materializing empty rows.
  // Its public typings omit both this API and the supported "any" validation type.
  const validations = (sheet as unknown as {
    dataValidations: { add(range: string, validation: unknown): void };
  }).dataValidations;
  for (const rule of descriptor.validations) {
    for (const range of rule.ranges) validations.add(range, structuredClone(rule.validation));
  }
  return { workbook, sheet };
}

export function fillPermitRow(sheet: ExcelJS.Worksheet, rowNumber: number, values: ExcelJS.CellValue[]): void {
  const row = sheet.getRow(rowNumber);
  row.height = descriptor.dataRow.height;
  descriptor.dataRow.cells.forEach((source, index) => {
    const cell = row.getCell(index + 1);
    cell.style = structuredClone(source.style) as unknown as Partial<ExcelJS.Style>;
    cell.value = values[index] ?? null;
  });
}
