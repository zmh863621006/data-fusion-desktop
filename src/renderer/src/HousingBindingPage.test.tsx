import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HousingBindingApi, HousingBindingJob, HousingImportPreview } from '../../core/housing-binding/types';
import { HousingBindingCounts, HousingBindingPage, HousingBindingResultTable, HousingImportSummary, housingImportCanSubmit, housingJobCanRetry, housingJobIsActive, housingJobLabel } from './HousingBindingPage';

const job: HousingBindingJob = { id: 'job-1', taskId: 'task-1', acceptanceNumber: 'TEST-ACCEPTANCE', certificateNumber: '测试产权证', fileName: '测试房屋.xlsx', phase: 'completed', total: 3, succeeded: 1, skipped: 1, failed: 1, pending: 0, createdAt: 1, updatedAt: 2, error: null, parentJobId: null };
const preview: HousingImportPreview = { importId: 'preview-1', fileName: '测试房屋.xlsx', totalRows: 4, validCount: 3, duplicateCount: 1, codes: [{ rowNumber: 2, code: '00123456' }, { rowNumber: 3, code: '001234567890123456' }, { rowNumber: 5, code: '00123456789012345678901234567890' }], issues: [] };
const callbacks = { onLogin() {} };
const api = {} as HousingBindingApi;

describe('housing binding task presentation', () => {
  it('provides the acceptance/certificate/workbook form with no return-date or publicity workflow', () => {
    const html = renderToStaticMarkup(<HousingBindingPage {...callbacks} api={api} sessionStatus="logged-out" />);
    for (const text of ['受理编号', '产权证号', '上传 Excel', '下载模板', '创建自动绑定任务', '完整房屋编码', '按文本格式填写，保留前导零', '登录房屋租赁系统']) expect(html).toContain(text);
    expect(html).not.toMatch(/type="date"|双公示|开始数据回流|确认写入本页/);
    expect(html).toMatch(/type="submit"[^>]*disabled=""/);
  });

  it('keeps the same form on the workbench and provides an entry to its complete task workspace', () => {
    const html = renderToStaticMarkup(<HousingBindingPage {...callbacks} api={api} sessionStatus="authenticated" compact onOpenWorkspace={() => {}} />);
    expect(html).toContain('housing-binding-compact'); expect(html).toContain('最近绑定任务'); expect(html).toContain('全部任务');
    expect(html).toContain('原系统已登录'); expect(html).not.toContain('登录房屋租赁系统');
    expect(html).toMatch(/type="submit"[^>]*disabled=""/);
  });

  it('reports duplicate removal and keeps full text codes without converting them to numbers', () => {
    const html = renderToStaticMarkup(<HousingImportSummary preview={preview} />);
    expect(html).toContain('有效编码 3 条'); expect(html).toContain('已去重 1 条'); expect(html).toContain(preview.codes[0].code);
    expect(housingImportCanSubmit(preview)).toBe(true);
    expect(housingImportCanSubmit(null)).toBe(false);
    expect(housingImportCanSubmit({ ...preview, validCount: 0 })).toBe(false);
  });

  it('accepts and displays complete codes with different lengths and leading zeros', () => {
    expect(housingImportCanSubmit(preview)).toBe(true);
    const rows = preview.codes.map(row => ({ ...row, status: 'pending' as const, message: '', updatedAt: 1 }));
    const html = renderToStaticMarkup(<HousingBindingResultTable rows={rows} />);
    for (const row of rows) expect(html).toContain(row.code);
    expect(new Set(rows.map(row => row.code.length)).size).toBe(3);
  });

  it('blocks an invalid workbook and safely renders validation text and file names', () => {
    const invalid = { ...preview, fileName: '<script>name</script>.xlsx', issues: [{ rowNumber: 4, message: '<img src=x onerror=alert(1)>' }] };
    const html = renderToStaticMarkup(<HousingImportSummary preview={invalid} />);
    expect(housingImportCanSubmit(invalid)).toBe(false);
    expect(html).toContain('第 4 行'); expect(html).toContain('请修正'); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img');
  });

  it('shows successful, skipped, failed and confirmed zero counts separately', () => {
    const html = renderToStaticMarkup(<HousingBindingCounts job={job} />);
    for (const label of ['房屋总数', '绑定成功', '已绑定跳过', '失败／待核对', '待处理']) expect(html).toContain(`<dt>${label}</dt>`);
    expect(html).toContain('<dd>0</dd>'); expect(html).toContain('housing-count-failed');
    expect(renderToStaticMarkup(<HousingBindingCounts job={{ ...job, failed: 0 }} />)).not.toContain('housing-count-failed');
  });

  it('distinguishes unknown write outcomes from confirmed failures and preserves safe messages', () => {
    const html = renderToStaticMarkup(<HousingBindingResultTable rows={[
      { rowNumber: 2, code: preview.codes[0].code, status: 'already-bound', message: '原系统已有关联', updatedAt: 1 },
      { rowNumber: 3, code: '4403051234567890123456788', status: 'unknown', message: '<script>write response</script>', updatedAt: 1 },
    ]} />);
    expect(html).toContain('已绑定，跳过'); expect(html).toContain('结果待核对'); expect(html).toContain('原系统已有关联');
    expect(html).toContain('&lt;script&gt;write response'); expect(html).not.toContain('<script>'); expect(html).toContain(preview.codes[0].code);
  });

  it('permits retries only for non-active tasks with unfinished work or an interrupted run', () => {
    for (const phase of ['queued', 'running', 'waiting-login'] as const) {
      expect(housingJobIsActive({ phase })).toBe(true);
      expect(housingJobCanRetry({ ...job, phase })).toBe(false);
    }
    expect(housingJobLabel('waiting-login')).toBe('等待重新登录');
    expect(housingJobCanRetry(job)).toBe(true);
    expect(housingJobCanRetry({ ...job, failed: 0 })).toBe(false);
    expect(housingJobCanRetry({ ...job, failed: 0, phase: 'interrupted' })).toBe(true);
  });
});
