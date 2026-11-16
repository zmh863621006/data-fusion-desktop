import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { StoredRecord } from '../storage/types';
import { LocalExportService } from './local-export-service';
import { assertGovernmentExportTarget, supportsGovernmentExport } from './government-target';
import { validateNanshanPermit, nanshanValue, NANSHAN_PERMIT_SHEET } from '../double-publicity/nanshan-permit';
import { validateProvincialPermit, provincialValue, PROVINCIAL_PERMIT_SHEET } from '../double-publicity/provincial-permit';

const systemId = 'shenzhen-hazardous-chemicals';
const permit: StoredRecord = {
  systemId, matterId: 'hazchem-business-new', recordKey: 'fixture-serial', firstSeenAt: 1, updatedAt: 1,
  data: {
    xkXdrMc: '示例危化品企业', xkXdrLb: '法人及非法人组织', xkXdrShxym: '91440300123456789Q', xkFrdb: '示例法人',
    ajmc: '危险化学品经营许可案件', xkXkws: '行政许可决定书', xkWsh: '示例字001', xkXkzs: '危险化学品经营许可证', xkXkbh: '000001',
    xkJdrq: '2026-11-15', xkYxqz: '2026-11-15', xkYxqzi: '2029-11-14',
    xkNr: '示例许可经营范围', xkXklb: '普通', xkCljg: '予以许可', xkZqly: '依职权', xkZt: '1',
    xkXkjg: '深圳市南山区应急管理局', xkXkjgdm: '', xkLydw: '深圳市南山区应急管理局', xkLydwdm: '',
  },
};
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('hazardous chemicals publication exports', () => {
  it('permits either publication template for one supported system and rejects mixed-system or alternate-format requests', () => {
    expect(supportsGovernmentExport(systemId)).toBe(true);
    for (const target of ['guangdong-law', 'nanshan'] as const) {
      expect(() => assertGovernmentExportTarget(target, 'xlsx', [systemId, systemId])).not.toThrow();
      expect(() => assertGovernmentExportTarget(target, 'xlsx', [systemId, 'government-info'])).toThrow('单系统');
      expect(() => assertGovernmentExportTarget(target, 'xlsx', ['guangdong-hrss'])).toThrow('仅支持');
      expect(() => assertGovernmentExportTarget(target, 'json', [systemId])).toThrow('仅支持');
    }
  });

  it('retains explicit agency names, leaves unknown codes blank and never applies a government water default', () => {
    expect(nanshanValue(permit, 'xkXkjg')).toBe('深圳市南山区应急管理局');
    expect(nanshanValue(permit, 'xkXkjgdm')).toBe('');
    expect(nanshanValue(permit, 'xkLydwdm')).toBe('');
    const collidingMatter = { ...permit, matterId: 'drainage-permit-new', data: { ...permit.data, xkXkjg: '', xkLydw: '' } };
    expect(nanshanValue(collidingMatter, 'xkXkjg')).toBe('');
    expect(nanshanValue(collidingMatter, 'xkXkjgdm')).toBe('');
    expect(provincialValue(collidingMatter, 'xkXkjg')).toBe('');
    const fields = validateNanshanPermit([permit]).issues[0].fields.map(field => field.key);
    expect(fields).toEqual(expect.arrayContaining(['xkXkjgdm', 'xkLydwdm']));
  });

  it('accepts the explicitly configured agency credit code without needing an export-layer default', () => {
    const configured: StoredRecord = { ...permit, data: { ...permit.data, xkXkjgdm: '11440305MB2D288348', xkLydwdm: '11440305MB2D288348' } };
    expect(validateNanshanPermit([configured]).invalid).toBe(0);
    expect(validateProvincialPermit([configured]).invalid).toBe(0);
    expect(nanshanValue(configured, 'xkXkjgdm')).toBe('11440305MB2D288348');
    expect(configured.data.xkXkjg).toBe('深圳市南山区应急管理局');
  });

  it('exports the provincial 24-column workbook and the separate Nanshan 31-column workbook with useful missing-field notes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fusion-hazchem-export-')); dirs.push(dir);
    const service = new LocalExportService();
    const province = join(dir, '省执法.xlsx');
    expect(validateProvincialPermit([permit]).invalid).toBe(0);
    await service.export(province, 'xlsx', [permit], undefined, undefined, 'guangdong-law');
    const provincialSheet = (await new ExcelJS.Workbook().xlsx.readFile(province, { ignoreNodes: ['dataValidations'] })).getWorksheet(PROVINCIAL_PERMIT_SHEET)!;
    expect(provincialSheet.columnCount).toBe(24);
    expect(provincialSheet.getCell('V5').value).toBe('深圳市南山区应急管理局');
    const nanshan = join(dir, '南山.xlsx'), confirm = vi.fn(async () => true);
    expect(await service.export(nanshan, 'xlsx', [permit], confirm, undefined, 'nanshan')).toMatchObject({ warningCount: 1, missingRequiredCount: 1 });
    expect(confirm).toHaveBeenCalledOnce();
    const sheet = (await new ExcelJS.Workbook().xlsx.readFile(nanshan)).getWorksheet(NANSHAN_PERMIT_SHEET)!;
    expect(sheet.columnCount).toBe(31);
    expect(sheet.getCell('AA2').value).toBe('深圳市南山区应急管理局');
    expect(sheet.getCell('AB2').value).toBeNull();
    expect(sheet.getCell('AD2').value).toBeNull();
    expect(JSON.stringify(sheet.getCell('AB2').note)).toContain('必填');
    for (let column = 1; column <= 31; column++) expect(sheet.getRow(2).getCell(column).fill).toMatchObject({ fgColor: { argb: 'FFFFCCCC' } });
  });

  it('flags missing cancellation content instead of substituting the case title or certificate name', () => {
    const cancellation = { ...permit, matterId: 'hazchem-business-cancel', data: { ...permit.data, xkNr: '', xkCljg: '' } };
    for (const validate of [validateNanshanPermit, validateProvincialPermit]) {
      expect(validate([cancellation]).issues[0].fields.map(field => field.key)).toEqual(expect.arrayContaining(['xkNr', 'xkCljg']));
    }
    expect(cancellation.data.xkNr).toBe('');
  });
});
