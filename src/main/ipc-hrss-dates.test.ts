import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  run: vi.fn(async (_name: unknown, _executor: unknown, _metadata: unknown) => ({ id: 'date-test', status: 'completed', result: { total: 0 } })),
  requireLicense: vi.fn(async () => ({})), audit: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {},
  ipcMain: { handle: (channel: string, handler: any) => f.handlers.set(channel, handler) } }));
vi.mock('./runtime', () => ({ appRuntime: { plugins: { get: () => plugin }, requireLicense: f.requireLicense, tasks: { run: f.run }, audit: f.audit } }));
import { createGuangdongHrssPlugin } from '../plugins/guangdong-hrss';
import { registerIpcHandlers } from './ipc';
import { IPC_CHANNELS } from '../core/ipc/channels';
const plugin = createGuangdongHrssPlugin({ now: () => Date.parse('2026-11-05T01:00:00Z') });
const frame = {}, event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame };
beforeEach(() => { vi.clearAllMocks(); f.handlers.clear(); registerIpcHandlers(() => 7); });

it('serializes both date controls and explicit integration status for every authorized HRSS matter', async () => {
  const matters = await f.handlers.get(IPC_CHANNELS.mattersList)!(event, 'guangdong-hrss');
  expect(matters).toHaveLength(18); expect(() => structuredClone(matters)).not.toThrow();
  expect(matters.every((matter: any) => matter.querySchema.length === 2 && matter.dateFilter)).toBe(true);
  expect(matters.filter((matter: any) => matter.dateFilter.mode === 'pending')).toHaveLength(17);
});

it('saves pending selected dates separately from effective remote ranges for all 18 tasks', async () => {
  for (const matter of plugin.matters) {
    await f.handlers.get(IPC_CHANNELS.matterRun)!(event, plugin.id, matter.id, { page: 1, pageSize: 200,
      filters: { startDate: '2026-10-01', endDate: '2026-10-31' } });
    const metadata = f.run.mock.lastCall![2] as { details: Record<string, unknown> };
    expect(metadata.details).toMatchObject({ requestedStartDate: '2026-10-01', requestedEndDate: '2026-10-31' });
    if (matter.id === 'unemployment') expect(metadata.details).toMatchObject({ dateFilterStatus: 'applied', startDate: '2026-10-01', endDate: '2026-10-31' });
    else {
      expect(metadata.details.dateFilterStatus).toBe('pending');
      expect(metadata.details).not.toHaveProperty('startDate'); expect(metadata.details).not.toHaveProperty('endDate');
    }
  }
});

it('rejects bad date ranges and caller-supplied integration flags before creating a task', async () => {
  const run = f.handlers.get(IPC_CHANNELS.matterRun)!;
  for (const filters of [
    { startDate: '2026-11-05', endDate: '2026-11-01' }, { startDate: '2026-02-30', endDate: '2026-03-01' },
    { startDate: '2026-11-01', endDate: '2026-11-05', dateFilterStatus: 'applied' },
  ]) await expect(run(event, plugin.id, 'job-seeking-startup-subsidy', { page: 1, pageSize: 200, filters })).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
