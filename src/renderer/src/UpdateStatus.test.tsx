import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateBanner, UpdateStatus, updateDownloadText, updatePercent, type UpdatePresentationState } from './UpdateStatus';

const initial: UpdatePresentationState = { status: 'idle', currentVersion: '1.0.3', message: '等待检查', automatic: true, installMode: 'installed' };
const render = (state: UpdatePresentationState | null, checking = false, message = '') => renderToStaticMarkup(<UpdateStatus state={state} checking={checking} message={message} onCheck={() => {}} onInstall={() => {}} />);

describe('automatic update UI states', () => {
  it.each([null, initial, { ...initial, status: 'disabled' as const }, { ...initial, status: 'up-to-date' as const }])('keeps idle/empty/disabled/current states usable without an install action', state => {
    const html = render(state); expect(html).toContain('检查更新'); expect(html).not.toContain('重启并更新'); expect(html).not.toContain('<progress');
  });
  it('disables repeated checks while checking, downloading or installing', () => {
    for (const status of ['checking', 'downloading', 'installing'] as const) {
      const html = render({ ...initial, status });
      expect(html).toContain('aria-busy="true"'); expect(html).toMatch(/<button[^>]*disabled=""/); expect(html).not.toContain('重启并更新');
      expect(html).toContain(status === 'downloading' ? '下载中…' : status === 'installing' ? '更新中…' : '检查中…');
    }
  });
  it('shows accessible bounded progress and handles an unknown content length without inventing a percent', () => {
    const html = render({ ...initial, status: 'downloading', version: '1.0.4', progress: { downloaded: 12 * 1024 * 1024, total: 30 * 1024 * 1024, percent: 40 } });
    expect(html).toContain('aria-label="更新包下载进度"'); expect(html).toContain('value="40"'); expect(html).toContain('12.0 MB / 30.0 MB');
    const unknown = render({ ...initial, status: 'downloading', progress: { downloaded: 1024 } });
    expect(unknown).not.toMatch(/<progress[^>]*value=/); expect(unknown).toContain('正在下载…'); expect(unknown).toContain('已下载 1 KB');
    expect(updatePercent(300)).toBe(100); expect(updatePercent(-1)).toBe(0); expect(updatePercent(NaN)).toBeUndefined();
    expect(updateDownloadText(undefined)).toContain('正在连接');
  });
  it('only offers restart for a verified ready installed build, including a local checking guard', () => {
    const ready = { ...initial, status: 'ready' as const, version: '1.0.4', message: '下载已校验' };
    expect(render(ready)).toContain('重启并更新 1.0.4'); expect(render(ready, true)).toMatch(/<button class="primary" disabled=""/);
    const manual = render({ ...ready, installMode: 'manual' });
    expect(manual).not.toContain('重启并更新'); expect(manual).toContain('开发或免安装模式'); expect(manual).toContain('不会覆盖源码或清除现有数据');
  });
  it('offers system-installer confirmation for a verified Linux package without claiming automatic restart', () => {
    const state = { ...initial, installMode: 'system' as const, status: 'ready' as const, version: '1.0.22' };
    const html = render(state);
    expect(html).toContain('打开系统安装器 1.0.22'); expect(html).not.toContain('重启并更新');
    expect(html).not.toContain('开发或免安装模式');
    expect(renderToStaticMarkup(<UpdateBanner state={state} onOpen={() => {}} />)).toContain('系统安装器确认安装');
  });
  it('retains retryable errors and a previous install failure without hiding the current app', () => {
    const html = render({ ...initial, status: 'error', message: '网络失败，当前版本仍可使用', lastInstallError: '<script>示例错误</script>' });
    expect(html).toContain('role="alert"'); expect(html).toContain('网络失败'); expect(html).toContain('上次更新未完成'); expect(html).toContain('原版本和业务数据仍然保留');
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('检查更新');
    expect(render({ ...initial, status: 'error', message: '最新的下载错误' }, false, '上次检查已是最新')).toContain('最新的下载错误');
  });
  it('shows release notes as text and prefers a contextual action message', () => {
    const html = render({ ...initial, notes: '第一行\n<script>不是 HTML</script>', message: '旧消息' }, false, '正在保存会话');
    expect(html).toContain('本次更新'); expect(html).toContain('第一行\n'); expect(html).not.toContain('<script>');
    expect(html).toContain('正在保存会话'); expect(html).not.toContain('旧消息');
  });
});

describe('quiet global update banner', () => {
  it.each(['idle','checking','up-to-date','installing','error','disabled'] as const)('does not repeat %s globally', status => {
    expect(renderToStaticMarkup(<UpdateBanner state={{ ...initial, status }} onOpen={() => {}} />)).toBe('');
  });
  it('can open settings while the download continues, without exposing an install action', () => {
    const html = renderToStaticMarkup(<UpdateBanner state={{ ...initial, status: 'downloading', version: '1.0.4', progress: { downloaded: 5, percent: 50 } }} onOpen={() => {}} />);
    expect(html).toContain('50%'); expect(html).toContain('不影响当前工作'); expect(html).toContain('查看更新'); expect(html).not.toContain('重启并更新');
  });
  it('distinguishes an installed ready build from the manual-mode bootstrap', () => {
    const ready = { ...initial, status: 'ready' as const, version: '1.0.4' };
    expect(renderToStaticMarkup(<UpdateBanner state={ready} onOpen={() => {}} />)).toContain('保存工作后可重启更新');
    expect(renderToStaticMarkup(<UpdateBanner state={{ ...ready, installMode: 'manual' }} onOpen={() => {}} />)).toContain('需手动安装正式版');
  });
});
