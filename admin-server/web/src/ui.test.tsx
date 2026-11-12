import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { App as AntApp, ConfigProvider } from 'antd';
import { AdminShell, LoginPage } from './App';
import { ApiError } from './api';
import type { BootstrapData } from './types';
import { ReleaseDetails, ReleaseTargetPicker, UpdatesPage } from './UpdatesPage';

const emptyData: BootstrapData = {
  user: { id: 'test-admin', username: 'test-admin', role: 'admin' },
  customers: [], licenses: [], devices: [], systems: [], tools: [], matters: [], updates: [], audits: [],
};
function atPage(page: string) {
  vi.stubGlobal('window', {
    location: { hash: `#/${page}`, protocol: 'http:', hostname: '127.0.0.1' },
    matchMedia: (query: string) => ({ matches: query.includes('min-width: 1200') || query.includes('min-width:1200'), media: query, addListener() {}, removeListener() {} }),
  });
}
function render(node: React.ReactNode) {
  return renderToStaticMarkup(<ConfigProvider><AntApp>{node}</AntApp></ConfigProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe('admin interface regression', () => {
  it('offers browser-saved passwords without persisting the login session', () => {
    atPage('overview');
    const html = render(<LoginPage onSuccess={() => {}} />);
    expect(html).toContain('login-introduction');
    expect(html).toContain('图片验证码');
    expect(html).toContain('刷新验证码');
    expect(html).not.toContain('7 天免输密码');
    expect(html).not.toContain('记住登录');
    expect(html).toContain('记住密码');
    expect(html).toMatch(/<input[^>]+type="checkbox"[^>]+checked/);
    expect(html).toContain('连续输错 5 次将锁定 15 分钟');
    const form = html.match(/<form\b[^>]*>/)?.[0] ?? '';
    expect(form).toContain('action="/api/admin/login"');
    expect(form).toContain('method="post"');
    expect(form).toContain('autoComplete="on"');
    const username = html.match(/<input\b[^>]*\bname="username"[^>]*>/)?.[0] ?? '';
    expect(username).toContain('autoComplete="username"');
    const password = html.match(/<input\b[^>]*\bname="password"[^>]*>/)?.[0] ?? '';
    expect(password).toContain('autoComplete="current-password"');
    expect(password).toContain('type="password"');
    expect(html).toContain('由当前浏览器保存和自动填入账号密码，验证码仍需每次填写。');
  });

  it('retains lockout feedback and does not hide an API error behind the design', () => {
    atPage('overview');
    const html = render(<LoginPage onSuccess={() => {}} initialError={new ApiError('测试锁定提示', 429, 'LOGIN_LOCKED', 30)} />);
    expect(html).toContain('测试锁定提示');
    expect(html).toContain('暂时无法登录');
    expect(html).toContain('role="alert"');
  });

  it.each([
    ['overview', '运营概览'], ['customers', '客户管理'], ['enterprises', '企业信息管理'],
    ['licenses', '授权管理'], ['devices', '设备管理'], ['systems', '业务系统'],
    ['updates', '版本更新'], ['audits', '操作审计'], ['security', '账号与安全'],
  ])('renders %s with accessible navigation and its existing page', (page, title) => {
    atPage(page);
    const html = render(<AdminShell initialData={emptyData} onLoggedOut={() => {}} />);
    expect(html).toContain(title);
    expect(html).toContain('apple-admin-layout');
    expect(html).toContain('跳到主要内容');
    expect(html).toContain('id="admin-main"');
    expect(html).toContain(`href="#/${page}"`);
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('undefined 的账号角色');
  });

  it('keeps viewer permissions read-only in management pages', () => {
    const data: BootstrapData = { ...emptyData, user: { id: 'viewer', username: 'viewer', role: 'viewer' } };
    for (const page of ['customers', 'licenses', 'updates', 'enterprises', 'security']) {
      atPage(page);
      const html = render(<AdminShell initialData={data} onLoggedOut={() => {}} />);
      expect(html).not.toContain('新增客户</span>');
      expect(html).not.toContain('签发授权</span>');
      expect(html).not.toContain('调整授权</span>');
      expect(html).not.toContain('发布新版本</span>');
      expect(html).not.toContain('补全选中企业</span>');
      expect(html).not.toContain('新增账号</span>');
    }
  });
  it('explains actual update behavior and shows the server-owned release metadata for review', () => {
    atPage('updates');
    const html = render(<UpdatesPage data={emptyData} reload={async () => {}} />);
    expect(html).toContain('上传安装包、核对服务器摘要');
    expect(html).toContain('新版会自动检查并下载');
    expect(html).toContain('旧客户端需在');
    expect(html).toContain('发布新版本');
    expect(html).not.toContain('HTTPS 下载地址');
    const details = render(<ReleaseDetails release={{ version: '1.0.3', fileName: 'DataFusion-Setup-1.0.3-x64.exe', bytes: 117414503, sha256: 'a'.repeat(64), url: 'https://updates.test/app.exe', notes: '<script>不能执行</script>' }} />);
    expect(details).toContain('服务器 SHA256'); expect(details).toContain('112.0 MB');
    expect(details).toContain('Windows · 64 位通用版');
    expect(details).toContain('&lt;script&gt;'); expect(details).not.toContain('<script>');
  });
  it('offers platform and Kylin architecture controls with accurate release details', () => {
    atPage('updates');
    const onPlatformChange = () => {}, onArchitectureChange = () => {};
    const windows = render(<ReleaseTargetPicker target={{ platform: 'win32', arch: 'x64' }} onPlatformChange={onPlatformChange} onArchitectureChange={onArchitectureChange} />);
    expect(windows).toContain('Windows'); expect(windows).toContain('信创');
    expect(windows).toContain('aria-label="发布平台"'); expect(windows).not.toContain('aria-label="麒麟芯片架构"');
    const linux = render(<ReleaseTargetPicker target={{ platform: 'linux', arch: 'arm64' }} disabled onPlatformChange={onPlatformChange} onArchitectureChange={onArchitectureChange} />);
    expect(linux).toContain('aria-label="麒麟芯片架构"'); expect(linux).toContain('x86_64'); expect(linux).toContain('ARM64');
    expect(linux).toContain('ant-segmented-disabled');
    const details = render(<ReleaseDetails release={{ version: '1.0.3', platform: 'linux', arch: 'arm64', installer: 'deb',
      fileName: '数据融合助手-麒麟版-1.0.3-arm64.deb', bytes: 1024, sha256: 'a'.repeat(64), url: 'https://updates.test/package.deb' }} />);
    expect(details).toContain('信创 · 麒麟 V10 · ARM64'); expect(details).toContain('DEB'); expect(details).not.toContain('Windows');
  });
});
