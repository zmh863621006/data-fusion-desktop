import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<unknown>>(), healthTool: vi.fn(), open: vi.fn(), save: vi.fn(), update: vi.fn(), state: vi.fn(), importFiles: vi.fn(), audit: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, ipcMain: { handle: (key: string, handler: (...args: any[]) => Promise<unknown>) => f.handlers.set(key, handler) }, dialog: { showOpenDialog: f.open, showSaveDialog: f.save } }));
vi.mock('./runtime', () => ({ appRuntime: { healthTool: f.healthTool, audit: f.audit, currentGrant: vi.fn(async () => ({ allowExport: true })) } }));
import { registerIpcHandlers } from './ipc';
import { IPC_CHANNELS } from '../core/ipc/channels';
const frame = {}, event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame };
describe('health tool main-process security boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); f.handlers.clear(); f.healthTool.mockResolvedValue({ state: f.state, importFiles: f.importFiles, update: f.update }); registerIpcHandlers(() => 7); });
  it.each([IPC_CHANNELS.healthToolState, IPC_CHANNELS.healthToolImport, IPC_CHANNELS.healthToolUpdate, IPC_CHANNELS.healthToolSettings, IPC_CHANNELS.healthToolRemove, IPC_CHANNELS.healthToolExport])('rejects untrusted frames on %s before touching files or data', async channel => {
    await expect(f.handlers.get(channel)!({ ...event, senderFrame: {} })).rejects.toThrow('非受信');
    expect(f.healthTool).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
  it('enforces tool license before offering a file picker', async () => {
    f.healthTool.mockRejectedValue(new Error('LICENSE_TOOL_DENIED'));
    await expect(f.handlers.get(IPC_CHANNELS.healthToolImport)!(event)).rejects.toThrow('LICENSE_TOOL_DENIED');
    expect(f.open).not.toHaveBeenCalled();
  });
  it('imports only the native picker selection, never caller-supplied paths', async () => {
    f.open.mockResolvedValue({ canceled: false, filePaths: ['approved.docx'] });
    f.importFiles.mockResolvedValue({ added: 1, duplicates: 0, errors: [] });
    await f.handlers.get(IPC_CHANNELS.healthToolImport)!(event, ['secret.txt']);
    expect(f.importFiles).toHaveBeenCalledExactlyOnceWith(['approved.docx']);
  });
});
