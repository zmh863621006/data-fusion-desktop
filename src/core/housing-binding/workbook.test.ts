import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseHousingWorkbook, createHousingTemplate } from './workbook';
const code='0012345678901234567890123';
async function file(values: ExcelJS.CellValue[], headers=['房屋编码']) {
 const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('清单');sheet.addRow(headers);
 values.forEach(value=>sheet.addRow([value]));return Buffer.from(await workbook.xlsx.writeBuffer());
}
describe('房屋编码Excel导入',()=>{
 it('keeps all 25 digits including leading zero and removes duplicate rows',async()=>{
  const result=await parseHousingWorkbook(await file([code,code,'','1234567890123456789012345']));
  expect(result).toMatchObject({totalRows:3,duplicateCount:1,issues:[],codes:[{rowNumber:2,code},{rowNumber:5,code:'1234567890123456789012345'}]});
 });
 it('rejects rounded numeric cells and formulas even if formatted as text',async()=>{
  const result=await parseHousingWorkbook(await file([1234567890123456700000000,{formula:'"'+code+'"',result:code},'1.23E+24','12#34']));
  expect(result.codes).toHaveLength(0);expect(result.issues).toHaveLength(4);expect(result.issues[0].message).toContain('精度');
 });
 it('accepts different source code lengths as exact opaque text',async()=>{
  const values=['1','00123','1234567890123456789',code,'123456789012345678901234567890','AB-001/02'];
  const result=await parseHousingWorkbook(await file(values));
  expect(result.issues).toEqual([]);expect(result.codes.map(row=>row.code)).toEqual(values);
 });
 it('requires one unambiguous named column',async()=>{
  await expect(parseHousingWorkbook(await file([code],['编号']))).rejects.toThrow('未找到');
  await expect(parseHousingWorkbook(await file([code],['房屋编码','房屋编码']))).rejects.toThrow('多个');
 });
 it('does not import explanatory template text as a code',async()=>{
  await expect(parseHousingWorkbook(await createHousingTemplate())).rejects.toThrow('没有房屋编码');
 });
 it('rejects renamed legacy, encrypted, empty and oversized input',async()=>{
  for(const bytes of [Buffer.alloc(0),Buffer.from('not an excel file'),Buffer.alloc(10*1024*1024+1)])await expect(parseHousingWorkbook(bytes)).rejects.toThrow();
 });
});
