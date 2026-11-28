import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Collapse, Descriptions, Drawer, Empty, Popconfirm, Spin, Switch, Tabs, Tag, Typography } from 'antd';
import { ModalForm, PageContainer, ProFormText, ProTable, type ActionType, type ProColumns } from '@ant-design/pro-components';
import { request } from './api';
import { adminTableSearch, formatHistoryChange } from './presentation';

interface EnterpriseRow {
  id: string; name: string; credit_code: string; status: string; source_system: string; reason: string;
  standard_name?: string; standard_code?: string; legal_person?: string; source?: string; updated_at?: number;
  attempts: number; queried_at?: number;
  last_verified_at?: number; revalidated_at?: number; revalidation_status?: string; revalidation_reason?: string; proposal_json?: string;
}
interface Settings { configured: boolean; enabled: boolean; batchLimit: number; statistics?: { libraryHits: number; providerCacheHits: number; providerRequests: number }; job?: { running: boolean; total: number; completed: number; error?: string } }
interface History { id: string; actor: string; source: string; before_json: string; after_json: string; created_at: number }
const base = '/api/admin/enterprises';
const statuses: Record<string, { text: string; status: string }> = {
  pending: { text: '待查询', status: 'Default' }, success: { text: '已补全', status: 'Success' },
  partial: { text: '缺法人', status: 'Warning' }, not_found: { text: '未查到', status: 'Warning' },
  error: { text: '查询异常', status: 'Error' }, review: { text: '待核对', status: 'Warning' },
};
const systems: Record<string, string> = { 'government-info': '政务综合信息', 'oversize-transport': '大件运输', 'online-car-permit': '网约车车证', manual: '人工登记' };
const sources: Record<string, string> = { manual: '人工核实', 'manual-revalidation': '人工发起重新核验', 'aliyun-name': '阿里云·名称查询', 'aliyun-code': '阿里云·信用代码查询' };
const time = (value?: number) => value ? new Date(value).toLocaleString('zh-CN') : '—';
const proposal = (row?: EnterpriseRow): { name?: string; creditCode?: string; legalPerson?: string; expected?: { name: string; creditCode: string; legalPerson: string } } | undefined => {
  try { return row?.proposal_json ? JSON.parse(row.proposal_json) : undefined; } catch { return undefined; }
};
const freshness = (row: EnterpriseRow) => !row.last_verified_at ? '尚无核验时间' : Date.now() - row.last_verified_at > 90 * 86400000 ? '超过 90 天' : '90 天内已核验';

