import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Form, Modal, Select, Space, TreeSelect, Typography } from 'antd';
import { adminApi, ApiError } from './api';
import { legacyScopeSystems, licenseScopeSnapshot, scopeEditorValues, scopeMatterCatalog, scopeUpdatePayload, type LicenseScopeValues } from './license-scope';
import type { BootstrapData, LicenseRecord } from './types';

export function LicenseScopeEditor({ license, data, onClose, onSaved }: {
  license: LicenseRecord;
  data: BootstrapData;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<LicenseScopeValues>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflicted, setConflicted] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const initial = useMemo(() => {
    try {
      const snapshot = licenseScopeSnapshot(license);
      return { snapshot, values: scopeEditorValues(snapshot, data.matters), error: '' };
    } catch (cause) { return { snapshot: null, values: null, error: cause instanceof Error ? cause.message : '现有授权数据异常' }; }
  }, [license, data.matters]);
  const selectedSystems = Form.useWatch('allowedSystems', form) as string[] | undefined;
  const selectedTools = Form.useWatch('allowedTools', form) as string[] | undefined;
  const selectedMatters = Form.useWatch('allowedMatters', form) as Record<string, string[]> | undefined;
  const systems = selectedSystems ?? initial.values?.allowedSystems ?? [];
  const tools = selectedTools ?? initial.values?.allowedTools ?? [];
  const mattersBySystem = selectedMatters ?? initial.values?.allowedMatters ?? {};
  const legacySystems = initial.snapshot ? legacyScopeSystems(initial.snapshot) : [];
  const systemOptions = [...data.systems.filter(item => item.enabled || initial.snapshot?.allowedSystems.includes(item.id)).map(item => ({
    label: item.enabled ? item.name : `${item.name}（已停用，仅可保留或移除）`, value: item.id, disabled: !item.enabled && !systems.includes(item.id),
  })), ...(initial.snapshot?.allowedSystems ?? []).filter(id => !data.systems.some(item => item.id === id)).map(id => ({ label: `${id}（已下线，仅可保留或移除）`, value: id, disabled: !systems.includes(id) }))];
  const toolOptions = [...(data.tools ?? []).map(item => ({ label: item.name, value: item.id })),
    ...(initial.snapshot?.allowedTools ?? []).filter(id => !data.tools.some(item => item.id === id)).map(id => ({ label: `${id}（已下线，仅可保留或移除）`, value: id, disabled: !tools.includes(id) }))];

  const save = async () => {
    if (!initial.snapshot || saving || conflicted) return;
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    const payload = scopeUpdatePayload(values, initial.snapshot);
    if (!payload.allowedSystems.length && !payload.allowedTools.length) { setError('请至少选择一个业务系统或工具'); return; }
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
      <Alert type="info" showIcon message="影响此授权绑定的全部设备" description={license.mode === 'offline' ? '离线授权保存后，需补发许可证并由用户重新导入；已交付的旧文件不会远程失效。' : '在线授权将在客户端下次在线校验后生效，无需重新激活。'} />
      {legacySystems.length > 0 && <Alert type="warning" showIcon message="此授权包含历史“全部事项”范围" description="已按当前目录列出这些系统的现有事项（含已停用事项）。保存后将改为明确清单，不会自动包含将来新增事项；请核对后保存。" />}
      {(initial.error || error) && <Alert type="error" showIcon role="alert" message={initial.error || error} action={conflicted ? <Button type="link" size="small" loading={refreshing} onClick={async () => { if (refreshing) return; setRefreshing(true); try { await onSaved(); onClose(); } catch { setError('刷新失败，请稍后重试'); } finally { setRefreshing(false); } }}>刷新授权</Button> : undefined} />}
      {initial.values && <Form<LicenseScopeValues> form={form} layout="vertical" initialValues={initial.values} disabled={saving || conflicted || refreshing}>
        <Form.Item name="allowedSystems" label="授权业务系统" extra="仅使用工具时可不选。新增系统后，请明确选择其业务事项。"><Select mode="multiple" options={systemOptions} placeholder="选择允许使用的业务系统" optionFilterProp="label" allowClear /></Form.Item>
        <Form.Item name="allowedTools" label="授权工具" extra="工具可单独授权，无需选择业务系统。"><Select mode="multiple" options={toolOptions} placeholder="选择允许使用的工具" optionFilterProp="label" allowClear /></Form.Item>
        {systems.map(systemId => {
          const system = data.systems.find(item => item.id === systemId);
          const initialIds = initial.values?.allowedMatters[systemId] ?? [];
          const ids = mattersBySystem[systemId] ?? [];
          const catalog = scopeMatterCatalog(systemId, initial.values!, data);
          const missingIds = initialIds.filter(id => !data.matters.some(item => item.system_id === systemId && item.id === id));
          const groups = [...new Set(catalog.map(item => item.department_name ?? '业务事项'))];
          const treeData = groups.map(group => ({ title: group, value: `group:${systemId}:${group}`, selectable: false, checkable: false, children: catalog.filter(item => (item.department_name ?? '业务事项') === group).map(item => ({ title: item.enabled ? item.name : `${item.name}（已停用）`, value: item.id, disabled: !item.enabled && !ids.includes(item.id) })) }));
          if (missingIds.length) treeData.push({ title: '已下线事项（仅可保留或移除）', value: `missing:${systemId}`, selectable: false, checkable: false, children: missingIds.map(id => ({ title: id, value: id, disabled: !ids.includes(id) })) });
          // Empty historical lists may be retained only when the system has no catalog.
          const needsMatter = catalog.length > 0 || missingIds.length > 0 || !initial.snapshot?.allowedSystems.includes(systemId);
          return <Form.Item key={systemId} name={['allowedMatters', systemId]} label={`${system?.name ?? systemId} · 业务事项`} extra={!treeData.length ? '此系统当前没有可授权事项，请先维护事项目录或取消该系统。' : '不自动全选；已停用、已下线事项仅支持保留或移除。'} rules={[{ validator: async (_, value) => { if (needsMatter && (!Array.isArray(value) || !value.length)) throw new Error('请明确选择至少一个业务事项'); } }]}>
            <TreeSelect treeData={treeData} treeCheckable showCheckedStrategy={TreeSelect.SHOW_CHILD} maxTagCount={3} maxTagTextLength={28} placeholder="选择允许使用的业务事项" allowClear treeDefaultExpandAll showSearch treeNodeFilterProp="title" />
          </Form.Item>;
        })}
      </Form>}
    </Space>
  </Modal>;
}
