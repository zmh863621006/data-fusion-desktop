import { useEffect, useState } from 'react';
import type { AutomaticUpdateState } from '../../core/updater/automatic';

export type UpdatePresentationState = AutomaticUpdateState & { lastInstallError?: string };
export function updatePercent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : undefined;
}
const bytes = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(0, Math.round(value / 1024))} KB`;
export function updateDownloadText(progress: AutomaticUpdateState['progress']): string {
  if (!progress || !Number.isFinite(progress.downloaded)) return '正在连接下载服务…';
  return progress.total && Number.isFinite(progress.total) && progress.total > 0
    ? `${bytes(progress.downloaded)} / ${bytes(progress.total)}` : `已下载 ${bytes(progress.downloaded)}`;
}

export function useUpdateState(): UpdatePresentationState | null {
  const [state, setState] = useState<UpdatePresentationState | null>(null);
  useEffect(() => {
    let live = true, changed = false;
    const accept = (value: AutomaticUpdateState) => { if (live && value) setState(value); };
    // Subscribe first; a late initial snapshot must not replace a newer download/ready event.
    const unsubscribe = window.desktopApi.updates.onChanged?.(value => { changed = true; accept(value); });
    void window.desktopApi.updates.state?.().then(value => { if (!changed) accept(value); }).catch(() => {});
    return () => { live = false; unsubscribe?.(); };
  }, []);
  return state;
}

export function UpdateBanner({ state, onOpen }: { state: UpdatePresentationState | null; onOpen: () => void }) {
  if (!state || !['available', 'downloading', 'ready'].includes(state.status)) return null;
  const percent = updatePercent(state.progress?.percent);
  return <div className="update-banner" role="status"><span>{state.status === 'downloading'
    ? `正在后台下载 ${state.version ?? '新版本'}${percent !== undefined ? ` · ${percent}%` : ''}，不影响当前工作`
    : state.status === 'ready' ? state.installMode === 'system' ? `新版本 ${state.version ?? ''} 已准备好，可打开系统安装器确认安装` : state.installMode === 'installed'
      ? `新版本 ${state.version ?? ''} 已准备好，保存工作后可重启更新` : `新版本 ${state.version ?? ''} 已下载，当前运行方式需手动安装正式版`
      : `发现新版本 ${state.version ?? ''}`}</span>
    <button onClick={onOpen}>查看更新</button></div>;
}

export function UpdateStatus({ state, checking, message, onCheck, onInstall }: {
  state: UpdatePresentationState | null; checking: boolean; message: string;
  onCheck: () => void; onInstall: () => void;
}) {
  const busy = checking || ['checking', 'downloading', 'installing'].includes(state?.status ?? '');
  const checkLabel = state?.status === 'downloading' ? '下载中…' : state?.status === 'installing' ? '更新中…'
    : state?.status === 'checking' || checking ? '检查中…' : '检查更新';
  const percent = updatePercent(state?.progress?.percent), currentMessage = state?.status === 'error' ? state.message || message : message || state?.message;
  return <section className="panel settings-card update-settings" aria-busy={busy}>
    <h3>版本更新</h3>
    <div className="settings-update-row"><div><strong>数据融合助手{state ? ` · ${state.currentVersion}` : ''}</strong>
      <p>{state?.installMode === 'system' ? '新版本自动检查并后台下载，保存工作后在系统安装器中确认安装。' : '新版本自动检查并后台下载，保存工作后重启完成更新。'}</p></div>
      <div className="button-row"><button className="secondary" disabled={busy} onClick={onCheck}>{checkLabel}</button>
        {state?.status === 'ready' && state.installMode !== 'manual' && <button className="primary" disabled={busy} onClick={onInstall}>{state.installMode === 'system' ? '打开系统安装器' : '重启并更新'} {state.version}</button>}</div>
    </div>
    {state?.status === 'downloading' && <div className="update-download-progress">
      <progress max={100} value={percent} aria-label="更新包下载进度" />
      <div className="update-progress-copy"><strong>{percent !== undefined ? `${percent}%` : '正在下载…'}</strong><span>{updateDownloadText(state.progress)}</span></div>
    </div>}
    {currentMessage && <div className={`message page-message${state?.status === 'error' ? ' update-error' : ''}`} role={state?.status === 'error' ? 'alert' : 'status'}>{currentMessage}</div>}
    {state?.lastInstallError && <div className="update-last-error" role="alert"><strong>上次更新未完成</strong><p>{state.lastInstallError}</p><span>原版本和业务数据仍然保留，可重新检查更新后重试。</span></div>}
    {state?.notes && <div className="update-release-notes"><h4>本次更新</h4><p>{state.notes}</p></div>}
    {state?.installMode === 'manual' && <p className="muted update-manual-note">当前为开发或免安装模式，请先运行管理员提供的正式安装包，以启用自动安装。不会覆盖源码或清除现有数据。</p>}
    <p className="muted">仅安装已签名清单对应且校验通过的更新包。回流、查询或导出尚未完成时不会安装。</p>
  </section>;
}
