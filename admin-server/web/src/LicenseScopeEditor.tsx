import { useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Modal, Space, Typography } from 'antd';
import { LicenseScopePicker } from './LicenseScopePicker';
import { adminApi, ApiError } from './api';
import { legacyScopeSystems, licenseScopeSnapshot, scopeEditorValues, scopeUpdatePayload, scopeValidationError, emptyScope } from './license-scope';
import type { BootstrapData, DeviceRecord, LicenseRecord } from './types';
import { listManagement } from './management-pagination';

export function LicenseScopeEditor({ license, data, onClose, onSaved }: {
  license: LicenseRecord;
  data: BootstrapData;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflicted, setConflicted] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [initial] = useState(() => {
    try {
      const snapshot = licenseScopeSnapshot(license);
      return { snapshot, values: scopeEditorValues(snapshot, data.matters), error: '' };
    } catch (cause) { return { snapshot: null, values: null, error: cause instanceof Error ? cause.message : '现有授权数据异常' }; }
  });
  const [values, setValues] = useState(initial.values ?? emptyScope);
  const legacySystems = initial.snapshot ? legacyScopeSystems(initial.snapshot) : [];
  const [remoteDevices, setRemoteDevices] = useState<DeviceRecord[]>([]), [devicesLoading, setDevicesLoading] = useState(Boolean(data.paginated));
  const [devicesError, setDevicesError] = useState(false);
  useEffect(() => {
    if (!data.paginated) return;
    const controller = new AbortController(); setDevicesLoading(true); setDevicesError(false);
    void listManagement<DeviceRecord>('devices', { licenseId: license.id, status: 'active', pageSize: 100 }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setRemoteDevices(result.rows); })
      .catch(() => { if (!controller.signal.aborted) setDevicesError(true); })
      .finally(() => { if (!controller.signal.aborted) setDevicesLoading(false); });
    return () => controller.abort();
  }, [data.paginated, license.id]);
  const boundDevices = data.paginated ? remoteDevices : data.devices.filter(device => device.license_id === license.id && device.status === 'active');

  const save = async () => {
    if (!initial.snapshot || saving || conflicted) return;
    const validation = scopeValidationError(values, data.matters);
    if (validation) { setError(validation); return; }
    const payload = scopeUpdatePayload(values, initial.snapshot);
    setError(''); setSaving(true);
    try {
      const result = await adminApi.updateLicenseScope(license.id, payload);
      message.success(!result.changed ? '授权范围没有变化' : result.requiresOfflineReissue ? '授权范围已更新，请补发离线许可证并在客户端导入' : '授权范围已更新，已绑定设备将在下次在线校验后生效');
      onClose();
      await onSaved();
    } catch (cause) {
      if (cause instanceof ApiError && ['LICENSE_SCOPE_CONFLICT', 'LICENSE_SCOPE_CORRUPT'].includes(cause.code ?? '')) { setConflicted(true); setError(`${cause.message}。请刷新后重新核对，当前修改尚未保存。`); }
      else setError(cause instanceof Error ? cause.message : '保存失败，请稍后重试');
    } finally { setSaving(false); }
  };

  return <Modal title="调整授权" open width={720} className="license-scope-modal" destroyOnHidden maskClosable={false} keyboard={!saving && !refreshing} closable={!saving && !refreshing}
    onCancel={() => { if (!saving && !refreshing) onClose(); }} onOk={() => void save()} okText="保存授权范围" cancelText="取消" confirmLoading={saving}
    okButtonProps={{ disabled: Boolean(initial.error) || conflicted || refreshing }} cancelButtonProps={{ disabled: saving || refreshing }}>
    <Space direction="vertical" size={16} className="license-scope-content">
      <div className="license-scope-summary"><Typography.Text strong>{license.customer_name}</Typography.Text><Typography.Paragraph type="secondary">仅调整系统、工具和业务事项，保留原有效期、设备绑定、最大设备数及其他功能权限。</Typography.Paragraph></div>
      <Alert type="info" showIcon message="影响此授权绑定的全部设备" description={<>
        {license.mode === 'offline' ? '离线授权保存后，需补发许可证并由用户重新导入；已交付的旧文件不会远程失效。' : '在线授权将在客户端下次在线校验后生效，无需重新激活。'}
        <details className="license-bound-devices">
          <summary>已绑定且在用的设备（{devicesLoading ? '读取中' : devicesError ? '读取失败' : `${boundDevices.length} 台`}）</summary>
          {boundDevices.length > 0 ? <ul>{boundDevices.map(device => <li key={device.id}><Typography.Text code copyable>{device.device_id}</Typography.Text></li>)}</ul>
            : <div>{devicesLoading ? '正在读取…' : devicesError ? '请关闭并重新打开查看设备' : '暂无在用设备'}</div>}
        </details>
      </>} />
      {legacySystems.length > 0 && <Alert type="warning" showIcon message="此授权包含历史“全部事项”范围" description="已按当前目录列出这些系统的现有事项（含已停用事项）。保存后将改为明确清单，不会自动包含将来新增事项；请核对后保存。" />}
      {(initial.error || error) && <Alert type="error" showIcon role="alert" message={initial.error || error} action={conflicted ? <Button type="link" size="small" loading={refreshing} onClick={async () => { if (refreshing) return; setRefreshing(true); try { await onSaved(); onClose(); } catch { setError('刷新失败，请稍后重试'); } finally { setRefreshing(false); } }}>刷新授权</Button> : undefined} />}
      {initial.values && <LicenseScopePicker data={data} initial={initial.values} value={values} disabled={saving || conflicted || refreshing}
        onChange={next => { setValues(next); setError(''); }} />}
    </Space>
  </Modal>;
}
