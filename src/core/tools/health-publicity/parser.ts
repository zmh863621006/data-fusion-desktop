import JSZip from 'jszip';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { DOUBLE_PUBLICITY_TEMPLATE } from '../../double-publicity/template';
import type { HealthPublicityDocument } from './types';

const compact = (text: string) => text.replace(/[\s\u3000]+/g, '');
const trimValue = (text = '') => text.trim().replace(/[。；;]$/, '');

function checkArchive(data: Buffer): void {
  if (data.length > 20 * 1024 * 1024) throw new Error('单份 Word 不得超过 20 MB');
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65557); at--) {
    if (data.readUInt32LE(at) === 0x06054b50 && at + 22 + data.readUInt16LE(at + 20) === data.length) { end = at; break; }
  }
  if (end < 0) throw new Error('不是有效的 DOCX 文件，请勿仅修改文件扩展名');
  const count = data.readUInt16LE(end + 10), start = data.readUInt32LE(end + 16), size = data.readUInt32LE(end + 12);
  if (count > 2000 || start + size > end || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) throw new Error('不支持超大、分卷或 ZIP64 Word 文档');
  let at = start, total = 0;
  for (let entry = 0; entry < count; entry++) {
    if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) throw new Error('Word 压缩目录损坏');
    const bytes = data.readUInt32LE(at + 24), nameSize = data.readUInt16LE(at + 28);
    const next = at + 46 + nameSize + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
    if (next > end || (data.readUInt16LE(at + 8) & 1)) throw new Error('不支持损坏或加密的 Word 文档');
    const name = data.subarray(at + 46, at + 46 + nameSize).toString('utf8');
    total += bytes;
    if (total > 50 * 1024 * 1024 || (name === 'word/document.xml' && bytes > 5 * 1024 * 1024)) throw new Error('Word 解压内容超出安全上限');
    at = next;
  }
  if (at !== start + size) throw new Error('Word 压缩目录格式无效');
}

