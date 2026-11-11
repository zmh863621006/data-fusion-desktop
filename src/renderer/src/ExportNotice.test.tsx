import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ExportNotice, revealExportFolder } from './ExportNotice';

describe('administrative permit export notice', () => {
  const result = { path: 'C:\\数据融合助手\\导出文件\\行政许可-大件运输-2026-10-01至2026-10-20.xlsx', rowCount: 90 };

  it('shows the exact full path as a keyboard accessible folder button and announces the exported count', () => {
    const html = renderToStaticMarkup(<ExportNotice result={result} />);
    expect(html).toContain('已导出 90 条数据');
    expect(html).toContain('role="status"');
    expect(html).toContain('type="button"');
    expect(html).toContain(`aria-label="打开文件所在文件夹：${result.path}"`);
    expect(html).toContain(`>${result.path}</button>`);
    expect(html).toContain('点击路径打开文件所在文件夹');
    expect(html).not.toContain('href="file:');
    expect(html).not.toContain('存在填写问题');
  });

  it('preserves the red-row and cell-comment warning separately from the success summary', () => {
    const html = renderToStaticMarkup(<ExportNotice result={{ ...result, warningCount: 7 }} />);
    expect(html).toContain('class="export-notice-warning"');
    expect(html).toContain('其中 7 条存在填写问题，已整行标红，请核对单元格批注。');
    expect(html).toContain('已导出 90 条数据');
  });

  it('escapes path text instead of interpreting it as HTML or a remote navigation target', () => {
    const html = renderToStaticMarkup(<ExportNotice result={{ path: 'C:\\导出\\<script>&许可.xlsx', rowCount: 1 }} />);
    expect(html).toContain('&lt;script&gt;&amp;许可.xlsx');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href=');
  });

  it('requests only the completed export path and treats true as successful folder opening', async () => {
    const opener = vi.fn().mockResolvedValue(true);
    await expect(revealExportFolder(result.path, opener)).resolves.toBe('');
    expect(opener).toHaveBeenCalledExactlyOnceWith(result.path);
  });

  it('shows a recoverable message when folder opening fails without pretending that export failed', async () => {
    await expect(revealExportFolder(result.path, vi.fn().mockResolvedValue(false))).resolves.toBe('未能打开文件夹，请确认文件仍存在后重试。');
    await expect(revealExportFolder(result.path, vi.fn().mockRejectedValue(new Error('IPC unavailable')))).resolves.toBe('打开文件夹失败，请稍后重试。文件已成功导出。');
  });
});
