import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<unknown>>(), dashboard: vi.fn(async () => ({ count: 1 })), license: vi.fn(async () => ({})) }));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: any) => f.handlers.set(channel, handler) }, BrowserWindow: class {}, session: {} }));
vi.mock('./runtime', () => ({ appRuntime: { hrssDashboard: f.dashboard, requireLicense: f.license } }));
import { registerIpcHandlers } from './ipc';
import { IPC_CHANNELS } from '../core/ipc/channels';
const open = vi.fn(), close = vi.fn(), frame = {};
const event = (id: number, main = true) => ({ sender: { id, mainFrame: frame }, senderFrame: main ? frame : {} });
beforeEach(() => { vi.clearAllMocks(); f.handlers.clear(); registerIpcHandlers(() => 7, { hrssDashboard: { contentsId: () => 9, open, close } }); });
it('allows only the app and its local dashboard main frame to read authorized aggregates', async () => {
  const read = f.handlers.get(IPC_CHANNELS.hrssDashboardGet)!;
  await read(event(7)); await read(event(9)); expect(f.dashboard).toHaveBeenCalledTimes(2);
  for (const unauthorized of [event(8), event(7, false), event(9, false)]) await expect(read(unauthorized)).rejects.toThrow('非受信');
});
it('requires the main window to open a licensed dashboard and allows only the dashboard to close itself', async () => {
  await f.handlers.get(IPC_CHANNELS.hrssDashboardOpen)!(event(7));
  expect(f.license).toHaveBeenCalledWith('guangdong-hrss'); expect(open).toHaveBeenCalledOnce();
  await expect(f.handlers.get(IPC_CHANNELS.hrssDashboardOpen)!(event(9))).rejects.toThrow('非受信');
  await f.handlers.get(IPC_CHANNELS.hrssDashboardClose)!(event(9)); expect(close).toHaveBeenCalledOnce();
  await expect(f.handlers.get(IPC_CHANNELS.hrssDashboardClose)!(event(7))).rejects.toThrow('非看板');
  await expect(f.handlers.get(IPC_CHANNELS.hrssDashboardClose)!(event(9, false))).rejects.toThrow('非看板');
});
