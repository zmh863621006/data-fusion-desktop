import { useState } from 'react';
import type { LicenseStatus } from '../../core/license/types';

export function AuthorizationInfo({ status, onChanged }: {
  status: LicenseStatus;
  onChanged: (status: LicenseStatus) => void;
}) {
  const identity = status.identity ?? status.grant;
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');
  const copy = async (kind: 'license' | 'device') => {
    try {
      await window.desktopApi.license.copyIdentifier(kind);
      setMessage(kind === 'license' ? '授权编号已复制' : '设备码已复制');
    } catch {
      setMessage('复制失败，请手动选择并复制编号');
    }
  };
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setMessage('');
    try {
      const result = await window.desktopApi.license.refresh() as LicenseStatus;
      onChanged(result);
      setMessage(result.state === 'active' ? '授权已刷新' : result.message ?? '当前授权不可用');
    } catch {
      // Explicit rejection can update the local status before the IPC call reports the error.
      const current = await window.desktopApi.license.status().catch(() => null) as LicenseStatus | null;
      if (current) onChanged(current);
      setMessage(current?.state !== 'active' && current?.message
        ? current.message : '刷新授权失败，请检查网络后重试');
    } finally {
      setRefreshing(false);
    }
  };

  return <details className="authorization-info panel">
    <summary>授权信息</summary>
    <div className="authorization-info-content">
      <dl className="authorization-info-fields">
        {identity && <>
          <div><dt>客户名称</dt><dd>{identity.customerName || '—'}</dd></div>
          <div><dt>授权方式</dt><dd>{identity.activationMode === 'online' ? '在线' : '离线'}</dd></div>
          <div><dt>有效期至</dt><dd>{new Date(identity.expiresAt).toLocaleString('zh-CN', { hour12: false })}</dd></div>
          <div><dt>授权状态</dt><dd>{status.state === 'active' ? '有效' : status.message ?? '授权不可用'}</dd></div>
          <div className="authorization-identifier">
            <dt>授权编号</dt><dd><code>{identity.licenseId}</code></dd>
          </div>
        </>}
        <div className="authorization-identifier"><dt>设备码</dt><dd><code>{status.deviceId}</code></dd></div>
      </dl>
      <div className="button-row">
        {identity?.licenseId && <button type="button" className="secondary" onClick={() => void copy('license')}>复制授权编号</button>}
        <button type="button" className="secondary" onClick={() => void copy('device')}>复制设备码</button>
        {identity?.activationMode === 'online' && <button type="button" className="primary" disabled={refreshing}
          onClick={() => void refresh()}>{refreshing ? '正在刷新…' : '刷新授权'}</button>}
      </div>
      <p className="muted">联系管理员时，请提供{identity?.licenseId ? '授权编号' : '设备码'}。</p>
      {message && <div role="status" className="authorization-feedback">{message}</div>}
    </div>
  </details>;
}
