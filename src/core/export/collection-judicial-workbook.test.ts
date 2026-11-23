import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'cheerio';
import { EQUIPMENT_SYSTEM_ID, PERSONNEL_ASSESSMENT, USE_REGISTRATION } from '../../plugins/guangdong-special-equipment/catalog';
import { FOOD_DRUG_LICENSES, FOOD_DRUG_SYSTEM_ID } from '../../plugins/guangdong-food-drug/catalog';
import type { StoredRecord } from '../storage/types';
import { LocalExportService } from './local-export-service';
import { createCollectionJudicialWorkbook } from './collection-judicial-workbook';
import template from './collection-judicial-template.json';

const sheetPath = 'xl/worksheets/sheet1.xml';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

const record = (systemId: string, matterId: string, data: StoredRecord['data']): StoredRecord =>
  ({ systemId, matterId, recordKey: matterId, firstSeenAt: 1, updatedAt: 1, data });
const license = { xkXdrMc: '测试公司 <A & B>', xkXdrLb: '法人及非法人组织', xkXdrShxym: '001234567890123456',
  xkXkws: '测试许可文书', xkWsh: '0001', xkXkbh: '0045', xkXklb: '普通', xkNr: '测试经营许可',
  xkJdrq: '2026-11-23', xkYxqz: '2026-11-24', xkYxqzi: '2030-11-23', xkXkjg: '许可机关', xkLydw: '归集来源单位' };
const read = async (file: string) => (await new ExcelJS.Workbook().xlsx.readFile(file, { ignoreNodes: ['dataValidations'] })).worksheets[0];

async function destination() {
  const directory = await mkdtemp(join(tmpdir(), 'collection-judicial-'));
  directories.push(directory);
  return directory;
}

it('exports the recovered Judicial workbook with all original header and validation elements and equipment values', async () => {
  const registration = record(EQUIPMENT_SYSTEM_ID, USE_REGISTRATION.id, { ...license, xkXklb: '登记',
    ajmc: '测试公司的设备登记案件', xkCljg: '予以许可', xkZqly: '依职权', provincialDocumentNumber: '决001' });
  const personnel = record(EQUIPMENT_SYSTEM_ID, PERSONNEL_ASSESSMENT.id, { ...license, xkXdrLb: '自然人', xkXdrShxym: '',
    xkXdrZjlx: '身份证', xkXdrZjhm: '012345678901234567', ajmc: '特种设备作业人员考核', xkWsh: '决002' });
  const file = join(await destination(), '司法公示.xlsx');
  const service = new LocalExportService();
  expect(await service.export(file, 'xlsx', [registration, personnel], undefined, undefined, 'collection-judicial'))
    .toMatchObject({ rowCount: 2, warningCount: 0 });
  const sheet = await read(file);
  expect(sheet.name).toBe('行政许可案件导入模板');
  expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 4, topLeftCell: 'A5', zoomScale: 130 });
  expect(sheet.getCell('A5').value).toBe(1);
  expect(sheet.getCell('B5').value).toBe(license.xkXdrMc);
  expect(sheet.getCell('D5').value).toBe(license.xkXdrShxym);
  expect(sheet.getCell('J5').value).toBe(registration.data.ajmc);
  expect(sheet.getCell('L5').value).toBe('决001');
  expect(sheet.getCell('N5').value).toBe('0045');
  expect(sheet.getCell('O5').value).toBe('2026-11-23');
  expect(sheet.getCell('P5').value).toBeNull();
  expect(sheet.getCell('Q5').value).toBe('予以许可');
  expect(sheet.getCell('R5').value).toBe(registration.data.ajmc);
  expect(sheet.getCell('U5').value).toBe('依职权');
  expect(sheet.getCell('V5').value).toBe('归集来源单位');
  expect(sheet.getCell('H6').value).toBe('居民身份证');
  expect(sheet.getCell('I6').value).toBe('012345678901234567');
  expect(sheet.getCell('L6').value).toBe('决002');
  expect(sheet.getCell('P6').value).toBe('核准');
  expect(sheet.getCell('R6').value).toBe(license.xkNr);
  const blankZip = await JSZip.loadAsync(Buffer.from(template.base64, 'base64'));
  const zip = await JSZip.loadAsync(await readFile(file));
  const blankXml = await blankZip.file(sheetPath)!.async('string');
  const xml = await zip.file(sheetPath)!.async('string');
  const header = (value: string) => value.slice(0, value.indexOf('<row r="5"'));
  expect(header(xml)).toBe(header(blankXml));
  for (const node of ['mergeCells', 'dataValidations', 'sheetViews', 'cols']) {
    const pattern = new RegExp('<' + node + '\\b[\\s\\S]*?</' + node + '>');
    expect(xml.match(pattern)?.[0]).toBe(blankXml.match(pattern)?.[0]);
  }
  const blank = load(blankXml, { xml: true });
  expect(blank('mergeCell')).toHaveLength(28);
  expect(blank('dataValidation')).toHaveLength(20);
  expect(blank('row').slice(4).find('v, is, f')).toHaveLength(0);
  const shared = load(await blankZip.file('xl/sharedStrings.xml')!.async('string'), { xml: true });
  expect(shared('si')).toHaveLength(28);
  expect(Object.keys(blankZip.files).some(path => path.startsWith('docProps/'))).toBe(false);
});

