import { shell } from 'electron';

interface FolderShell {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

/** Call only after ApplicationExportDirectory has validated this exported file. */
export async function openExportFolder(file: string, directory: string, platform = process.platform, desktop: FolderShell = shell): Promise<boolean> {
  try {
    if (platform === 'linux') {
      // FileManager1 highlights the exported file. Peony may keep xdg-open's
      // completion pending for the whole window lifetime, so do not await it.
      desktop.showItemInFolder(file);
    } else if (await desktop.openPath(directory)) throw new Error('Directory could not be opened');
    return true;
  } catch { throw new Error('无法打开导出文件夹，请在文件管理器中手动打开固定导出目录'); }
}
