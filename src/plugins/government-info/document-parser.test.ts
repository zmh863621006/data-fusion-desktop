import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseApprovalDocument } from './document-parser';

describe('government approval document parser', () => {
  it('preserves body paragraphs and table cell positions from DOCX', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>段落一</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>单元格A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>单元格B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`);
    const data = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(parseApprovalDocument(data, '决定书.docx')).resolves.toEqual({
      paragraphs: ['段落一'], tables: [[['单元格A', '单元格B']]],
    });
  });

  it('does not guess table positions for legacy DOC files', async () => {
    await expect(parseApprovalDocument(Buffer.from('legacy'), '决定书.doc')).rejects.toThrow('旧版 DOC');
  });
});
