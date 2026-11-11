import { describe, expect, it } from 'vitest';
import { applicationExportDirectory } from './platform-paths';

describe('platform export destination', () => {
  it('uses the desktop documents directory outside the Linux installation', () => {
    expect(applicationExportDirectory({ platform: 'linux', packaged: true, executablePath: '/opt/数据融合助手/data-fusion',
      appPath: '/opt/数据融合助手/resources/app.asar', documentsPath: '/home/test/Documents' }))
      .toBe('/home/test/Documents/数据融合助手/导出文件');
  });
  it('preserves the Windows export destination for installed and development applications', () => {
    const paths = { platform: 'win32' as const, packaged: true, executablePath: 'C:\\Apps\\DataFusion\\DataFusion.exe',
      appPath: 'C:\\Code\\data-fusion-desktop', documentsPath: 'C:\\Users\\test\\Documents' };
    expect(applicationExportDirectory(paths)).toBe('C:\\Apps\\DataFusion\\导出文件');
    expect(applicationExportDirectory({ ...paths, packaged: false })).toBe('C:\\Code\\data-fusion-desktop\\导出文件');
  });
});
