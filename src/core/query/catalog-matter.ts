import type { BusinessMatter } from './types';
import { rejectUnavailableMatterQuery } from './validation';

type CatalogMatter = Pick<BusinessMatter, 'id' | 'name' | 'departmentId' | 'departmentName' | 'departmentOrder' | 'matterOrder'>;

export function createCatalogMatter(metadata: CatalogMatter, now = Date.now): BusinessMatter {
  return {
    ...metadata,
    executionMode: 'one-click-return',
    queryAvailable: false,
    querySchema: [
      { key: 'startDate', label: '开始日期', type: 'date', required: true },
      { key: 'endDate', label: '结束日期', type: 'date', required: true },
    ],
    uniqueKey: ['recordKey'],
    listColumns: [],
    createDefaultContext() {
      const today = new Date(now() + 8 * 3_600_000).toISOString().slice(0, 10);
      return { page: 1, pageSize: 200, filters: { startDate: today.slice(0, 7) + '-01', endDate: today } };
    },
    async query() { return rejectUnavailableMatterQuery(); },
  };
}
