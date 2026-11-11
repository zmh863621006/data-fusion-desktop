import { posix, win32 } from 'node:path';

interface ExportPaths {
  platform: NodeJS.Platform;
  packaged: boolean;
  executablePath: string;
  appPath: string;
  documentsPath: string;
}

/** System-wide Linux installations are read-only to the desktop user. */
export function applicationExportDirectory(paths: ExportPaths): string {
  if (paths.platform === 'linux') return posix.join(paths.documentsPath, '数据融合助手', '导出文件');
  const path = paths.platform === 'win32' ? win32 : posix;
  return path.join(paths.packaged ? path.dirname(paths.executablePath) : paths.appPath, '导出文件');
}
