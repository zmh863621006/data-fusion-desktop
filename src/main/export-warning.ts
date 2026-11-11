import type { MessageBoxOptions } from 'electron';
import type { ExportValidation } from '../core/double-publicity/validation';

/** GTK message boxes do not scroll long detail text. Keep every action visible. */
export function exportWarningOptions(validation: ExportValidation, format: 'xlsx' | 'csv' | 'json'): MessageBoxOptions {
  const fields = new Map<string, { label: string; count: number }>();
  for (const issue of validation.issues) {
    const seen = new Set<string>();
    for (const field of issue.fields) {
      if (seen.has(field.key)) continue;
      seen.add(field.key);
      const entry = fields.get(field.key) ?? { label: [...field.label.replace(/\s+/g, ' ')].slice(0, 24).join(''), count: 0 };
      entry.count += 1;
      fields.set(field.key, entry);
    }
  }
  const summary = [...fields.values()].sort((a, b) => b.count - a.count);
  const detail = summary.slice(0, 4).map(field => `${field.label}：${field.count} 条`);
  if (summary.length > 4) detail.push(`另有 ${summary.length - 4} 类字段问题。`);
  detail.push(format === 'xlsx'
    ? '继续导出后，问题记录整行标红，完整原因保留在单元格批注中。'
    : 'CSV/JSON 无法保留标红和批注，建议选择 Excel 导出以查看逐条说明。');
  return { type: 'warning', title: '双公示导出校验提醒',
    message: `共 ${validation.total} 条，其中 ${validation.missingRows} 条缺少必填字段，合计 ${validation.invalid} 条需要核对。`,
    detail: detail.join('\n'), buttons: ['取消，返回补齐', '仍然导出'], defaultId: 0, cancelId: 0, noLink: true };
}
