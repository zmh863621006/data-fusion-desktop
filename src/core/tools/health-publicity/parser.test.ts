import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parseHealthParagraphs, readHealthDocx } from './parser';

const after = ['此复。', '深圳市南山区卫生健康局', '2026年9月14日', '公开方式：主动公开', '深圳市南山区卫生健康局办公室\t2026年9月18日印发'];
export const fixtureParagraphs = [
  '深南卫健医政〔2026〕227号', '南山区卫生健康局关于同意测试中医门诊部变更登记注册的批复',
  '赖某（测试中医门诊部）：',
  '你提交的关于测试中医门诊部（统一社会信用代码：91440300MAA5DL1LTT）变更登记注册申请材料收悉。根据相关规定，经审核，同意测试中医门诊部《医疗机构执业许可证》有关业务办理人由张某变更为赖某。',
  ...after,
];
const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
export async function makeDocx(paragraphs = fixtureParagraphs) {
  const zip = new JSZip();
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(value => `<w:p><w:r><w:t>${escapeXml(value)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('health publicity Word parser', () => {
  it('uses the signed date rather than the later printed date; does not infer legal representative from staff', async () => {
    const doc = await readHealthDocx(await makeDocx(), '批复.docx');
    expect(doc.kind).toBe('变更登记');
    expect(doc.data).toMatchObject({ xkXdrMc: '测试中医门诊部', xkXdrShxym: '91440300MAA5DL1LTT', xkJdrq: '2026-09-14', xkFrdb: '', xkYxqz: '', xkYxqzi: '', xkZt: '' });
    expect(doc.data.xkNr).toContain('有关业务办理人由张某变更为赖某');
    expect(doc.evidence.xkJdrq).toContain('非页尾印发日期');
    expect(doc.data).not.toHaveProperty('sourceText');
  });
  it('uses the new name for a rename while preserving the original name and evidence', () => {
    const doc = parseHealthParagraphs(['深南卫健医政〔2026〕231号','南山区卫生健康局关于同意测试旧门诊部变更登记注册的批复','你提交的关于测试旧门诊部（统一社会信用代码：91440300319387104L）变更登记注册的申请材料收悉。','一、同意该机构名称由“测试旧门诊部”变更为“测试新门诊部”。', ...after], '名称变更.docx');
    expect(doc.originalName).toBe('测试旧门诊部');
    expect(doc.data.xkXdrMc).toBe('测试新门诊部');
    expect(doc.sourceText).toContain('测试旧门诊部');
  });
  it('does not use a parent setting-unit code, registration number or principal as institution credit code, permit number or legal representative', () => {
    const doc = parseHealthParagraphs(['深南卫健医政〔2026〕230号','南山区卫生健康局关于同意测试中医门诊部执业登记注册的批复','你提交的关于测试中医门诊部执业登记注册的申请材料收悉。现批复如下：','一、同意执业登记，核定如下：','（一）医疗机构名称：测试中医门诊部。','（二）医疗机构负责人：张某。','（三）设置单位/设置主体：测试医院（统一社会信用代码：12440300MB2P993T6E）。','（四）登记号：PDY5120344603051D2111。', ...after], '执业.docx');
    expect(doc.kind).toBe('执业登记');
    expect(doc.data).toMatchObject({ xkXdrShxym: '', xkFrdb: '', xkXkbh: '' });
    expect(doc.warnings.join('')).toContain('设置单位');
  });
  it('keeps cancellation status/validity unfilled and does not discard the cancellation decision', () => {
    const doc = parseHealthParagraphs(['深南卫健医政〔2026〕163号','南山区卫生健康局关于同意注销测试门诊部登记注册的批复','你提交的关于测试门诊部（统一社会信用代码：91440300MA5FAENT64）注销执业登记注册的申请材料收悉。','一、同意注销测试门诊部的《医疗机构执业许可证》。', ...after], '注销.docx');
    expect(doc.kind).toBe('注销登记');
    expect(doc.data.xkNr).toContain('同意注销');
    expect(doc.data.xkZt).toBe('');
    expect(doc.data.xkYxqzi).toBe('');
  });
  it('does not fall back to a print date when no signed date is present', () => {
    const doc = parseHealthParagraphs(fixtureParagraphs.filter(value => value !== '2026年9月14日'), '无落款日期.docx');
    expect(doc.data.xkJdrq).toBe('');
  });
  it('rejects renamed DOC, malformed archives, XML entity declarations and oversized input', async () => {
    await expect(readHealthDocx(Buffer.from('not a zip'), '批复.docx')).rejects.toThrow('DOCX');
    await expect(readHealthDocx(await makeDocx(), '批复.doc')).rejects.toThrow('另存为');
    await expect(readHealthDocx(Buffer.alloc(21 * 1024 * 1024), '批复.docx')).rejects.toThrow('20 MB');
    const zip = new JSZip(); zip.file('word/document.xml', '<!DOCTYPE test [<!ENTITY x "unsafe">]><test/>');
    await expect(readHealthDocx(await zip.generateAsync({ type: 'nodebuffer' }), '批复.docx')).rejects.toThrow('XML');
  });
  it('ignores deleted/hidden Word runs rather than publishing obsolete text', async () => {
    const zip = await JSZip.loadAsync(await makeDocx());
    const original = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', original.replace('</w:body>', '<w:p><w:del><w:r><w:t>已删除的旧数据</w:t></w:r></w:del><w:r><w:rPr><w:vanish/></w:rPr><w:t>隐藏数据</w:t></w:r></w:p></w:body>'));
    const doc = await readHealthDocx(await zip.generateAsync({ type: 'nodebuffer' }), '修订.docx');
    expect(doc.sourceText).not.toContain('旧数据'); expect(doc.sourceText).not.toContain('隐藏数据');
  });
  it('bounds actual inflation even if a ZIP directory declares a false small size', async () => {
    const zip = new JSZip(); zip.file('word/document.xml', 'x'.repeat(6 * 1024 * 1024));
    const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const end = data.length - 22, central = data.readUInt32LE(end + 16);
    data.writeUInt32LE(1, central + 24);
    await expect(readHealthDocx(data, '伪造体积.docx')).rejects.toThrow(/安全上限|size mismatch/);
  });
});