export async function readHealthDocx(data: Buffer, fileName: string): Promise<HealthPublicityDocument> {
  if (!/\.docx$/i.test(fileName)) throw new Error('目前支持 DOCX，请将旧版 DOC 另存为 DOCX 后导入');
  checkArchive(data);
  const archive = await JSZip.loadAsync(data);
  const entry = archive.file('word/document.xml');
  if (!entry) throw new Error('Word 缺少正文内容');
  // Bound actual decompressed bytes even when a forged directory lies about its size.
  const xml = await new Promise<string>((resolve, reject) => {
    const stream = entry.nodeStream(), chunks: Buffer[] = []; let size = 0;
    stream.on('data', (chunk: Buffer) => {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 5 * 1024 * 1024) { stream.pause(); reject(new Error('Word 正文解压内容超出安全上限')); return; }
      chunks.push(bytes);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.resume();
  });
  if (!xml || xml.length > 5 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Word 正文缺失或包含不支持的 XML 内容');
  const $ = cheerio.load(xml, { xmlMode: true });
  $('w\\:del, w\\:moveFrom').remove();
  $('w\\:r').filter((_, node) => $(node).find('w\\:vanish').length > 0).remove();
  const paragraphs = $('w\\:body').find('w\\:p').toArray().map(node => $(node).find('w\\:t, w\\:tab, w\\:br').toArray().map(part => part.tagName === 'w:t' ? $(part).text() : part.tagName === 'w:tab' ? '\t' : '\n').join('').trim()).filter(Boolean);
  if (paragraphs.join('\n').length > 30000) throw new Error('单份批复正文超过 3 万字，请拆分文档后导入');
  return parseHealthParagraphs(paragraphs, basename(fileName), createHash('sha256').update(data).digest('hex'));
}

export function parseHealthParagraphs(paragraphs: string[], fileName: string, id = createHash('sha256').update(paragraphs.join('\n')).digest('hex')): HealthPublicityDocument {
  const text = paragraphs.join('\n'), all = compact(text);
  if (!all.includes('卫生健康局') || !all.includes('批复') || !all.includes('登记')) throw new Error('未识别为卫健局医疗机构登记批复，请核对文件内容');
  const warnings: string[] = [], evidence: Record<string, string> = {};
  const data: Record<string, string> = Object.fromEntries(DOUBLE_PUBLICITY_TEMPLATE.map(([key]) => [key, '']));
  const assign = (key: string, value: string, source: string) => { if (value) { data[key] = value; evidence[key] = source; } };
  const number = paragraphs.map(compact).find(line => /^[^〔\[（(]{2,30}[〔\[（(]\d{4}[〕\]）)]\d+号$/.test(line)) ?? '';
  if (!number) throw new Error('未识别行政许可决定文书号，暂不生成记录');
  const titleStart = paragraphs.findIndex(line => /卫生健康局关于/.test(compact(line)));
  let title = '';
  if (titleStart >= 0) for (const line of paragraphs.slice(titleStart, titleStart + 8)) {
    title += compact(line);
    if (title.includes('批复')) { title = title.slice(0, title.indexOf('批复') + 2); break; }
  }
  if (!title.endsWith('批复')) throw new Error('未完整识别批复标题，请核对 Word 正文');
  const kind = title.includes('注销') ? '注销登记' : title.includes('变更') ? '变更登记' : '执业登记';
  const labeledName = all.match(/医疗机构名称[:：]([^。\n]+?)(?:。|（[二三四五])/u)?.[1];
  const originalName = trimValue(labeledName ?? all.match(/你提交的关于(.+?)(?:[（(]统一社会信用代码|(?:执业|变更|注销)(?:执业)?登记)/)?.[1]);
  if (!originalName) throw new Error('未识别医疗机构名称，请核对正文');
  const renamed = all.match(/(?:机构)?名称由[“"]([^”"]+)[”"]变更为[“"]([^”"]+)[”"]/)?.[2];
  assign('xkXdrMc', renamed ?? originalName, renamed ? `名称变更条款：${originalName} → ${renamed}` : `正文医疗机构名称：${originalName}`);
  assign('xkXdrLb', '法人及非法人组织', '医疗机构登记批复，主体为机构；可在核对时调整');
  assign('xzxkmc', `医疗机构${kind}注册`, '由批复标题识别登记类型，导出前请核对事项名称');
  assign('xkXkws', title, 'Word 批复标题（合并换行，不使用文件名替代）');
  assign('xkWsh', number, 'Word 正文发文字号');
  assign('xkXkzs', '医疗机构执业许可证', '正文明确提及《医疗机构执业许可证》');
  if (!all.includes('医疗机构执业许可证')) { data.xkXkzs = ''; delete evidence.xkXkzs; }
  const subjectParagraph = paragraphs.find(line => compact(line).startsWith('你提交的关于')) ?? '';
  const escapedName = originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const subjectCode = compact(subjectParagraph).match(new RegExp(`^你提交的关于${escapedName}[（(]统一社会信用代码[:：]([0-9A-Z]{18})[）)]`))?.[1];
  if (subjectCode) assign('xkXdrShxym', subjectCode, `申请主体段落：${subjectParagraph}`);
  if (!subjectCode && all.includes('设置单位') && all.includes('统一社会信用代码')) warnings.push('文中信用代码属于设置单位/设置主体，未填入申请机构信用代码，请另行核实。');
  const representative = all.match(/法定代表人[:：]([^。；;，,（）()]{2,30})/)?.[1];
  if (representative) assign('xkFrdb', representative, '正文明确标注“法定代表人”');
  else warnings.push('未明确记载法定代表人，未将收文人、机构负责人、业务负责人或业务办理人自动填作法人。');
  const footerStart = paragraphs.findIndex(line => /公开方式[:：]|抄送[:：]/.test(line));
  const main = footerStart >= 0 ? paragraphs.slice(0, footerStart) : paragraphs;
  const signature = main.map((line, index) => ({ line: compact(line), index })).filter(item => /^.{2,35}卫生健康局$/.test(item.line) && !item.line.includes('关于')).at(-1);
  if (signature) {
    assign('xkXkjg', signature.line, '批复落款机关');
    assign('xkLydw', signature.line, '数据来源单位沿用批复落款机关，请核对');
    const date = main.slice(signature.index + 1, signature.index + 4).map(compact).find(line => /^\d{4}年\d{1,2}月\d{1,2}日$/.test(line));
    if (date) {
      const parts = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(date)!;
      const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]), parsed = new Date(Date.UTC(year, month - 1, day));
      if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day) assign('xkJdrq', `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`, `批复落款日期：${date}，非页尾印发日期`);
    }
  }
  const start = paragraphs.findIndex(line => compact(line).startsWith('你提交的关于'));
  const end = paragraphs.findIndex((line, index) => index > start && /^此复[。.]?$/.test(compact(line)));
  const inlineDecision = start >= 0 ? paragraphs[start].match(/经审核[，,](同意.+)$/)?.[1] : undefined;
  assign('xkNr', [inlineDecision ?? '', ...(start >= 0 ? paragraphs.slice(start + 1, end >= 0 ? end : signature?.index) : [])].filter(line => line && !line.includes('此页无正文')).join('\n'), '批复正文核准内容，保留原文，不使用自动摘要');
  warnings.push('许可类别、许可编号、有效期自/止及机关信用代码仅在有明确依据时填写；缺项不会自动用登记号、决定日期或长期日期代替。');
  if (kind === '注销登记') warnings.push('注销批复的当前状态及有效期请按报送口径核定，未自动套用“有效”或写入注销日期。');
  if (renamed) warnings.push(`文书原名称为“${originalName}”，行政相对人暂取变更后的“${renamed}”，请核对报送口径。`);
  return { id, fileName, kind, originalName, sourceText: text, sourceData: { ...data }, data, evidence, warnings, createdAt: Date.now() };
}
