import { beforeEach, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../core/ipc/channels';
import { registerIpcHandlers } from './ipc';

const f = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<unknown>>(),
  taskPage: vi.fn(), cancelTask: vi.fn(), requireLicense: vi.fn(), query: vi.fn(), run: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {},
  ipcMain: { handle: (key: string, handler: (...args: any[]) => Promise<unknown>) => f.handlers.set(key, handler) },
}));
vi.mock('./runtime', () => ({ appRuntime: {
  taskPage: f.taskPage, cancelTask: f.cancelTask, requireLicense: f.requireLicense, tasks: { run: f.run },
  plugins: { get: () => ({ name: '原系统', matters: [{ id: 'item', query: f.query, querySchema: [] }] }) },
} }));

const frame = {}, event = { sender: { id: 9, mainFrame: frame }, senderFrame: frame };
beforeEach(() => {
  vi.clearAllMocks(); f.handlers.clear(); registerIpcHandlers(() => 9);
});

it('routes both history APIs and task cancellation through the scoped runtime', async () => {
  f.taskPage.mockResolvedValue({ rows: [{ id: 'allowed' }], total: 1 });
  expect(await f.handlers.get(IPC_CHANNELS.tasksList)!(event)).toEqual([{ id: 'allowed' }]);
  expect(f.taskPage).toHaveBeenCalledWith({ pageSize: 100 });
  const query = { systemId: 'system', matterId: 'item', completedBatches: true, page: 3, pageSize: 50 };
  expect(await f.handlers.get(IPC_CHANNELS.tasksPage)!(event, query)).toMatchObject({ total: 1 });
  expect(f.taskPage).toHaveBeenCalledWith(expect.objectContaining(query));
  await f.handlers.get(IPC_CHANNELS.taskCancel)!(event, 'allowed');
  expect(f.cancelTask).toHaveBeenCalledExactlyOnceWith('allowed');
});

it('rejects untrusted senders and caller-controlled access scopes before reading task history', async () => {
  const read = f.handlers.get(IPC_CHANNELS.tasksPage)!;
  await expect(read({ ...event, senderFrame: {} }, {})).rejects.toThrow('非受信');
  for (const query of [{ accessScopes: [] }, { matterId: 'orphan' }, { completedBatches: 'yes' }, { page: 0 }]) {
    await expect(read(event, query)).rejects.toThrow();
  }
  expect(f.taskPage).not.toHaveBeenCalled();
});

it('rechecks the license before a queued remote query reaches the source system', async () => {
  f.requireLicense.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('授权已收回'));
  f.run.mockImplementationOnce((_name, execute) => execute({ signal: new AbortController().signal, report: vi.fn() }));
  await expect(f.handlers.get(IPC_CHANNELS.matterQuery)!(event, 'system', 'item', { page: 1, pageSize: 20, filters: {} }))
    .rejects.toThrow('授权已收回');
  expect(f.requireLicense).toHaveBeenCalledTimes(2);
  expect(f.query).not.toHaveBeenCalled();
});
