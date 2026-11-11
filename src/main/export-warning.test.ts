import { describe, expect, it } from 'vitest';
import type { ExportValidation } from '../core/double-publicity/validation';
import { exportWarningOptions } from './export-warning';

function validation(count = 28): ExportValidation {
  return { total: count, checked: count, invalid: count, missingRows: count,
    issues: Array.from({ length: count }, (_, index) => ({ rowNumber: index + 1, recordKey: String(index),
      subject: '超长企业名称'.repeat(100), fields: [{ key: 'xkFrdb', label: '法定代表人', message: '缺少必填字段', sourceKeys: ['xkFrdb'] }] })) };
}

describe('bounded native export confirmation', () => {
  it('summarizes a real-size batch while keeping detailed row names out of the native dialog', () => {
    const options = exportWarningOptions(validation(), 'xlsx');
    expect(options.detail).toContain('法定代表人：28 条');
    expect(options.detail).toContain('整行标红'); expect(options.detail).toContain('批注');
    expect(options.detail).not.toContain('超长企业名称');
    expect(options.buttons).toEqual(['取消，返回补齐', '仍然导出']);
    expect(options.defaultId).toBe(0); expect(options.cancelId).toBe(0);
  });
  it('bounds the dialog even with thousands of records and many very long field labels', () => {
    const input = validation(1000);
    input.issues.forEach(issue => {
      issue.fields = Array.from({ length: 40 }, (_, index) => ({ key: `field-${index}`, label: '超长字段名称'.repeat(30), message: '缺少必填字段', sourceKeys: [] }));
    });
    const options = exportWarningOptions(input, 'xlsx');
    expect(options.detail!.split('\n').length).toBeLessThanOrEqual(6);
    expect(options.detail!.length).toBeLessThan(250);
    expect(options.detail).toContain('另有 36 类字段问题');
  });
  it.each(['csv', 'json'] as const)('retains the format warning for %s', format => {
    expect(exportWarningOptions(validation(), format).detail).toContain('无法保留标红和批注');
  });
});
