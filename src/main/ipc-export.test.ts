import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<unknown>>(),
  save: vi.fn(), openPath: vi.fn(), reveal: vi.fn(), folder: vi.fn(), task: vi.fn(), records: vi.fn(), health: vi.fn(),
  audit: vi.fn(), currentGrant: vi.fn(), healthTool: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {},
  ipcMain: { handle: (key: string, handler: (...args: any[]) => Promise<unknown>) => f.handlers.set(key, handler) },
  dialog: { showSaveDialog: f.save }, shell: { openPath: f.openPath, showItemInFolder: f.reveal },
}));
vi.mock('./runtime', () => ({ appRuntime: { exportTaskOutput: f.task, exportLocalRecords: f.records,
  exportHealthDocuments: f.health, exportFolder: f.folder, audit: f.audit, currentGrant: f.currentGrant, healthTool: f.healthTool,
  tasks: { run: async (_name: string, action: () => Promise<unknown>) => ({ status: 'completed', id: 'export-test', result: await action() }) },
} }));
import { registerIpcHandlers } from './ipc';
import { IPC_CHANNELS } from '../core/ipc/channels';
const frame = {}, event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame };
const result = { path: 'controlled-export.xlsx', rowCount: 1, createdAt: 1 };
beforeEach(() => {
  vi.clearAllMocks(); f.handlers.clear();
  f.task.mockResolvedValue(result); f.records.mockResolvedValue(result); f.health.mockResolvedValue(result);
  f.currentGrant.mockResolvedValue({ allowExport: true }); f.healthTool.mockResolvedValue({});
  f.folder.mockResolvedValue('validated-folder'); f.openPath.mockResolvedValue('');
  registerIpcHandlers(() => 7);
});

describe('managed export IPC', () => {
  it('all business export entries use a native-controlled destination without a save picker', async () => {
    await f.handlers.get(IPC_CHANNELS.taskOutputExport)!(event, 'batch-1', '搜索');
    expect(f.task).toHaveBeenCalledWith('batch-1', undefined, '搜索', expect.any(Function), undefined);
    await f.handlers.get(IPC_CHANNELS.recordsExport)!(event, { systemId: 'oversize-transport' }, 'xlsx');
    expect(f.records).toHaveBeenCalledWith({ systemId: 'oversize-transport' }, undefined, 'xlsx', expect.any(Function), undefined);
    await f.handlers.get(IPC_CHANNELS.healthToolExport)!(event, ['a'.repeat(64)]);
    expect(f.health).toHaveBeenCalledWith(['a'.repeat(64)], undefined, expect.any(Function));
    expect(f.save).not.toHaveBeenCalled();
  });
  it.each([IPC_CHANNELS.taskOutputExport, IPC_CHANNELS.recordsExport, IPC_CHANNELS.healthToolExport, IPC_CHANNELS.exportsOpenFolder])('blocks foreign frames on %s before files or exports', async channel => {
    await expect(f.handlers.get(channel)!({ ...event, senderFrame: {} })).rejects.toThrow('非受信');
    expect(f.folder).not.toHaveBeenCalled(); expect(f.openPath).not.toHaveBeenCalled(); expect(f.reveal).not.toHaveBeenCalled(); expect(f.task).not.toHaveBeenCalled();
  });
  it('validates exported files before opening a directory and reports OS failures', async () => {
    expect(await f.handlers.get(IPC_CHANNELS.exportsOpenFolder)!(event, result.path)).toBe(true);
    expect(f.folder).toHaveBeenCalledExactlyOnceWith(result.path);
    if (process.platform === 'linux') expect(f.reveal).toHaveBeenCalledExactlyOnceWith(result.path);
    else expect(f.openPath).toHaveBeenCalledExactlyOnceWith('validated-folder');
    f.folder.mockRejectedValueOnce(new Error('不是本次导出的文件'));
    await expect(f.handlers.get(IPC_CHANNELS.exportsOpenFolder)!(event, 'C:/Windows')).rejects.toThrow('不是本次导出');
    if (process.platform === 'linux') {
      expect(f.reveal).toHaveBeenCalledTimes(1);
      f.reveal.mockImplementationOnce(() => { throw new Error('denied'); });
    } else {
      expect(f.openPath).toHaveBeenCalledTimes(1);
      f.openPath.mockResolvedValueOnce('denied');
    }
    await expect(f.handlers.get(IPC_CHANNELS.exportsOpenFolder)!(event, result.path)).rejects.toThrow('无法打开导出文件夹');
  });
  it('returns cancellation without registering a successful audit', async () => {
    f.records.mockResolvedValueOnce(null);
    expect(await f.handlers.get(IPC_CHANNELS.recordsExport)!(event, {}, 'xlsx')).toBeNull();
    expect(f.audit).not.toHaveBeenCalled();
  });
  it.each(['guangdong-law', 'nanshan'])('forwards %s for batch and ledger exports, records the chosen template and rejects unknown templates', async target => {
    await f.handlers.get(IPC_CHANNELS.taskOutputExport)!(event, 'batch-1', '搜索', target);
    expect(f.task).toHaveBeenCalledWith('batch-1', undefined, '搜索', expect.any(Function), target);
    await f.handlers.get(IPC_CHANNELS.recordsExport)!(event, { systemId: 'government-info' }, 'xlsx', target);
    expect(f.records).toHaveBeenCalledWith({ systemId: 'government-info' }, undefined, 'xlsx', expect.any(Function), target);
    expect(f.audit).toHaveBeenCalledWith('export.created', undefined, undefined, 'export-test', expect.objectContaining({ target }));
    f.records.mockClear(); f.task.mockClear();
    await expect(f.handlers.get(IPC_CHANNELS.taskOutputExport)!(event, 'batch-1', undefined, '../../template.xlsx')).rejects.toThrow('模板无效');
    await expect(f.handlers.get(IPC_CHANNELS.recordsExport)!(event, {}, 'xlsx', {})).rejects.toThrow('模板无效');
    expect(f.records).not.toHaveBeenCalled(); expect(f.task).not.toHaveBeenCalled();
  });
});
