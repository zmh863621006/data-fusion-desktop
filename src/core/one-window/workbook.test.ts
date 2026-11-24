import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { createOneWindowWorkbook, oneWindowWorkbookFilename } from './workbook';

function sample() {
  return {
    bsnum: 'TEST-000001', receiveNumber: '00001234', matterName: '设置大型户外广告审批', applicant: '=1+1', applicantId: '001234',
    statusLabel: '已办结', detailStatus: 'complete', detailFailures: [],
    sourceList: { BSNUM: 'TEST-000001', nested: { enabled: true, omitted: null }, empty: [] },
    details: {
      base: { status: 'complete', data: { 主体名称: '测试主体', 法定代表人: '测试人员' } },
      form: { status: 'complete', data: {
        name: '广告申请表', version: '测试版本', fields: [{ key: 'EntName', label: '单位名称' }],
        data: {
          EntName: '测试主体', remarks: '长内容🧪'.repeat(10_000), amount: 0, agreed: false, empty: {},
          XingShiCaiZhiJiGuiGe: [
            { code0: '灯箱', code1: '', code2: ['金属', '玻璃'], code3: '', code4: 1.5, code5: 3, code6: 0.1, code7: 4 },
            { code0: 'LED', code4: 5, code5: 6, code7: 7 },
          ],
        },
      } },
      materials: { status: 'complete', data: [{ name: '测试材料', files: [{ name: '位置图', path: '/test/file' }] }] },
      opinions: { status: 'absent', data: [] },
    },
  };
}

async function load(bytes: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  return workbook;
}

function jsonRecord(workbook: ExcelJS.Workbook): unknown {
  const sheet = workbook.getWorksheet('完整数据JSON')!;
  const rows: Array<{ order: number; text: string; count: number }> = [];
  sheet.eachRow((row, number) => { if (number > 1) rows.push({ order: Number(row.getCell(3).value), text: String(row.getCell(5).value), count: Number(row.getCell(4).value) }); });
  expect(rows.length).toBe(rows[0].count);
  return JSON.parse(rows.sort((a, b) => a.order - b.order).map(row => row.text).join(''));
}

describe('one-window full-detail Excel workbook', () => {
  it('round-trips long structured details, repeated rows, empty values and text beginning with a formula marker', async () => {
    const record = sample();
    const workbook = await load(await createOneWindowWorkbook([record], { collectedAt: 1_000 }));
    expect(jsonRecord(workbook)).toEqual(record);
    expect(workbook.getWorksheet('办件总览')!.getCell('B2').value).toBe('00001234');
    const applicant = workbook.getWorksheet('办件总览')!.getCell('D2');
    expect(applicant.type).toBe(ExcelJS.ValueType.String);
    expect(applicant.value).toBe('=1+1');
    expect(workbook.getWorksheet('广告规格')!.rowCount).toBe(3);
    expect(workbook.getWorksheet('广告规格')!.getCell('E2').value).toBe('["金属","玻璃"]');
    const fieldSheet = workbook.getWorksheet('完整业务字段')!;
    const labels: string[] = [];
    fieldSheet.eachRow(row => {
      expect(String(row.getCell(8).value ?? '').length).toBeLessThanOrEqual(30_000);
      labels.push(String(row.getCell(4).value ?? ''));
    });
    expect(labels).toContain('单位名称');
    expect(workbook.created.getTime()).toBe(1_000);
  });

  it('excludes credentials from objects and URL queries while retaining business identifiers', async () => {
    const record = { ...sample(), cookie: 'fixture-cookie', accessToken: 'fixture-token',
      sourceList: { BSNUM: 'TEST-000001', password: 'fixture-password', fileUrl: 'https://example.invalid/file?a=1&accessToken=fixture-token' } };
    const workbook = await load(await createOneWindowWorkbook([record]));
    const data = JSON.stringify(jsonRecord(workbook));
    expect(data).not.toContain('fixture-cookie');
    expect(data).not.toContain('fixture-token');
    expect(data).not.toContain('fixture-password');
    expect(data).toContain('https://example.invalid/file?a=1');
    expect(data).toContain('TEST-000001');
  });

  it('creates an empty batch workbook and uses safe distinct business-detail filenames', async () => {
    const workbook = await load(await createOneWindowWorkbook([]));
    expect(workbook.getWorksheet('办件总览')!.rowCount).toBe(1);
    expect(oneWindowWorkbookFilename({ businessName: '广告/审批', batchId: 'batch-1', startDate: '2026-11-01', endDate: '2026-11-24' }))
      .toBe('业务详情-广告_审批-2026-11-01至2026-11-24-batch-1.xlsx');
    await expect(createOneWindowWorkbook([{ details: {} }])).rejects.toThrow('申办流水号');
  });
});
