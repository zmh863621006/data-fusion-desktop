import { describe, expect, it, vi } from 'vitest';
import {
  buildBusinessQueryPayload,
  queryBusinessApplications,
  type MarketAccessQueryTransport,
} from './query';

describe('market access business application query', () => {
  it('maps UI filters to the remote query contract', () => {
    const payload = buildBusinessQueryPayload({
      page: 2,
      pageSize: 50,
      filters: {
        subjectName: '示例企业',
        applyDate: ['2026-09-01', '2026-09-15'],
        subjectCategories: ['id', 'nmzyhzs'],
      },
    }) as { commonApplyList: { _paging: Record<string, string>; _condition: Record<string, unknown> } };

    expect(payload.commonApplyList._paging).toEqual({ pageNo: '2', pageSize: '50', total: '' });
    expect(payload.commonApplyList._condition).toMatchObject({
      subjectName: '示例企业',
      startappdate: '2026-09-01',
      endappdate: '2026-09-15',
      cp: false,
      id: true,
      catids: 'id',
      enttypes: '9100',
    });
  });

  it('requires at least one meaningful query filter', () => {
    expect(() => buildBusinessQueryPayload({ page: 1, pageSize: 50, filters: {} }))
      .toThrow('至少输入一个查询条件');
  });

  it('normalizes the remote page response', async () => {
    const post = vi.fn(async (_path: string, _body: unknown) => ({
      commonApplyList: {
        _data: [{ applyno: 'A-1', subjectname: '示例企业' }],
        _paging: { pageNo: '1', pageSize: '50', total: 1 },
      },
    }));
    const transport: MarketAccessQueryTransport = {
      post: async <T>(path: string, body: unknown) => await post(path, body) as T,
    };

    await expect(queryBusinessApplications(transport, {
      page: 1, pageSize: 50, filters: { applyno: 'A-1' },
    })).resolves.toEqual({
      rows: [{ applyno: 'A-1', subjectname: '示例企业' }],
      page: 1,
      pageSize: 50,
      total: 1,
    });
    expect(post).toHaveBeenCalledWith('/common/solrInfoQuery/getApplyProcessList.do', expect.any(Object));
  });
});
