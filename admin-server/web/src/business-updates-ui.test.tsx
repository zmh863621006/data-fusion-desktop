import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { App as AntApp, ConfigProvider } from 'antd';
import { BusinessReleaseDetails, BusinessUpdatesPage } from './BusinessUpdatesPage';
import { UpdatesPage } from './UpdatesPage';
import type { BootstrapData } from './types';
import type { BusinessRelease } from './business-releases';

const data: BootstrapData = { user: { id: 'fixture', username: 'fixture', role: 'admin' }, customers: [], licenses: [], devices: [], systems: [], tools: [], matters: [], updates: [], audits: [] };
const render = (node: React.ReactNode) => renderToStaticMarkup(<ConfigProvider><AntApp>{node}</AntApp></ConfigProvider>);
afterEach(() => vi.unstubAllGlobals());
describe('business version page', () => {
  it('keeps legacy installation management beside business updates and explains startup and offline behavior', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }) });
    const base = render(<UpdatesPage data={data} reload={async () => {}} />); expect(base).toContain('基础安装包'); expect(base).toContain('业务更新包'); expect(base).toContain('上传安装包');
    const business = render(<BusinessUpdatesPage data={data} />); expect(business).toContain('固定 OSS 入口'); expect(business).toContain('离线时允许使用已校验版本');
    expect(business).toContain('确认存在新版后'); expect(business).toContain('Windows 7'); expect(business).toContain('上传业务包');
    expect(render(<BusinessUpdatesPage data={{ ...data, user: { ...data.user!, role: 'viewer' } }} />)).not.toContain('上传业务包</span>');
  });
  it('shows the package-owned migration revision and shell requirement while escaping notes', () => {
    const row: BusinessRelease = { id: 'fixture', version: '1.1.1', target: { platform: 'linux', arch: 'arm64', variant: 'kirin990', electronMajor: 44 }, fileName: 'business-1.1.1.asar', bytes: 1024,
      sha256: 'a'.repeat(64), notes: '<script>合成说明</script>', enabled: true, status: 'published', publishedAt: 1, createdAt: 1, metadata: { minShellVersion: '1.1.0', backend: { origin: 'https://new-backend.example.invalid', revision: 3 } },
      url: 'https://updates.example.invalid/business.asar', feedUrl: 'https://updates.example.invalid/latest.json' };
    const details = render(<BusinessReleaseDetails release={row} />); expect(details).toContain('最低基础版本'); expect(details).toContain('1.1.0'); expect(details).toContain('海思 990');
    expect(details).toContain('地址修订号'); expect(details).toContain('new-backend.example.invalid'); expect(details).toContain('&lt;script&gt;'); expect(details).not.toContain('<script>');
  });
});