export function EnterprisePage({ role }: { role?: string }) {
  const { message } = App.useApp();
  const action = useRef<ActionType>(undefined);
  const [settings, setSettings] = useState<Settings>();
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EnterpriseRow>();
  const [details, setDetails] = useState<EnterpriseRow>();
  const [history, setHistory] = useState<History[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const canManage = role === 'admin' || role === 'operator';
  const refreshSettings = async () => setSettings(await request<Settings>(`${base}/settings`));
  useEffect(() => { void refreshSettings().catch(() => {}); }, []);
  useEffect(() => {
    if (!settings?.job?.running) return;
    const timer = setInterval(() => { void refreshSettings().then(() => action.current?.reload()).catch(() => {}); }, 2000);
    return () => clearInterval(timer);
  }, [settings?.job?.running]);
  useEffect(() => {
    if (!details) return;
    let alive = true;
    setHistory([]);
    setHistoryLoading(true); setHistoryError(false);
    void request<History[]>(`${base}/${details.id}/history`).then(rows => { if (alive) setHistory(rows); })
      .catch(() => { if (alive) setHistoryError(true); }).finally(() => { if (alive) setHistoryLoading(false); });
    return () => { alive = false; };
  }, [details]);
  const query = async () => {
    await request(`${base}/query`, { method: 'POST', body: JSON.stringify({ ids: selected }) });
    message.success('已启动补全批次，可在本页查看进度'); setSelected([]); await refreshSettings(); await action.current?.reload();
  };
  const revalidate = async (row: EnterpriseRow) => {
    await request(`${base}/revalidate`, { method: 'POST', body: JSON.stringify({ ids: [row.id] }) });
    message.success('已开始重新核验，原资料继续保留'); await refreshSettings(); await action.current?.reload();
  };
  const columns: ProColumns<EnterpriseRow>[] = [
    { title: '名称 / 代码 / 法人', dataIndex: 'keyword', hideInTable: true },
    { title: '原始企业名称', dataIndex: 'name', search: false, width: 190, ellipsis: true },
    { title: '原始有效信用代码', dataIndex: 'credit_code', search: false, width: 185 },
    { title: '标准企业名称', dataIndex: 'standard_name', search: false, width: 190, ellipsis: true },
    { title: '统一信用代码', dataIndex: 'standard_code', search: false, width: 180 },
    { title: '法人姓名', dataIndex: 'legal_person', search: false, width: 100 },
    { title: '查询状态', dataIndex: 'status', valueEnum: statuses, width: 90 },
    { title: '首次来源', dataIndex: 'source_system', search: false, width: 120, renderText: value => systems[value] ?? value },
    { title: '依据', dataIndex: 'source', search: false, width: 125, renderText: value => sources[value] ?? value ?? '—' },
    { title: '最近查询', dataIndex: 'queried_at', search: false, width: 170, render: (_, row) => time(row.queried_at) },
    { title: '最近核验', dataIndex: 'last_verified_at', search: false, width: 175, render: (_, row) => <><div>{time(row.last_verified_at)}</div><Typography.Text type="secondary">{freshness(row)}</Typography.Text>{row.revalidation_status === 'different' && <Tag color="warning">差异待确认</Tag>}</> },
    { title: '说明', dataIndex: 'reason', search: false, width: 250, render: (_, row) => row.revalidation_reason || row.reason || '—' },
    { title: '操作', valueType: 'option', fixed: 'right', width: 190, render: (_, row) => [
      <Button key="detail" type="link" onClick={() => setDetails(row)}>依据</Button>,
      ...(canManage ? [<Button key="edit" type="link" disabled={settings?.job?.running} onClick={() => setEditing(row)}>{row.revalidation_status === 'different' ? '核对差异' : '修正'}</Button>,
        ...(['success','partial'].includes(row.status) ? [<Popconfirm key="revalidate" title="重新核验这家企业？" description="将按标准信用代码重新请求阿里云，可能消耗 1 次额度。资料有变化时由您确认，原值不会自动覆盖。" onConfirm={() => revalidate(row)}><Button type="link" disabled={!settings?.enabled || settings.job?.running}>重新核验</Button></Popconfirm>] : [])] : []),
    ] },
  ];
  return <PageContainer title="企业信息管理" subTitle="统一维护企业名称、信用代码与法人信息；名称优先，原始信息留档">
    <Alert type="info" showIcon message="原系统字段缺失时，桌面回流会先查企业库；仍未补齐且已开启付费查询时，自动调用阿里云。已有完整资料直接复用；重新核验须人工点击，差异确认后才覆盖原值。" />
    <div className="enterprise-query-settings">
      <Tag color={settings?.configured ? 'green' : 'orange'}>{settings?.configured ? '服务端密钥已配置' : '服务端未配置阿里云密钥'}</Tag>
      <div className="query-switch"><span id="enterprise-paid-query-label">允许付费查询</span>
      <Switch aria-labelledby="enterprise-paid-query-label" checked={settings?.enabled ?? false} disabled={role !== 'admin' || !settings?.configured}
        onChange={enabled => { void request(`${base}/settings`, { method: 'PATCH', body: JSON.stringify({ enabled }) }).then(refreshSettings).catch(() => {}); }} /></div>
      <span className="query-note">每批最多 20 家，名称优先、未查到再用有效信用代码；大件运输有有效代码时仅按代码查询。</span>
      {settings?.statistics && <Typography.Text type="secondary">本功能启用以来：企业库命中 {settings.statistics.libraryHits} 次 · 云端缓存命中 {settings.statistics.providerCacheHits} 次 · 阿里云请求 {settings.statistics.providerRequests} 次（费用以供应商账单为准）</Typography.Text>}
      {settings?.job && <Tag color={settings.job.running ? 'processing' : 'default'}>{settings.job.running ? '处理中' : '批次结束'} {settings.job.completed}/{settings.job.total}</Tag>}
      {settings?.job?.error && <Typography.Text type="danger">{settings.job.error}</Typography.Text>}
    </div>
    <ProTable<EnterpriseRow> rowKey="id" headerTitle="企业资料" actionRef={action} columns={columns} scroll={{ x: 1080 }} search={adminTableSearch}
      columnsState={{ defaultValue: { credit_code: { show: false }, source_system: { show: false }, queried_at: { show: false }, reason: { show: false } } }}
      request={async params => { const value = await request<{ rows: EnterpriseRow[]; total: number }>(`${base}?${new URLSearchParams({ page: String(params.current ?? 1), keyword: String(params.keyword ?? ''), status: String(params.status ?? '') })}`); return { data: value.rows, total: value.total, success: true }; }}
      pagination={{ pageSize: 20, showSizeChanger: false }}
      rowSelection={canManage ? { selectedRowKeys: selected, onChange: setSelected, getCheckboxProps: row => ({ disabled: ['success','review'].includes(row.status) }) } : false}
      toolBarRender={() => canManage ? [
        <Button key="add" onClick={() => setCreating(true)}>登记企业</Button>,
        <Popconfirm key="query" title={`查询选中的 ${selected.length} 家企业？`} description="可能产生阿里云费用，最多两次请求/家。网络或额度异常不会触发信用代码兜底。" onConfirm={query}>
          <Button type="primary" disabled={!settings?.enabled || settings.job?.running || !selected.length || selected.length > 20}>补全选中企业</Button>
        </Popconfirm>,
      ] : []} />
    <ModalForm<{ name?: string; creditCode?: string }> title="登记待补全企业" open={creating} onOpenChange={setCreating} modalProps={{ destroyOnClose: true, maskClosable: false }} onFinish={async values => {
      await request(base, { method: 'POST', body: JSON.stringify(values) }); await action.current?.reload(); return true;
    }}>
      <ProFormText name="name" label="原始企业名称" fieldProps={{ maxLength: 200 }} />
      <ProFormText name="creditCode" label="统一信用代码（可选，用于兜底）" fieldProps={{ maxLength: 18 }} />
      <Typography.Text type="secondary">名称或有效信用代码至少填写一项；登记不会调用付费接口。</Typography.Text>
    </ModalForm>
    <ModalForm<{ name: string; creditCode: string; legalPerson?: string }> key={editing?.id ?? 'edit'} title="人工核实企业资料" open={Boolean(editing)} onOpenChange={open => { if (!open) setEditing(undefined); }}
      initialValues={{ name: proposal(editing)?.name || editing?.standard_name || editing?.name, creditCode: proposal(editing)?.creditCode || editing?.standard_code || editing?.credit_code, legalPerson: proposal(editing)?.legalPerson || editing?.legal_person }}
      modalProps={{ destroyOnClose: true, maskClosable: false }} onFinish={async values => {
        if (!editing) return false;
        await request(`${base}/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ ...values, ...(editing.standard_code ? { expected: proposal(editing)?.expected ?? { name: editing.standard_name, creditCode: editing.standard_code, legalPerson: editing.legal_person } } : {}) }) }); await action.current?.reload(); message.success('企业资料已保存，原始信息及修改依据已留档'); return true;
      }}>
      <Alert type="warning" message="修改同一信用代码的资料会影响关联企业别名。与原始有效信用代码冲突时禁止直接关联。" />
      {proposal(editing) && <Alert type="info" message="下方已填入待确认的核验结果，保存后才生效" description={`原资料：${editing?.standard_name} · ${editing?.standard_code} · 法人：${editing?.legal_person || '未填写'}`} />}
      <ProFormText name="name" label="标准企业名称" rules={[{ required: true }]} fieldProps={{ maxLength: 200 }} />
      <ProFormText name="creditCode" label="统一信用代码" rules={[{ required: true }]} fieldProps={{ maxLength: 18 }} />
      <ProFormText name="legalPerson" label="法人姓名" fieldProps={{ maxLength: 100 }} />
    </ModalForm>
    <Drawer title="企业详情与补全依据" width={750} open={Boolean(details)} onClose={() => setDetails(undefined)}>
      <Tabs key={details?.id} className="enterprise-details-tabs" items={[
        { key: 'standard', label: '标准信息', children: <Descriptions className="enterprise-detail-summary" bordered size="small" column={1} items={[
          { key: 'name', label: '标准企业名称', children: details?.standard_name || '待补全' },
          { key: 'code', label: '统一社会信用代码', children: details?.standard_code || '待补全' },
          { key: 'legal', label: '法定代表人', children: details?.legal_person || '待补全' },
          { key: 'status', label: '查询状态', children: statuses[details?.status ?? '']?.text ?? details?.status },
          { key: 'source', label: '来源依据', children: sources[details?.source ?? ''] ?? details?.source ?? '—' },
          { key: 'updated', label: '更新时间', children: time(details?.updated_at) },
          { key: 'verified', label: '最近核验', children: `${time(details?.last_verified_at)} · ${details ? freshness(details) : ''}` },
          { key: 'revalidation', label: '人工重新核验', children: `${time(details?.revalidated_at)} · ${details?.revalidation_reason || '暂无核验结果'}` },
        ]} /> },
        { key: 'basis', label: '查询依据', children: <><Descriptions bordered size="small" column={1} items={[
          { key: 'name', label: '原始名称', children: details?.name || '未提供' },
          { key: 'code', label: '原始信用代码', children: details?.credit_code || '无有效代码' },
          { key: 'system', label: '首次来源', children: systems[details?.source_system ?? ''] ?? details?.source_system },
          { key: 'attempts', label: '查询轮数', children: details?.attempts },
          { key: 'queried', label: '最近查询', children: time(details?.queried_at) },
          { key: 'reason', label: '说明', children: details?.reason || '—' },
        ]} /><Typography.Paragraph type="secondary" style={{ marginTop: 20 }}>先按名称查询，未命中时再以有效统一信用代码查询；人工修正与查询结果均保留依据。</Typography.Paragraph></> },
        { key: 'history', label: '历史记录', children: <><Typography.Paragraph type="secondary">展示最近 100 条依据及修改前后值，完整历史保存在后台数据库。</Typography.Paragraph>
          <Spin spinning={historyLoading}><div className="enterprise-history" aria-busy={historyLoading}>
            {historyError ? <Alert type="warning" showIcon message="历史依据读取失败，请重新打开详情重试。" /> : !historyLoading && !history.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无历史记录" /> : history.map(row => <Collapse key={row.id} items={[{
              key: row.id, label: <span>{time(row.created_at)}<span className="history-actor">{row.actor} · {sources[row.source] ?? row.source}</span></span>,
              children: <pre>{formatHistoryChange(row.before_json, row.after_json)}</pre>,
            }]} />)}
          </div></Spin></> },
      ]} />
    </Drawer>
  </PageContainer>;
}
