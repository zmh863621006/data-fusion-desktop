import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { load } from 'cheerio';
import { LocalExportService } from './local-export-service';
import { validateProvincialPermit, PROVINCIAL_PERMIT_SHEET, PROVINCIAL_PERMIT_COLUMNS } from '../double-publicity/provincial-permit';
import template from '../double-publicity/provincial-template.json';
import type { StoredRecord } from '../storage/types';
import { PERMIT_SHEET_NAME } from '../double-publicity/permit-workbook';
import { NANSHAN_PERMIT_SHEET } from '../double-publicity/nanshan-permit';
import { FOOD_DRUG_SYSTEM_ID } from '../../plugins/guangdong-food-drug/catalog';

const complete = { xkXdrMc: '示例企业', xkXdrLb: '法人及非法人组织', xkXdrShxym: '001234567890123456', xkFrdb: '示例法人',
  ajmc: '示例企业申请排水许可案件', xkXkws: '行政许可决定书', xkWsh: '00123', xkXkzs: '排水许可证', xkXkbh: '00045',
  xkJdrq: '2026-11-02 00:00:00', xkXklb: '普通', xkCljg: '予以许可', xkNr: '示例许可内容\n第二行',
  xkYxqz: '2026-11-02', xkYxqzi: '2027-11-01', xkZqly: '依职权', xkXkjg: '深圳市南山区水务局', bz: '备注',
};
const record = (data: Record<string, unknown> = complete, systemId = 'government-info'): StoredRecord => ({ systemId,
  matterId: 'drainage-permit-new', recordKey: 'sample', data, firstSeenAt: 1, updatedAt: 1 });
const dirs: string[] = [];
async function destination() { const dir = await mkdtemp(join(tmpdir(), 'province-permit-')); dirs.push(dir); return join(dir, '导出.xlsx'); }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const read = async (path: string) => new ExcelJS.Workbook().xlsx.readFile(path, { ignoreNodes: ['dataValidations'] });
const text = (value: any): string => value?.richText?.map((run: any) => run.text).join('') ?? String(value ?? '');

