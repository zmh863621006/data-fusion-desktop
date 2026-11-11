import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ shell: {} }));
import { openExportFolder } from './export-folder';

describe('native export folder integration', () => {
  it('reveals the validated Linux export without waiting for the file manager window to exit', async () => {
    const desktop = { openPath: vi.fn(() => new Promise<string>(() => {})), showItemInFolder: vi.fn() };
    expect(await openExportFolder('/home/test/文档/行政许可.xlsx', '/home/test/文档', 'linux', desktop)).toBe(true);
    expect(desktop.showItemInFolder).toHaveBeenCalledExactlyOnceWith('/home/test/文档/行政许可.xlsx');
    expect(desktop.openPath).not.toHaveBeenCalled();
  });
  it('preserves the Windows open-directory behavior and reports native failures', async () => {
    const desktop = { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() };
    expect(await openExportFolder('C:\\Exports\\许可.xlsx', 'C:\\Exports', 'win32', desktop)).toBe(true);
    expect(desktop.openPath).toHaveBeenCalledExactlyOnceWith('C:\\Exports');
    desktop.openPath.mockResolvedValueOnce('native error');
    await expect(openExportFolder('C:\\Exports\\许可.xlsx', 'C:\\Exports', 'win32', desktop)).rejects.toThrow('无法打开导出文件夹');
  });
});
