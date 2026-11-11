import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { NodeSqliteDriver } from '../../storage/database';
import { LocalExportService } from '../../export/local-export-service';
import { validateExport } from '../../double-publicity/validation';
import { PERMIT_SHEET_NAME } from '../../double-publicity/permit-workbook';
import { HealthPublicityService } from './service';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-health-tool-'));
  cleanups.push(async () => { expect(dirname(resolve(directory))).toBe(resolve(tmpdir())); expect(directory.startsWith(join(tmpdir(), 'fusion-health-tool-'))).toBe(true); await rm(directory, { recursive: true, force: true }); });
  const database = new NodeSqliteDriver(':memory:'); cleanups.push(() => database.close());
  const service = new HealthPublicityService(database); await service.initialize();
  const zip = new JSZip();
  const paragraphs = ['深南卫健医政〔2026〕227号','南山区卫生健康局关于同意测试中医门诊部变更登记注册的批复','你提交的关于测试中医门诊部（统一社会信用代码：91440300MAA5DL1LTT）变更登记注册申请材料收悉，经审核，同意变更《医疗机构执业许可证》业务办理人。','此复。','深圳市南山区卫生健康局','2026年9月14日'];
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  const path = join(directory, '批复.docx'); await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
  return { service, path, directory, database };
}
describe('health tool local persistence and export', () => {
  it('imports good files even if another fails, deduplicates content, and preserves manual edits on repeated imports', async () => {
    const { service, path, database } = await fixture();
    const result = await service.importFiles([path, path, path + '-missing']);
    expect(result.added).toBe(1); expect(result.duplicates).toBe(1); expect(result.errors).toHaveLength(1);
    const id = result.state.documents[0].id;
    await service.update(id, { xkFrdb: '已核实法人' });
    const again = await service.importFiles([path]);
    expect(again.state.documents[0].data.xkFrdb).toBe('已核实法人');
    expect(again.state.documents[0].sourceData.xkFrdb).toBe('');
    const reopened = new HealthPublicityService(database); await reopened.initialize();
    expect((await reopened.state()).documents[0].data.xkFrdb).toBe('已核实法人');
  });
  it('applies configured authority codes only to blank fields and preserves independent row corrections', async () => {
    const { service, path } = await fixture(); const first = await service.importFiles([path]), id = first.state.documents[0].id;
    await service.settings('11440305000000000A');
    await service.update(id, { xkXkjgdm: '11440305000000000B' });
    expect((await service.records([id]))[0].data).toMatchObject({ xkXkjgdm: '11440305000000000B', xkLydwdm: '11440305000000000A' });
    await expect(service.settings('invalid')).rejects.toThrow('18 位');
    await expect(service.update(id, { sourceText: 'forged' })).rejects.toThrow('字段');
    await expect(service.records([id, id])).rejects.toThrow('不同');
    await expect(service.records(['missing'])).rejects.toThrow('不存在');
  });
  it('exports using the existing template, warns and colors the full incomplete row red, and keeps Word untouched on removal', async () => {
    const { service, path, directory } = await fixture();
    const result = await service.importFiles([path]), id = result.state.documents[0].id;
    const records = await service.records([id]); expect(validateExport(records).missingRows).toBe(1);
    const output = join(directory, '双公示.xlsx');
    let asked = false;
    const exported = await new LocalExportService().export(output, 'xlsx', records, async report => { asked = true; expect(report.invalid).toBe(1); return true; });
    expect(asked).toBe(true); expect(exported?.warningCount).toBe(1);
    const workbook = await new ExcelJS.Workbook().xlsx.readFile(output, { ignoreNodes: ['dataValidations'] }), sheet = workbook.getWorksheet(PERMIT_SHEET_NAME)!;
    expect(sheet.rowCount).toBe(3); expect(sheet.columnCount).toBe(32);
    expect(sheet.getCell('C3').value).toBe('测试中医门诊部');
    expect(sheet.getCell('AF3').fill).toMatchObject({ fgColor: { argb: 'FFFFCCCC' } });
    expect(JSON.stringify(sheet.getCell('A3').note)).toContain('法定代表人');
    await service.remove(id); expect((await service.state()).documents).toHaveLength(0);
    expect((await readFile(path)).length).toBeGreaterThan(0);
  });
  it('persists verified enterprise fill and its provenance without modifying Word extraction or later manual edits', async () => {
    const { service, path } = await fixture();
    const imported = await service.importFiles([path]);
    const original = imported.state.documents[0];
    const records = await service.records([original.id]);
    const filled = { ...records[0].data, xkFrdb: '后台法人', enterpriseEnrichment: {
      requestId: 'backend-request', status: 'success', enterprise: { source: 'aliyun-name' },
      input: { name: original.data.xkXdrMc, creditCode: '', applicantCode: '' }, before: { xkFrdb: '' }, applied: { xkFrdb: '后台法人' },
    } };
    await service.applyEnterpriseResults(records, [filled]);
    const saved = (await service.state()).documents[0];
    expect(saved.data.xkFrdb).toBe('后台法人');
    expect(saved.evidence.xkFrdb).toContain('backend-request');
    expect(saved.sourceText).toBe(original.sourceText); expect(saved.sourceData).toEqual(original.sourceData);
    expect(saved.enterpriseEnrichment).toMatchObject({ requestId: 'backend-request' });
    await service.update(original.id, { xkFrdb: '人工确认法人' });
    await service.applyEnterpriseResults(records, [filled]);
    expect((await service.state()).documents[0].data.xkFrdb).toBe('人工确认法人');
    expect((await service.records([original.id]))[0].data.enterpriseEnrichment).toMatchObject({ requestId: 'backend-request' });
    await expect(service.applyEnterpriseResults(records, [])).rejects.toThrow('数量不匹配');
  });
});