it('uses collection rules for both food/drug matters without turning empty judicial fields into anomalies', async () => {
  const records = FOOD_DRUG_LICENSES.map(matter => record(FOOD_DRUG_SYSTEM_ID, matter.id, {
    ...license, xkXkzs: matter.name, ajmc: '历史批次自动生成值', xkCljg: '予以许可',
  }));
  const directory = await destination(), service = new LocalExportService(), confirm = vi.fn(async () => false);
  const judicialPath = join(directory, '司法公示.xlsx');
  expect(await service.export(judicialPath, 'xlsx', records, confirm, undefined, 'collection-judicial'))
    .toMatchObject({ rowCount: 2, warningCount: 0, missingRequiredCount: 0 });
  expect(confirm).not.toHaveBeenCalled();
  const judicial = await read(judicialPath);
  expect(judicial.getCell('M6').value).toBe(FOOD_DRUG_LICENSES[1].name);
  expect(judicial.getCell('P6').value).toBe('核准');
  expect(judicial.getCell('R6').value).toBe(license.xkNr);
  for (const column of ['J', 'L', 'Q', 'U']) {
    expect(judicial.getCell(column + '5').value).toBeNull();
    expect(judicial.getCell(column + '5').note).toBeUndefined();
  }
  await expect(service.export(join(directory, '错误模板.xlsx'), 'xlsx', records, undefined, undefined, 'nanshan'))
    .rejects.toThrow('仅支持政务');
  await expect(service.export(join(directory, '错误模板.xlsx'), 'xlsx', [record('government-info', 'example', {})],
    undefined, undefined, 'collection-disclosure')).rejects.toThrow('仅支持特种设备');
});

it('extends the original 584 preformatted data rows for a larger collection export', async () => {
  const input = record(FOOD_DRUG_SYSTEM_ID, FOOD_DRUG_LICENSES[0].id, license);
  const output = await JSZip.loadAsync(await createCollectionJudicialWorkbook(Array(585).fill(input)));
  const $ = load(await output.file(sheetPath)!.async('string'), { xml: true });
  expect($('dimension').attr('ref')).toBe('A1:X589');
  expect($('row[r="589"] c[r="A589"] v').text()).toBe('585');
  expect($('row[r="589"] c[r="B589"] t').text()).toBe(license.xkXdrMc);
  expect($('row[r="589"] c[r="B589"]').attr('s')).toBe($('row[r="5"] c[r="B5"]').attr('s'));
});
