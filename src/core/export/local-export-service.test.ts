import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { load } from 'cheerio';
import { afterEach, describe, expect, it } from 'vitest';
import { DOUBLE_PUBLICITY_TEMPLATE } from '../double-publicity/template';
import descriptor from '../double-publicity/permit-template.json';
import { PERMIT_SHEET_NAME } from '../double-publicity/permit-workbook';
import type { StoredRecord } from '../storage/types';
import { LocalExportService } from './local-export-service';
import { supplementCertificateFields } from '../../plugins/government-info/certificate-fields';
import { enrichDrainagePermit, NEW_DRAINAGE_PERMIT_CONTENT, NEW_DRAINAGE_PERMIT_MATTER } from '../../plugins/government-info/field-rules';
import { toDoublePublicityRecord } from '../../plugins/government-info/enrichment';

const record = (systemId = 'transport-practitioner', data: Record<string, unknown> = {}): StoredRecord => ({
  systemId, matterId: 'test-matter', recordKey: 'record-1', data, firstSeenAt: 1, updatedAt: 1,
});
// Reading complete-column validation with ExcelJS eagerly allocates millions of
// cells; inspect the validation XML separately and keep workbook tests bounded.
const readWorkbook = (path: string) => new ExcelJS.Workbook().xlsx.readFile(path, { ignoreNodes: ['dataValidations'] });
const text = (value: unknown): string => typeof value === 'object' && value && 'richText' in value
  ? (value as { richText: Array<{ text: string }> }).richText.map(run => run.text).join('') : String(value ?? '');

