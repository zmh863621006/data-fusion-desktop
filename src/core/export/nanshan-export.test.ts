import { afterEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalExportService } from './local-export-service';
import { NANSHAN_PERMIT_COLUMNS, NANSHAN_PERMIT_SHEET, NANSHAN_RULE_SHEET, nanshanValue, validateNanshanPermit } from '../double-publicity/nanshan-permit';
import template from '../double-publicity/nanshan-template.json';
import type { StoredRecord } from '../storage/types';
import { PERMIT_SHEET_NAME } from '../double-publicity/permit-workbook';

const data = { xzxkmc:'旧通用许可项目列不能输出',xkXdrMc:'水务示例企业',xkXdrLb:'法人及非法人组织',xkXdrShxym:'001234567890123456',xkFrdb:'示例法人',
  xkXkws:'排水许可决定书',xkWsh:'00123',xkXklb:'普通',xkXkzs:'排水许可证',xkXkbh:'000456',xkNr:'水务示例企业：许可内容\n特发此证',
  xkJdrq:'2026-11-02 00:00:00',xkYxqz:'2026-11-02',xkYxqzi:'2027-11-01',xkZt:'1',ajmc:'原案件名称',xkZqly:'依职权',xkCljg:'予以许可',
  xkXkjg:'深圳市南山区水务局',xkXkjgdm:'11440305MB2D27962K',xkLydw:'深圳市南山区水务局',xkLydwdm:'11440305MB2D27962K',bz:'原备注',xkSxjbbm:'不应额外输出事项代码',
};
const record = (value: Record<string,unknown> = data): StoredRecord => ({systemId:'government-info',matterId:'drainage-permit-new',recordKey:'sample',data:value,firstSeenAt:1,updatedAt:1});
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir,{recursive:true,force:true}))); });
async function destination() { const dir=await mkdtemp(join(tmpdir(),'fusion-nanshan-'));dirs.push(dir);return join(dir,'行政许可-南山双公示.xlsx'); }
const read = async (path: string) => new ExcelJS.Workbook().xlsx.readFile(path,{ignoreNodes:['dataValidations']});
const text = (v: any): string => v?.richText?.map((r: any) => r.text).join('') ?? String(v??'');

