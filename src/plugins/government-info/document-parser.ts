import * as cheerio from 'cheerio';
import JSZip from 'jszip';
import type { ParsedApprovalDocument } from './field-rules';

function nodeText($: cheerio.CheerioAPI, node: Parameters<cheerio.CheerioAPI>[0]): string {
  return $(node).find('w\\:t, w\\:tab, w\\:br, w\\:cr').toArray()
    .map((part) => part.tagName === 'w:t' ? $(part).text() : part.tagName === 'w:tab' ? '\t' : '\n').join('');
}

/** Mirrors the original XWPF paragraph/cell extraction, including trimming. */
export async function parseApprovalDocument(data: Buffer, fileName: string): Promise<ParsedApprovalDocument> {
  if (!/\.docx$/i.test(fileName) && data.subarray(0, 2).toString('hex') !== '504b') {
    throw new Error('当前附件是旧版 DOC，需使用兼容解析器，本条保留原始数据并等待补全');
  }
  const archive = await JSZip.loadAsync(data);
  const documentXml = await archive.file('word/document.xml')?.async('string');
  if (!documentXml) throw new Error('DOCX 附件缺少 word/document.xml');
  const $ = cheerio.load(documentXml, { xmlMode: true });
  const body = $('w\\:body').first();
  const paragraphs = body.children('w\\:p').toArray().map((paragraph) => nodeText($, paragraph).trim()).filter(Boolean);
  const tables = body.children('w\\:tbl').toArray().map((table) => (
    $(table).children('w\\:tr').toArray().map((row) => (
      $(row).children('w\\:tc').toArray().map((cell) => $(cell).children('w\\:p').toArray().map((paragraph) => nodeText($, paragraph)).join('').trim())
    ))
  ));
  return { paragraphs, tables };
}
