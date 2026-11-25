import { useEffect, useState } from 'react';
import type { ReturnUploadState } from '../../core/returns/upload-queue';

export function ReturnUploadStatus() {
  const [state, setState] = useState<ReturnUploadState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      if (!window.desktopApi.returnUploads) return;
      try { const result = await window.desktopApi.returnUploads.state(); if (!disposed) setState(result); }
      catch { if (!disposed) setError('同步状态暂时无法读取'); }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  if (!state?.enabled) return null;
  const retry = async (history = false) => {
    if (history && !window.confirm('将本机已完成、且当前授权可见的历史批次补传到当前后台。已上传批次不会重复入库。是否继续？')) return;
    setBusy(true); setError('');
    try { setState(await window.desktopApi.returnUploads.retry(history)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '同步失败，本地数据已保留'); }
    finally { setBusy(false); }
  };
  return <section className="panel return-upload-status" aria-label="后台数据同步" aria-busy={busy || state.sending}>
    <div><strong>后台数据同步</strong><p role="status">已上传 {state.completed} 批 · 待上传 {state.pending} 批{state.blocked ? ` · 需处理 ${state.blocked} 批` : ''}{state.sending ? ' · 正在同步' : ''}</p>
      {(error || state.lastError) && <p role="alert">{error || state.lastError}</p>}</div>
    <div className="action-row"><button disabled={busy || state.sending} onClick={() => void retry()}>立即重试</button>
      <button disabled={busy || state.sending} onClick={() => void retry(true)}>补传历史批次</button></div>
  </section>;
}
