import { describe, expect, it, vi } from 'vitest';
import { queryAllPages } from './runner';
import type { BusinessMatter } from './types';

function matterWithPages(pages: Record<number, number[]>): BusinessMatter<{ id: number }> {
  return {
    id: 'records',
    name: 'Records',
    querySchema: [],
    uniqueKey: ['id'],
    query: vi.fn(async ({ page, pageSize }) => ({
      rows: (pages[page] ?? []).map((id) => ({ id })),
      page,
      pageSize,
      total: -1,
    })),
  };
}

describe('queryAllPages', () => {
  it('accepts a result that completes on the final allowed page', async () => {
    const matter = matterWithPages({ 1: [1, 2], 2: [3] });

    await expect(queryAllPages(matter, { page: 1, pageSize: 2, filters: {} }, { maxPages: 2 }))
      .resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('rejects when every allowed page is full and completion is unknown', async () => {
    const matter = matterWithPages({ 1: [1, 2], 2: [3, 4] });

    await expect(queryAllPages(matter, { page: 1, pageSize: 2, filters: {} }, { maxPages: 2 }))
      .rejects.toThrow('最大分页保护限制');
  });
});
