import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));
import { AppRuntime } from './runtime';

describe.each(['batch', 'ledger'])('%s export limit', source => {
  it.each([50_000, 50_001])('checks the full filtered count of %i before writing', async total => {
    const runtime = new AppRuntime();
    const task = { id: 'fixture', type: 'data-return', systemId: 'government-info', matterId: 'fixture-matter', createdAt: 1 };
    const pageRows = vi.fn((page: number, size: number) => ({
      total, rows: Array.from({ length: Math.min(size, total - (page - 1) * size) }, (_, index) => ({
        systemId: task.systemId, matterId: task.matterId, recordKey: String((page - 1) * size + index + 1), data: {},
      })),
    }));
    const exportRecords = vi.fn(async (rows: Array<{ recordKey: string }>) => ({ count: rows.length, last: rows.at(-1)?.recordKey }));
    Object.assign(runtime, {
      currentGrant: async () => ({ allowExport: true }), requireLicense: async () => {}, exportRecords,
      platformStore: { getTask: async () => task,
        listRecords: async (query: { page: number; pageSize: number }) => pageRows(query.page, query.pageSize),
        listTaskOutput: async (_id: string, page: number, size: number) => pageRows(page, size) },
    });
    const result = source === 'ledger' ? runtime.exportLocalRecords({ systemId: task.systemId, matterId: task.matterId }, undefined, 'xlsx') : runtime.exportTaskOutput(task.id);
    if (total === 50_000) {
      await expect(result).resolves.toEqual({ count: total, last: String(total) });
      expect(pageRows).toHaveBeenCalledTimes(250);
    } else {
      await expect(result).rejects.toThrow('不能超过 50000 条');
      expect(exportRecords).not.toHaveBeenCalled();
      expect(pageRows).toHaveBeenCalledTimes(1);
    }
  });
});
