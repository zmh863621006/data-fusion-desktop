import ExcelJS from 'exceljs';
import { expect, it } from 'vitest';
import type { StoredRecord } from '../storage/types';
import { createCollectionDisclosureWorkbook } from './collection-disclosure-workbook';

function permit(systemId: string, matterId: string, data: StoredRecord['data']): StoredRecord {
  return { systemId, matterId, data, recordKey: matterId, firstSeenAt: 0, updatedAt: 0 };
}

it('preserves the collection system’s one-row administrative-permit template and cell types', async () => {
  const equipment = permit('guangdong-special-equipment', 'equipment-use-registration', {
    xzxkmc: '特种设备使用登记证', xkXdrMc: '测试相对人', xkXdrLb: '自然人', xkXdrZjlx: '居民身份证',
    xkXdrZjhm: '012345678901234567', xkWsh: '00123', xkXkbh: '00456', xkJdrq: '2026-11-23',
    xkLydw: '测试来源单位', xkSxjbbm: '000100', xkSxssbm: '000200',
    provincialDocumentNumber: '独立的司法文书号', ajmc: '独立的司法案件名称',
  });
  const food = permit('guangdong-food-drug', 'food-production-license', {
    xzxkmc: '食品生产许可证', xkXdrMc: '测试企业', xkXdrLb: '法人及非法人组织',
    xkFrZjlx: '居民身份证', xkWsh: '000078', xkXkbh: '000090',
  });
  const workbook = createCollectionDisclosureWorkbook([equipment, food]);
  const saved = await workbook.xlsx.writeBuffer();
  const readback = new ExcelJS.Workbook();
  await readback.xlsx.load(saved);
  expect(readback.worksheets.map(sheet => sheet.name)).toEqual(['行政许可']);
  const sheet = readback.getWorksheet('行政许可')!;
  expect(sheet.getRow(1).values).toEqual([
    undefined, '序号', '许可项目名称', '行政相对人名称', '行政相对人类别',
    '行政相对人代码_1(统一社会信用代码)', '行政相对人代码_2 (工商注册号)', '行政相对人代码_3(组织机构代码)',
    '行政相对人代码_4(税务登记号)', '事业单位证书号', '社会组织登记证号', '法定代表人', '法定代表人证件类型',
    '法定代表人证件号码', '自然人证件类型', '自然人证件号码', '行政许可决定文书名称', '行政许可决定文书号',
    '许可类别', '许可证书名称', '许可编号', '许可内容', '许可决定日期', '有效期自', '有效期止', '许可机关',
    '许可机关统一社会信用代码', '当前状态', '数据来源单位', '数据来源单位统一社会信用代码',
    '事项基本编码', '事项实施编码', '备注',
  ]);
  expect(sheet.rowCount).toBe(3);
  expect(sheet.getColumn(1).width).toBe(16.7166666666667);
  expect(sheet.properties.defaultRowHeight).toBe(13.5);
  expect(sheet.getCell('A1').style).toMatchObject({ font: { name: 'Arial', size: 10, bold: true },
    fill: { type: 'pattern', fgColor: { argb: 'FF808080' } } });
  expect(sheet.getRow(2).height).toBe(14);
  expect(sheet.getCell('A2').value).toBe('1');
  expect(sheet.getCell('N2').value).toBe('身份证');
  expect(sheet.getCell('O2').value).toBe('012345678901234567');
  expect(sheet.getCell('Q2').value).toBe('00123');
  expect(sheet.getCell('T2').value).toBe('00456');
  expect(sheet.getCell('V2').value).toBe('2026-11-23');
  expect(sheet.getCell('AB2').value).toBe('测试来源单位');
  expect(sheet.getCell('AD2').value).toBe('000100');
  expect(sheet.getCell('AE2').value).toBe('000200');
  expect(sheet.getCell('A3').value).toBe('2');
  expect(sheet.getCell('L3').value).toBe('居民身份证');
  expect(sheet.getCell('Q3').value).toBe('000078');
  expect(sheet.getCell('T3').value).toBe('000090');
  expect(sheet.getCell('AF3').value).toBe('');
  expect(sheet.getCell('AF3').note).toBeUndefined();
});