describe('provincial permit template export', () => {
  it('preserves the supplied four-row 24-column headers, merges, prompts, dropdowns and frozen rows; fills row five', async () => {
    const sourceBytes = Buffer.from(template.base64, 'base64');
    expect(createHash('sha256').update(sourceBytes).digest('hex')).toBe(template.sha256);
    const sourceZip = await JSZip.loadAsync(sourceBytes);
    const sourceXml = await sourceZip.file('xl/worksheets/sheet1.xml')!.async('string');
    const sourceLoad = load(sourceXml, { xml: true });
    sourceZip.file('xl/worksheets/sheet1.xml', sourceXml.replace(/<dataValidations\b[\s\S]*?<\/dataValidations>/, '').replace(/<col\b(?=[^>]*\bmin="25")[^>]*\/>/g, ''));
    const sourceBook = new ExcelJS.Workbook(); await sourceBook.xlsx.load(await sourceZip.generateAsync({ type: 'arraybuffer' }));
    const path = await destination();
    expect(await new LocalExportService().export(path, 'xlsx', [record()], undefined, undefined, 'guangdong-law')).toMatchObject({ warningCount: 0, rowCount: 1 });
    const book = await read(path), sheet = book.getWorksheet(PROVINCIAL_PERMIT_SHEET)!;
    const original = sourceBook.getWorksheet(PROVINCIAL_PERMIT_SHEET)!;
    expect(book.worksheets).toHaveLength(1); expect(sheet.columnCount).toBe(24); expect(sheet.rowCount).toBe(5);
    for (let row = 1; row <= 4; row++) for (let col = 1; col <= 24; col++) {
      expect(text(sheet.getRow(row).getCell(col).value)).toBe(text(original.getRow(row).getCell(col).value));
      expect(sheet.getRow(row).getCell(col).font).toEqual(original.getRow(row).getCell(col).font);
    }
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 4 });
    expect(sheet.getCell('A5').value).toBe(1); expect(sheet.getCell('D5').value).toBe(complete.xkXdrShxym);
    expect(sheet.getCell('J5').value).toBe(complete.ajmc); expect(sheet.getCell('L5').value).toBe('00123');
    expect(sheet.getCell('M5').value).toBe(complete.xkXkzs); expect(sheet.getCell('N5').value).toBe('00045');
    expect(sheet.getCell('O5').value).toEqual(new Date('2026-11-02T00:00:00Z')); expect(sheet.getCell('O5').numFmt).toBe('yyyy/mm/dd');
    expect(sheet.getCell('Q5').value).toBe('予以许可'); expect(sheet.getCell('R5').value).toBe(complete.xkNr);
    expect(sheet.getCell('U5').value).toBe('依职权'); expect(sheet.getCell('V5').value).toBe(complete.xkXkjg);
    expect(sheet.getCell('W5').value).toBe('备注'); expect(sheet.getCell('X5').value).toBeNull();
    const zip = await JSZip.loadAsync(await readFile(path)); const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(xml.match(/<dataValidations\b[\s\S]*?<\/dataValidations>/)?.[0]).toBe(sourceXml.match(/<dataValidations\b[\s\S]*?<\/dataValidations>/)?.[0]);
    const $ = load(xml, { xml: true });
    expect($('mergeCell').map((_, el) => $(el).attr('ref')).toArray().sort()).toEqual(sourceLoad('mergeCell').map((_, el) => sourceLoad(el).attr('ref')).toArray().sort());
    expect($('dimension').attr('ref')).toBe('A1:X5');
  });
  it('checks provincial fields, keeps missing values blank, marks all 24 cells, and adds notes at the actual data row', async () => {
    const input = record({ ...complete, ajmc: '', xkXkzs: '', xkCljg: '', xkZqly: '', certificateIssuedDate: '2026-09-01', processResult: '正常受理' });
    const path = await destination(), confirm = vi.fn(async () => true);
    expect(await new LocalExportService().export(path, 'xlsx', [input], confirm, undefined, 'guangdong-law')).toMatchObject({ warningCount: 1, missingRequiredCount: 1 });
    const sheet = (await read(path)).getWorksheet(PROVINCIAL_PERMIT_SHEET)!;
    for (let column = 1; column <= 24; column++) expect(sheet.getRow(5).getCell(column).fill).toMatchObject({ fgColor: { argb: 'FFFFCCCC' } });
    for (const address of ['J5','M5','Q5','U5']) expect(sheet.getCell(address).value).toBeNull();
    expect(JSON.stringify(sheet.getCell('J5').note)).toContain('案件名称');
    expect(JSON.stringify(sheet.getCell('Q5').note)).toContain('缺少省执法');
    expect(confirm).toHaveBeenCalledOnce();
  });
  it('uses natural-person columns and the exact ID dictionary, never treats a decision name as an attachment', async () => {
    const data = { ...complete, xkXdrLb: '自然人', xkXdrShxym: '', xkFrdb: '', xkXdrZjlx: '身份证', xkXdrZjhm: '001234567890123456', decisionAttachmentName: 'fake.pdf' };
    const input = record(data), path = await destination();
    expect(validateProvincialPermit([input]).invalid).toBe(0);
    await new LocalExportService().export(path, 'xlsx', [input], undefined, undefined, 'guangdong-law');
    const sheet = (await read(path)).getWorksheet(PROVINCIAL_PERMIT_SHEET)!;
    expect(sheet.getCell('E5').value).toBeNull(); expect(sheet.getCell('H5').value).toBe('居民身份证');
    expect(sheet.getCell('I5').value).toBe(data.xkXdrZjhm); expect(sheet.getCell('X5').value).toBeNull();
  });
  it('cancellation creates no file, repeated saves do not overwrite, and alternate systems/formats are rejected', async () => {
    const path = await destination(), service = new LocalExportService();
    expect(await service.export(path, 'xlsx', [record({})], async () => false, undefined, 'guangdong-law')).toBeNull();
    expect(await readdir(dirs.at(-1)!)).toEqual([]);
    await service.export(path, 'xlsx', [record()], undefined, undefined, 'guangdong-law');
    await expect(service.export(path, 'xlsx', [record()], undefined, undefined, 'guangdong-law')).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(service.export(path, 'xlsx', [record(complete,'transport-practitioner')], undefined, undefined, 'guangdong-law')).rejects.toThrow('仅支持政务');
    await expect(service.export(path, 'json', [record()], undefined, undefined, 'nanshan')).rejects.toThrow('仅支持政务');
  });
  it('routes Nanshan to its separate 31-column template and preserves source records', async () => {
    const data = Object.freeze({ ...complete }), input = record(data), path = await destination();
    await new LocalExportService().export(path, 'xlsx', [input], undefined, undefined, 'nanshan');
    const sheet = (await read(path)).getWorksheet(NANSHAN_PERMIT_SHEET)!;
    expect(sheet.columnCount).toBe(31); expect(sheet.getCell('A2').value).toBe(complete.xkXdrMc);
    expect(data).toEqual(complete); expect(PROVINCIAL_PERMIT_COLUMNS).toHaveLength(24);
    expect(validateProvincialPermit([record({ ...complete, xkJdrq: '2026-02-30', xkCljg: '正常受理' })]).issues[0].fields.map(f => f.key)).toEqual(expect.arrayContaining(['xkJdrq','xkCljg']));
  });
  it('exports both food and drug matters with the original document numbers and authority, and marks missing fields', async () => {
    const authority = '惠州市市场监督管理局';
    const source = '惠州市惠城区市场监督管理局';
    const food = { ...record({ ...complete, xkXkzs: '食品生产许可证', xkXkjg: authority,
      xkXkjgdm: '11441300MB2C90987A', xkLydw: source, xkLydwdm: '11441302351971239H', xkZt: '1' }, FOOD_DRUG_SYSTEM_ID),
    matterId: 'food-production-license' };
    const medical = { ...food, matterId: 'class-iii-medical-device-operation-license', recordKey: 'medical',
      data: { ...food.data, xkXkzs: '医疗器械经营许可证（第三类）', xkWsh: '00567', xkXkbh: '00890', xkZqly: '', xkFrdb: '' } };
    const service = new LocalExportService();
    for (const [target, sheetName, firstRow, documentColumn, numberColumn, authorityColumn] of [
      ['nanshan', NANSHAN_PERMIT_SHEET, 2, 'O', 'R', 'AA'],
      ['guangdong-law', PROVINCIAL_PERMIT_SHEET, 5, 'L', 'N', 'V'],
    ] as const) {
      const path = await destination();
      const result = await service.export(path, 'xlsx', [food, medical], undefined, undefined, target);
      expect(result).toMatchObject({ rowCount: 2, warningCount: 1, missingRequiredCount: 1 });
      const sheet = (await read(path)).getWorksheet(sheetName)!;
      expect(sheet.getCell(`${documentColumn}${firstRow}`).value).toBe('00123');
      expect(sheet.getCell(`${documentColumn}${firstRow + 1}`).value).toBe('00567');
      expect(sheet.getCell(`${numberColumn}${firstRow + 1}`).value).toBe('00890');
      expect(sheet.getCell(`${authorityColumn}${firstRow + 1}`).value).toBe(authority);
      expect(sheet.getCell(`A${firstRow + 1}`).fill).toMatchObject({ fgColor: { argb: 'FFFFCCCC' } });
      if (target === 'nanshan') expect(sheet.getCell('AC2').value).toBe(source);
    }
  });
  it('confirms authority only for water matters and leaves unknown or incorrectly inherited water authorities blank elsewhere', async () => {
    const water = record({ ...complete, xkXkjg: '' });
    const other = { ...record({ ...complete, xkXkjg: '' }), matterId: 'teacher-qualification' };
    const wrong = { ...other, data: { ...complete } };
    const known = { ...other, data: { ...complete, xkXkjg: '原数据明确的许可机关' } };
    const path = await destination();
    await new LocalExportService().export(path, 'xlsx', [water, other, wrong, known], undefined, undefined, 'guangdong-law');
    const sheet = (await read(path)).getWorksheet(PROVINCIAL_PERMIT_SHEET)!;
    expect(sheet.getCell('V5').value).toBe('深圳市南山区水务局');
    expect(sheet.getCell('V6').value).toBeNull(); expect(sheet.getCell('V7').value).toBeNull();
    expect(sheet.getCell('V8').value).toBe('原数据明确的许可机关');
    expect(JSON.stringify(sheet.getCell('V6').note)).toContain('委托单位');
    expect(water.data.xkXkjg).toBe('');
  });
});
