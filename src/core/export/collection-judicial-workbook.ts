import JSZip from 'jszip';
import descriptor from './collection-judicial-template.json';
import { exportFieldValue } from '../double-publicity/validation';
import type { StoredRecord } from '../storage/types';
import { EQUIPMENT_SYSTEM_ID, USE_REGISTRATION } from '../../plugins/guangdong-special-equipment/catalog';

const SHEET = 'xl/worksheets/sheet1.xml';
const FIRST_DATA_ROW = 5;

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function judicialValues(record: StoredRecord, index: number): Record<string, string | number> {
  const field = (key: string) => text(exportFieldValue(record, key) ?? record.data[key]);
  const equipment = record.systemId === EQUIPMENT_SYSTEM_ID;
  const registration = equipment && record.matterId === USE_REGISTRATION.id;
  const sfDocument = registration ? field('provincialDocumentNumber') : field('xkWsh');
  // The original food/drug collector writes the ordinary permit columns and
  // leaves its judicial columns empty. The judicial exporter falls back only for content.
  return {
    A: index + 1,
    B: field('xkXdrMc'), C: field('xkXdrLb'), D: field('xkXdrShxym'), E: field('xkFrdb'),
    H: field('xkXdrZjlx').includes('身份证') ? '居民身份证' : '', I: field('xkXdrZjhm'),
    J: equipment ? field('ajmc') : '', K: field('xkXkws'), L: equipment ? sfDocument : '',
    M: field('xkXkzs'), N: field('xkXkbh'), O: field('xkJdrq'),
    P: field('xkXklb').includes('普通') ? '核准' : '', Q: equipment ? field('xkCljg') : '',
    R: registration ? field('ajmc') || field('xkNr') : field('xkNr'),
    S: field('xkYxqz'), T: field('xkYxqzi'), U: equipment ? field('xkZqly') : '', V: field('xkLydw'),
  };
}

function xmlText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/_x[\da-f]{4}_/gi, '_x005F_$&')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
}

// Write the cleared cells directly to preserve the original workbook's styles
// and whole-column validation rules without expanding those ranges in memory.
function rowCells(row: string): Map<string, string> {
  return new Map(Array.from(row.matchAll(/<c\b([^>]*?)\s*(?:\/>|>\s*<\/c>)/g), match => {
    const reference = /\br="([A-Z]+)\d+"/.exec(match[1]);
    if (!reference) throw new Error('归集司法公示模板单元格格式无效');
    return [reference[1], match[1]];
  }));
}

function fillJudicialRow(attributes: string, cells: Map<string, string>, fallback: Map<string, string>,
  record: StoredRecord, rowNumber: number): string {
  const values = judicialValues(record, rowNumber - FIRST_DATA_ROW);
  const columns = [...new Set([...cells.keys(), ...Object.keys(values)])].sort();
  const content = columns.map(column => {
    const source = cells.get(column) ?? fallback.get(column);
    const reference = 'r="' + column + rowNumber + '"';
    const cell = source ? source.replace(/\br="[A-Z]+\d+"/, reference) : ' ' + reference;
    const value = values[column];
    if (typeof value === 'number') return '<c' + cell + ' t="n"><v>' + value + '</v></c>';
    if (!value) return '<c' + cell + '/>';
    return '<c' + cell + ' t="inlineStr"><is><t xml:space="preserve">' + xmlText(value) + '</t></is></c>';
  }).join('');
  return '<row' + attributes.replace(/\br="\d+"/, 'r="' + rowNumber + '"') + '>' + content + '</row>';
}

/** Mirrors collection-system AdministrativeLicenseController.exportExpert. */
export async function createCollectionJudicialWorkbook(records: readonly StoredRecord[]): Promise<Buffer> {
  // Layout recovered from an original export, with every business value, unused
  // shared string and file metadata cleared before bundling.
  const workbook = await JSZip.loadAsync(Buffer.from(descriptor.base64, 'base64'));
  const sheet = await workbook.file(SHEET)!.async('string');
  const templateRow = /<row\b([^>]*\br="5"[^>]*)>([\s\S]*?)<\/row>/.exec(sheet);
  if (!templateRow) throw new Error('归集司法公示模板缺少数据行');
  const fallback = rowCells(templateRow[2]);
  let lastRow = 0;
  let xml = sheet.replace(/<row\b([^>]*\br="(\d+)"[^>]*)>([\s\S]*?)<\/row>/g, (row, attributes: string, number: string, content: string) => {
    const rowNumber = Number(number);
    lastRow = rowNumber;
    const record = records[rowNumber - FIRST_DATA_ROW];
    return record ? fillJudicialRow(attributes, rowCells(content), fallback, record, rowNumber) : row;
  });
  const requiredRows = records.length + FIRST_DATA_ROW - 1;
  if (requiredRows > lastRow) {
    const extraRows = records.slice(lastRow - FIRST_DATA_ROW + 1)
      .map((record, index) => fillJudicialRow(templateRow[1], fallback, fallback, record, lastRow + index + 1));
    xml = xml.replace('</sheetData>', () => extraRows.join('') + '</sheetData>')
      .replace(/(<dimension ref="A1:X)\d+(")/, (_, start, end) => start + requiredRows + end);
  }
  workbook.file(SHEET, xml);
  return workbook.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