describe('original Nanshan permit template', () => {
  it('preserves the exact 31 headers and the second rule worksheet while starting at row two',async () => {
    const bytes=Buffer.from(template.base64,'base64');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('95a6d3dfdfe8a133d50d80828def86f8b80bdd52efa5bae64c3417042f8eb9bf');
    const sourceZip=await JSZip.loadAsync(bytes);
    sourceZip.file('xl/worksheets/sheet2.xml',(await sourceZip.file('xl/worksheets/sheet2.xml')!.async('string')).replace(/<col\b(?=[^>]*\bmin="7")[^>]*\/>/g,''));
    const source=new ExcelJS.Workbook();await source.xlsx.load(await sourceZip.generateAsync({type:'arraybuffer'}));
    const path=await destination();
    const result=await new LocalExportService().export(path,'xlsx',[record()],undefined,undefined,'nanshan');
    expect(result).toMatchObject({rowCount:1,warningCount:0,missingRequiredCount:0});
    const book=await read(path),sheet=book.getWorksheet(NANSHAN_PERMIT_SHEET)!,ruleSheet=book.getWorksheet(NANSHAN_RULE_SHEET)!;
    expect(book.worksheets.map(s=>s.name)).toEqual([NANSHAN_PERMIT_SHEET,NANSHAN_RULE_SHEET]);
    expect(sheet.columnCount).toBe(31);expect(sheet.rowCount).toBe(2);
    for(let c=1;c<=31;c++) {
      expect(text(sheet.getRow(1).getCell(c).value)).toBe(NANSHAN_PERMIT_COLUMNS[c-1][1]);
      expect(sheet.getRow(1).getCell(c).style).toEqual(source.getWorksheet(NANSHAN_PERMIT_SHEET)!.getRow(1).getCell(c).style);
    }
    for(let r=1;r<=35;r++)for(let c=1;c<=6;c++) {
      expect(ruleSheet.getRow(r).getCell(c).value).toEqual(source.getWorksheet(NANSHAN_RULE_SHEET)!.getRow(r).getCell(c).value);
      expect(ruleSheet.getRow(r).getCell(c).style).toEqual(source.getWorksheet(NANSHAN_RULE_SHEET)!.getRow(r).getCell(c).style);
    }
    expect(sheet.getCell('A2').value).toBe(data.xkXdrMc);expect(sheet.getCell('C2').value).toBe(data.xkXdrShxym);
    expect(sheet.getCell('O2').value).toBe('00123');expect(sheet.getCell('R2').value).toBe('000456');
    expect(sheet.getCell('T2').value).toEqual(new Date('2026-11-02T00:00:00Z'));expect(sheet.getCell('T2').numFmt).toBe('yyyy/mm/dd');
    expect(sheet.getCell('W2').value).toBe('1');expect(sheet.getCell('X2').value).toBe(data.ajmc);
    expect(sheet.getCell('Y2').value).toBe('依职权');expect(sheet.getCell('Z2').value).toBe('予以许可');
    expect(sheet.getCell('AA2').value).toBe(data.xkXkjg);expect(sheet.getCell('AB2').value).toBe(data.xkXkjgdm);
    expect(sheet.getCell('AC2').value).toBe(data.xkLydw);expect(sheet.getCell('AD2').value).toBe(data.xkLydwdm);expect(sheet.getCell('AE2').value).toBe(data.bz);
    const zip=await JSZip.loadAsync(await readFile(path));const $=load(await zip.file(`xl/worksheets/sheet${sheet.id}.xml`)!.async('string'),{xml:true});
    expect($('dimension').attr('ref')).toBe('A1:AE2');expect($('dataValidation formula1').text()).toBe('"法人及非法人组织,自然人,个体工商户"');
    expect(text(sheet.getRow(1).values)).not.toContain('序号');
  });
  it('keeps blank required Nanshan-specific fields blank and highlights all 31 cells with correctly placed notes',async () => {
    const input=record({...data,ajmc:'',xkZqly:'',xkCljg:''}),path=await destination(),confirm=vi.fn(async()=>true);
    const result=await new LocalExportService().export(path,'xlsx',[input],confirm,undefined,'nanshan');
    expect(result).toMatchObject({warningCount:1,missingRequiredCount:1});expect(confirm).toHaveBeenCalledOnce();
    const sheet=(await read(path)).getWorksheet(NANSHAN_PERMIT_SHEET)!;
    for(let c=1;c<=31;c++)expect(sheet.getRow(2).getCell(c).fill).toMatchObject({fgColor:{argb:'FFFFCCCC'}});
    for(const cell of ['X2','Y2','Z2']) {expect(sheet.getCell(cell).value).toBeNull();expect(JSON.stringify(sheet.getCell(cell).note)).toContain('缺少南山模板必填字段');}
    expect(JSON.stringify(sheet.getCell('A2').note)).toContain('案件名称');expect(sheet.getCell('A1').note).toBeUndefined();
  });
  it('uses natural-person fields, validates paired legal-person IDs and normalizes only the documented long-term date',async () => {
    const natural=record({...data,xkXdrLb:'自然人',xkXdrShxym:'',xkFrdb:'',xkXdrZjlx:'居民身份证',xkXdrZjhm:'001234567890123456',xkYxqzi:'长期'});
    const path=await destination();
    expect(validateNanshanPermit([natural]).invalid).toBe(0);
    await new LocalExportService().export(path,'xlsx',[natural],undefined,undefined,'nanshan');
    const sheet=(await read(path)).getWorksheet(NANSHAN_PERMIT_SHEET)!;
    expect(sheet.getCell('I2').value).toBeNull();expect(sheet.getCell('L2').value).toBe('身份证');expect(sheet.getCell('M2').value).toBe('001234567890123456');
    expect(sheet.getCell('V2').value).toEqual(new Date('2099-12-31T00:00:00Z'));expect(natural.data.xkYxqzi).toBe('长期');
    const invalid=validateNanshanPermit([record({...data,xkFrZjlx:'身份证',xkFrZjhm:''})]);
    expect(invalid.issues[0].fields.map(f=>f.key)).toContain('xkFrZjhm');
  });
  it('checks date validity, order, boundary, status and source/result dictionaries without inventing replacements',()=> {
    const invalid=validateNanshanPermit([record({...data,xkJdrq:'2026-02-30',xkYxqz:'1948-01-01',xkYxqzi:'2100-01-01',xkZt:'有效',xkCljg:'正常受理',xkZqly:'未知'})]);
    expect(invalid.issues[0].fields.map(f=>f.key)).toEqual(expect.arrayContaining(['xkJdrq','xkYxqz','xkYxqzi','xkZt','xkCljg','xkZqly']));
    expect(validateNanshanPermit([record({...data,xkYxqz:'2026-11-01',xkYxqzi:'2026-11-01'})]).issues[0].fields.map(f=>f.key)).toEqual(expect.arrayContaining(['xkYxqz','xkYxqzi']));
  });
  it('fills only confirmed water authorities and retains known other departments without copying water or education defaults',async()=> {
    const water=record({...data,xkXkjg:'',xkXkjgdm:'',xkLydw:'',xkLydwdm:''});
    const unknown={...water,matterId:'teacher-qualification'};
    const wrong={...record(),matterId:'teacher-qualification'};
    const known={...unknown,data:{...unknown.data,xkXkjg:'原数据明确的其他机关',xkXkjgdm:'其他机关代码',xkLydw:'其他来源单位',xkLydwdm:'其他来源代码'}};
    const path=await destination();await new LocalExportService().export(path,'xlsx',[water,unknown,wrong,known],undefined,undefined,'nanshan');
    const sheet=(await read(path)).getWorksheet(NANSHAN_PERMIT_SHEET)!;
    expect(sheet.getCell('AA2').value).toBe('深圳市南山区水务局');expect(sheet.getCell('AB2').value).toBe('11440305MB2D27962K');
    for(const col of ['AA','AB','AC','AD']) {expect(sheet.getCell(col+'3').value).toBeNull();expect(sheet.getCell(col+'4').value).toBeNull();}
    expect(sheet.getCell('AA5').value).toBe('原数据明确的其他机关');expect(nanshanValue(unknown,'xkXkjg')).toBe('');
    expect(water.data.xkXkjg).toBe('');
  });
  it('supports safe government aliases, keeps delegated construction-waste identity unresolved and does not alter source rows',()=> {
    const input=record({qymc:'原企业',qylx:'法人及非法人组织',xydm:'原信用代码',frdb:'原法人',xknr:'原内容',xkjdrq:'2026-11-02',yxqs:'2026-11-02',yxqe:'2027-11-01'});
    expect(nanshanValue(input,'xkXdrMc')).toBe('原企业');expect(nanshanValue(input,'xkJdrq')).toBe('2026-11-02');
    const frozen=record(Object.freeze({...data}));expect(validateNanshanPermit([frozen]).invalid).toBe(0);expect(frozen.data).toEqual(data);
    const delegated={...record({...data,sxmc:'城市建筑垃圾处置（排放）核准',applyer:'深圳市南山区水务局'}),matterId:'construction-waste-discharge'};
    for(const key of ['xkXdrMc','xkXdrShxym','xkFrdb'])expect(nanshanValue(delegated,key)).toBe('');
    expect(validateNanshanPermit([delegated]).issues[0].fields.map(field=>field.key)).toEqual(expect.arrayContaining(['xkXdrMc','xkXdrShxym','xkFrdb']));
  });
  it('cancellation creates no file and legacy exports for other systems keep their original template',async()=> {
    const path=await destination(),service=new LocalExportService();
    expect(await service.export(path,'xlsx',[record({})],async()=>false,undefined,'nanshan')).toBeNull();expect(await readdir(dirs.at(-1)!)).toEqual([]);
    await service.export(path,'xlsx',[{...record(),systemId:'transport-practitioner'}]);
    const book=await read(path);expect(book.worksheets).toHaveLength(1);expect(book.getWorksheet(PERMIT_SHEET_NAME)!.columnCount).toBe(32);
  });
});