describe('LocalExportService', () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))));
  async function destination(extension = 'xlsx') {
    const directory = await mkdtemp(join(tmpdir(), 'data-fusion-export-'));
    directories.push(directory);
    return join(directory, `行政许可.${extension}`);
  }

  it('exports the enterprise-prefixed approved new-drainage content, including its final line break', async () => {
    const path = await destination();
    const data = toDoublePublicityRecord(enrichDrainagePermit({ cityLsh: 'NEW-1', sxType: '1', sxmc: NEW_DRAINAGE_PERMIT_MATTER },
      { zjbh: '新办许可号', zzsj: '2026-11-03', zjyxqstart: '2026-11-03', zjyxqend: '2027-11-02' }, '测试主体'));
    await new LocalExportService().export(path, 'xlsx', [record('government-info', data)]);
    const sheet = (await readWorkbook(path)).getWorksheet(PERMIT_SHEET_NAME)!;
    expect(sheet.getCell('U3').value).toBe(`测试主体：${NEW_DRAINAGE_PERMIT_CONTENT}`);
    expect(String(sheet.getCell('U3').value)).toMatch(/排放污水。\n特发此证$/);
    expect(sheet.getCell('C3').value).toBe('测试主体');
  });

  it('exports unresolved proxy identity as blank cells with a contractor warning instead of the bureau', async () => {
    const path = await destination();
    const row = record('government-info', { sxmc: '城市建筑垃圾处置（排放）核准', applyer: '深圳市南山区水务局',
      qymc: '深圳市南山区水务局', xkXdrMc: '深圳市南山区水务局', xkXdrLb: '法人及非法人组织',
      xkXdrShxym: '机关代码', xkFrdb: '机关法人' });
    await new LocalExportService().export(path, 'xlsx', [row], async report => {
      expect(report.issues[0].fields.find(field => field.key === 'xkXdrMc')?.message).toContain('施工单位');
      return true;
    });
    const sheet = (await readWorkbook(path)).getWorksheet(PERMIT_SHEET_NAME)!;
    for (const cell of ['C3', 'E3', 'K3']) expect(sheet.getCell(cell).value).toBeNull();
    expect(JSON.stringify(sheet.getCell('C3').note)).toContain('施工单位');
    expect(row.data.applyer).toBe('深圳市南山区水务局');
  });

  it('preserves the supplied two-row header, rich text, widths, styles and all merged areas without extra blank rows', async () => {
    const path = await destination();
    await new LocalExportService().export(path, 'xlsx', [record('health-publicity', { xkXdrMc: '测试机构' })]);
    const workbook = await readWorkbook(path), sheet = workbook.getWorksheet(PERMIT_SHEET_NAME)!;
    expect(workbook.worksheets).toHaveLength(1);
    expect(descriptor.source.sha256).toBe('9f96cf38dced615896c10af264693e219f0431e3e64ddaf05aa38e1b0daf774d');
    expect(sheet.rowCount).toBe(3);
    expect(sheet.columnCount).toBe(32);
    expect(sheet.views[0].showGridLines).toBe(false);
    expect([...sheet.model.merges].sort()).toEqual([...descriptor.merges].sort());
    descriptor.columns.forEach((column, index) => {
      expect(sheet.getColumn(index + 1).width).toBe(column.width);
      expect(sheet.getColumn(index + 1).hidden).toBe(column.hidden);
    });
    descriptor.headerRows.forEach((source, index) => {
      expect(sheet.getRow(index + 1).height).toBe(source.height);
      source.cells.forEach((cell, col) => {
        const actual = sheet.getRow(index + 1).getCell(col + 1);
        // Merged subordinate cells correctly expose their master's text.
        if (actual.isMerged && actual.master.address !== actual.address) return;
        expect(text(actual.value)).toBe(text(cell.value));
        expect(actual.fill).toMatchObject(cell.style.fill);
        expect(actual.font).toMatchObject(Object.fromEntries(Object.entries(cell.style.font).filter(([, value]) => value !== false)));
      });
    });
    expect(sheet.getCell('C1').value).toMatchObject({ richText: [
      { text: '行政相对人名称', font: { name: 'Microsoft YaHei UI', color: { argb: 'FF000000' } } },
      { text: '*', font: { color: { argb: 'FFFF0000' } } },
    ] });
    expect(sheet.getCell('A3').font).toMatchObject({ name: '宋体', size: 12 });
    expect(sheet.getCell('E3').numFmt).toBe('@');
  });

  it('preserves every original validation prompt and segmented dropdown rule, including header prompts', async () => {
    const path = await destination();
    await new LocalExportService().export(path, 'xlsx', [record('government-info')]);
    const zip = await JSZip.loadAsync(await readFile(path));
    const $ = load(await zip.file('xl/worksheets/sheet1.xml')!.async('string'), { xml: true });
    const rules = $('dataValidation').toArray();
    expect(descriptor.validations).toHaveLength(38);
    expect(rules).toHaveLength(descriptor.validations.reduce((count, rule) => count + rule.ranges.length, 0));
    for (const source of descriptor.validations) {
      for (const range of source.ranges) {
        const actual = rules.filter(node => $(node).attr('sqref') === range);
        expect(actual, range).toHaveLength(1);
        const rule = $(actual[0]);
        expect(rule.attr('type') ?? 'any').toBe(source.validation.type);
        expect(rule.attr('promptTitle') ?? '').toBe(source.validation.promptTitle);
        expect(rule.attr('prompt') ?? '').toBe(source.validation.prompt);
        expect(rule.attr('showInputMessage') === '1').toBe(source.validation.showInputMessage);
        expect(rule.attr('showErrorMessage') === '1').toBe(source.validation.showErrorMessage);
        expect(rule.find('formula1').map((_, item) => $(item).text()).toArray()).toEqual(source.validation.formulae);
      }
    }
    const choice = (range: string) => $(rules.find(node => $(node).attr('sqref') === range)).find('formula1').text();
    expect(choice('D3:D15')).toBe('"法人及非法人组织,自然人,个体工商户"');
    expect(choice('D22:D65536')).toBe('"法人,非法人组织,自然人,个体工商户"');
    expect(choice('AA22:AA65536')).toBe('"1,2"');
    expect($('dimension').attr('ref')).toBe('A1:AF3');
  });

  it.each(['health-publicity', 'oversize-transport', 'online-car-permit', 'transport-practitioner', 'government-info'])('exports every canonical field for %s at row three and flags the entire incomplete row', async systemId => {
    const path = await destination();
    const data = Object.fromEntries(DOUBLE_PUBLICITY_TEMPLATE.map(([key], index) => [key, `字段${index + 1}`]));
    const result = await new LocalExportService().export(path, 'xlsx', [record(systemId, data)]);
    expect(result?.warningCount).toBe(1);
    const sheet = (await readWorkbook(path)).getWorksheet(PERMIT_SHEET_NAME)!;
    expect(sheet.getCell('A3').value).toBe(1);
    DOUBLE_PUBLICITY_TEMPLATE.forEach(([key], index) => expect(sheet.getRow(3).getCell(index + 2).value).toBe(data[key]));
    expect(sheet.getCell('A3').fill).toMatchObject({ fgColor: { argb: 'FFFFCCCC' } });
    expect(sheet.getCell('AF3').fill).toMatchObject({ fgColor: { argb: 'FFFFCCCC' } });
    expect(JSON.stringify(sheet.getCell('D3').note)).toContain('应为法人及非法人组织');
    expect(JSON.stringify(sheet.getCell('A3').note)).toContain('行政相对人类别');
    expect(sheet.rowCount).toBe(3);
  });

  it('maps only semantic government aliases and never exports technical columns or substitutes certificate facts', async () => {
    const path = await destination();
    const data = supplementCertificateFields({ cityLsh: 'CITY-1', sxmc: '注销第三类非药品类易制毒化学品经营备案',
      qymc: '测试公司', qylx: '法人及非法人组织', xydm: '91440300TEST000001A', frdb: '测试法人',
      xknr: '原许可内容', xkjdrq: '2026-09-01', yxqs: '2026-09-02', yxqe: '2026-10-01',
    }, { zjmc: '备案证明', zjbh: '00123', zzsj: '2025-01-01', zjyxqstart: '2025-01-02', zjyxqend: '长期' });
    await new LocalExportService().export(path, 'xlsx', [record('government-info', data)]);
    const sheet = (await readWorkbook(path)).getWorksheet(PERMIT_SHEET_NAME)!;
    expect(sheet.columnCount).toBe(32);
    expect(sheet.getCell('C3').value).toBe('测试公司');
    expect(sheet.getCell('D3').value).toBe('法人及非法人组织');
    expect(sheet.getCell('E3').value).toBe('91440300TEST000001A');
    expect(sheet.getCell('K3').value).toBe('测试法人');
    expect(sheet.getCell('U3').value).toBe('原许可内容');
    expect(sheet.getCell('V3').value).toBe('2026-09-01');
    expect(sheet.getCell('W3').value).toBe('2026-09-02');
    expect(sheet.getCell('X3').value).toBe('2026-10-01');
    ['B3','P3','Q3','S3','T3'].forEach(address => expect(sheet.getCell(address).value).toBeNull());
    expect(JSON.stringify(sheet.getCell('A3').note)).toContain('行政许可决定文书号');
    expect(data.certificateNumber).toBe('00123');
    expect(data.certificateEnrichment).toBeDefined();
  });

  it.each(['csv', 'json'] as const)('retains raw government certificate fields and evidence in %s', async format => {
    const path = await destination(format);
    const data = supplementCertificateFields({ cityLsh: 'CITY-1', sxmc: '注销备案' }, {
      zjmc: '备案证明', zjbh: '00123', zzsj: '2026-09-01', zjyxqstart: '2026-09-02', zjyxqend: '长期',
    });
    await new LocalExportService().export(path, format, [record('government-info', data)]);
    const content = await readFile(path, 'utf8');
    expect(content).toContain('certificateNumber');
    expect(content).toContain('00123');
    expect(content).toContain('recordBean.primaryBean.zjbh');
    expect(content).not.toContain('予以许可');
    if (format === 'json') expect(JSON.parse(content)[0].data).toEqual(data);
  });

  it('keeps non-publicity market queries in their raw format while canonical market rows use the supplied template', async () => {
    const raw = await destination();
    await new LocalExportService().export(raw, 'xlsx', [record('market-access', { company: '测试公司', queryId: '001' })]);
    const sheet = (await readWorkbook(raw)).getWorksheet('本地数据')!;
    expect(sheet.getRow(1).values).toEqual([undefined, 'systemId', 'matterId', 'recordKey', 'updatedAt', 'company', 'queryId']);
    const canonical = await destination();
    await new LocalExportService().export(canonical, 'xlsx', [record('market-access', { xzxkmc: '许可', xkXdrMc: '测试公司', xkJdrq: '2026-09-01', xkXkjg: '机关' })]);
    expect((await readWorkbook(canonical)).getWorksheet(PERMIT_SHEET_NAME)!.getCell('C3').value).toBe('测试公司');
  });

  it('refuses mixed permit and ordinary-query XLSX instead of exposing technical columns or dropping fields', async () => {
    const path = await destination();
    let confirmed = false;
    await expect(new LocalExportService().export(path, 'xlsx', [record('government-info'), record('market-access', { company: '测试公司' })], async () => { confirmed = true; return true; }))
      .rejects.toThrow('不能混合导出');
    expect(confirmed).toBe(false);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps valid rows uncolored, preserves leading-zero strings and does not leak warning styles between rows', async () => {
    const path = await destination();
    const data = { xkXdrMc: '测试公司', xkXdrLb: '法人及非法人组织', xkXdrShxym: '91440300TEST000001A',
      xkFrdb: '法人', xkXkws: '许可决定书', xkWsh: '文书号1', xkXklb: '普通', xkNr: '内容',
      xkJdrq: '2026-10-01', xkYxqz: '2026-10-01', xkYxqzi: '2026-10-20', xkXkjg: '机关',
      xkXkjgdm: '11440305000000000A', xkZt: '1', xkLydw: '机关', xkLydwdm: '11440305000000000A', xkXkbh: '00123' };
    const result = await new LocalExportService().export(path, 'xlsx', [record('oversize-transport', data), record('oversize-transport', { ...data, xkFrdb: '' })]);
    expect(result?.warningCount).toBe(1);
    const sheet = (await readWorkbook(path)).getWorksheet(PERMIT_SHEET_NAME)!;
    expect(sheet.rowCount).toBe(4);
    expect(sheet.getCell('A3').fill).toEqual({ type: 'pattern', pattern: 'none' });
    expect(sheet.getCell('A3').font.color).toEqual({ argb: 'FF000000' });
    expect(sheet.getCell('A3').note).toBeUndefined();
    expect(sheet.getCell('T3').value).toBe('00123');
    expect(sheet.getCell('L3').value).toBeNull();
    expect(sheet.getCell('A4').value).toBe(2);
    expect(sheet.getCell('A4').fill).toMatchObject({ fgColor: { argb: 'FFFFCCCC' } });
    expect(sheet.getCell('AF4').fill).toMatchObject({ fgColor: { argb: 'FFFFCCCC' } });
  });

  it('does not touch an existing file when validation is cancelled', async () => {
    const path = await destination(); await writeFile(path, 'original');
    const result = await new LocalExportService().export(path, 'xlsx', [record('government-info')], async report => {
      expect(report.missingRows).toBe(1); return false;
    });
    expect(result).toBeNull(); expect(await readFile(path, 'utf8')).toBe('original');
  });

  it.each(['xlsx','csv','json'] as const)('never overwrites an existing %s destination, including after confirmation', async format => {
    const path = await destination(format); await writeFile(path, 'original');
    await expect(new LocalExportService().export(path, format, [record('government-info')], async () => true)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe('original');
  });
});
