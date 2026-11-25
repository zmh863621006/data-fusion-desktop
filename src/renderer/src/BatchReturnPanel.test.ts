import { describe, expect, it } from 'vitest';
import { buildBatchReturnPayload, type BatchReturnMatter } from './BatchReturnPanel';

const dates = [{ key: 'startDate', label: '开始日期', type: 'date' as const, required: true }, { key: 'endDate', label: '结束日期', type: 'date' as const, required: true }];
const matters: BatchReturnMatter[] = [
  { id: 'first', name: '第一业务', executionMode: 'one-click-return', querySchema: [...dates, { key: 'kind', label: '类型', type: 'select', required: true, options: [{ label: '第一类', value: 1 }] }], defaultFilters: { kind: 1, unrelated: 'must-be-dropped' } },
  { id: 'second', name: '第二业务', executionMode: 'one-click-return', querySchema: [...dates, { key: 'tags', label: '标签', type: 'multi-select', options: [{ label: '甲', value: 'a' }, { label: '乙', value: 'b' }] }], defaultFilters: { tags: ['a'] } },
];

describe('批量回流提交快照', () => {
  it('uses the shared dates and each matter own defaults, without copying unrelated or unselected fields', () => {
    const payload = buildBatchReturnPayload(matters, new Set(['first', 'second', 'unlicensed']), '2026-11-10', '2026-11-25', {});
    expect(payload).toEqual({ matterIds: ['first', 'second'], startDate: '2026-11-10', endDate: '2026-11-25', filtersByMatter: { first: { kind: 1 }, second: { tags: ['a'] } } });
  });
  it('copies array values so later edits cannot change an already submitted batch', () => {
    const chosen = ['b'];
    const payload = buildBatchReturnPayload(matters, new Set(['second']), '2026-11-01', '2026-11-25', { second: { tags: chosen } });
    chosen.push('a');
    expect(payload.filtersByMatter?.second.tags).toEqual(['b']);
    expect(payload.matterIds).toEqual(['second']);
  });
  it('names the matter whose additional required selection is missing', () => {
    expect(() => buildBatchReturnPayload(matters, new Set(['first']), '2026-11-01', '2026-11-25', { first: { kind: '' } })).toThrow('第一业务：类型不能为空');
  });
  it.each([['2026-02-30', '2026-03-01'], ['2026-11-26', '2026-11-25'], ['', '2026-11-25']])('rejects an invalid shared date interval %s to %s', (start, end) => {
    expect(() => buildBatchReturnPayload(matters, new Set(['first']), start, end, {})).toThrow('请选择有效');
  });
  it('does not create an empty batch', () => {
    expect(() => buildBatchReturnPayload(matters, new Set(), '2026-11-01', '2026-11-25', {})).toThrow('至少选择');
  });
});
