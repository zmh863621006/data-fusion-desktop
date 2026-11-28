import { describe, expect, it } from 'vitest';
import { batchCompleteness } from './batch-completeness';

describe('batch completeness metadata', () => {
  it('distinguishes skipped requests from missing rows and preserves unfiltered date semantics', () => {
    const result = batchCompleteness({ taskId: 'test', systemId: 'guangdong-hrss', status: 'completed', skippedRequests: 3,
      dateFiltering: false, startDate: '2026-11-01', endDate: '2026-11-28', batchRowCount: 9 }, 2);
    const values = Object.fromEntries(result.entries);
    expect(values['采集完整性']).toBe('部分完成 / 待补齐');
    expect(values['日期口径']).toContain('未按日期筛选');
    expect(values['跳过请求次数']).toBe(3);
    expect(values['跳过请求说明']).toContain('不能换算为缺失数据条数');
    expect(values['导出范围']).toContain('未包含该批次全部');
    expect(result.warning).toBeTruthy();
  });
  it('does not claim completeness when state is unknown or handling failed', () => {
    expect(batchCompleteness({ taskId: 'test', systemId: 'guangdong-hrss' }, 1).warning).toContain('未提供完整');
    expect(batchCompleteness({ taskId: 'test', systemId: 'guangdong-hrss', status: 'completed' }, 1, 1).warning).toContain('未完成');
    expect(batchCompleteness({ taskId: 'test', systemId: 'guangdong-hrss', status: 'completed' }, 1).warning).toBeUndefined();
  });
  it('distinguishes an empty search from a batch that collected no records', () => {
    const context = { taskId: 'test', systemId: 'guangdong-hrss', status: 'completed', skippedRequests: 1 };
    const filtered = Object.fromEntries(batchCompleteness({ ...context, batchRowCount: 8 }, 0).entries);
    expect(filtered['空表说明']).toContain('当前筛选条件没有匹配记录');
    expect(filtered['空表说明']).not.toContain('本批次未取得');
    const empty = Object.fromEntries(batchCompleteness({ ...context, batchRowCount: 0 }, 0).entries);
    expect(empty['空表说明']).toContain('不代表原系统在所选范围内没有数据');
  });
});
