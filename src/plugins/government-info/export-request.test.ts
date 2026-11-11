import { describe, expect, it } from 'vitest';
import { buildExportParameters } from './export-request';

describe('government information export request', () => {
  it('uses the captured completion-date bounds within the four-parameter export contract', () => {
    const parameters = JSON.parse(buildExportParameters('2026-10-01', '2026-11-03')) as string[];
    expect(parameters).toHaveLength(4);
    const query = JSON.parse(parameters[0]) as Record<string, unknown>;
    expect(query.parameters).toEqual([
      { name: 'bj_bjsj', value: '2026-10-01', flag: 16, sqlType: 93 },
      { name: 'bj_bjsj', value: '2026-11-03', flag: 17, sqlType: 93 },
    ]);
    expect(query.pageSize).toBe(-9999);
    expect(query.toCount).toBe(false);
    expect(query.fields).toHaveLength(1);
    expect(JSON.parse(parameters[1])).toHaveLength(15);
    expect(parameters.slice(2)).toEqual(['ecs_searchAll', '综合业务窗口材料交接登记表']);
  });
  it('retains timestamp typing when only a diagnostic lower bound is supplied', () => {
    expect(JSON.parse(JSON.parse(buildExportParameters('2026-10-01'))[0]).parameters)
      .toEqual([{ name: 'bj_bjsj', value: '2026-10-01', flag: 16, sqlType: 93 }]);
  });
});
