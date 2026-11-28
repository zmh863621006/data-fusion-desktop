import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  App as AntApp, Button, Card, Col, Descriptions, Drawer, Form, Input, Popconfirm, Row,
  Alert, Result, Space, Spin, Statistic, Tag, Typography,
} from 'antd';
import {
  CloudServerOutlined, CodeSandboxOutlined, CustomerServiceOutlined, DashboardOutlined,
  DesktopOutlined, EditOutlined, EyeOutlined, HistoryOutlined, KeyOutlined, LeftOutlined, LockOutlined, LogoutOutlined, MenuOutlined, PlusOutlined, ReloadOutlined, RightOutlined,
  SafetyCertificateOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons';
import {
  ModalForm, PageContainer, ProFormDatePicker, ProFormDependency, ProFormDigit, ProFormSelect,
  ProFormSwitch, ProFormText, ProFormTextArea, ProTable, type ProColumns,
} from '@ant-design/pro-components';
import dayjs, { type Dayjs } from 'dayjs';
import { adminApi, ApiError, loadAdminSession } from './api';
import { CustomerSelect, listManagement, useManagementTable } from './management-pagination';
import { offerBrowserPasswordSave } from './browser-password';
import { SecurityPage } from './SecurityPage';
import { EnterprisePage } from './EnterprisePage';
import { ReturnDataPage } from './ReturnDataPage';
import { LicenseScopeEditor } from './LicenseScopeEditor';
import { UpdatesPage } from './UpdatesPage';
import { emptyScope, licenseScopeSnapshot, scopeValidationError, type LicenseScopeValues } from './license-scope';
import { LicenseScopePicker } from './LicenseScopePicker';
import { adminTableSearch } from './presentation';
import type { AuditRecord, BootstrapData, CustomerRecord, DeviceRecord, LicenseRecord, SystemRecord } from './types';

type PageKey = 'overview' | 'customers' | 'licenses' | 'devices' | 'systems' | 'updates' | 'audits' | 'security' | 'enterprises' | 'returns';
type LoginValues = { username: string; password: string; captcha: string };
type CustomerValues = { name: string; contact?: string };
type SystemValues = { name: string; version: string; enabled: boolean };
type LicenseValues = {
  customerId: string; mode: 'online' | 'offline'; expiresDate: Dayjs | string; scope: LicenseScopeValues;
  maxDevices: number; deviceId?: string; allowExport: boolean; allowAutoSync: boolean; allowAutoUpdate: boolean;
};

const dateTime = (value?: number) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const dateOnly = (value?: number) => value ? new Date(value).toLocaleDateString('zh-CN') : '—';
const shortCode = (value: string) => value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
const jsonArray = (value?: string): string[] => {
  try { const parsed = JSON.parse(value ?? '[]'); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
};
const contains = (value: unknown, query: unknown) => !query || String(value ?? '').toLocaleLowerCase().includes(String(query).trim().toLocaleLowerCase());

export function LoginPage({ onSuccess, initialError }: { onSuccess: (data: BootstrapData) => void; initialError?: ApiError }) {
  const { message } = AntApp.useApp();
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [rememberPassword, setRememberPassword] = useState(true);
  const [captcha, setCaptcha] = useState<{id:string;image:string;expiresAt:number} | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [errorText, setErrorText] = useState(initialError?.message ?? '');
  const [blockedUntil, setBlockedUntil] = useState(initialError?.retryAfterSeconds ? Date.now() + initialError.retryAfterSeconds * 1000 : 0);
  const [clock, setClock] = useState(Date.now());
  const seconds = Math.max(0, Math.ceil((blockedUntil - clock) / 1000));
  const clearField = (name: 'password' | 'captcha') => {
    const input = formRef.current?.elements.namedItem(name);
    if (input instanceof HTMLInputElement) input.value = '';
  };
  const refreshCaptcha = useCallback(async () => {
    setRefreshing(true); setCaptcha(null);
    const input = formRef.current?.elements.namedItem('captcha');
    if (input instanceof HTMLInputElement) input.value = '';
    try { setCaptcha(await adminApi.captcha()); }
    catch(error) { setErrorText(error instanceof Error ? error.message : '验证码加载失败，请重试'); }
    finally { setRefreshing(false); }
  },[]);
  useEffect(() => { void refreshCaptcha(); },[refreshCaptcha]);
  useEffect(() => { if (!blockedUntil) return; const timer = window.setInterval(() => { const now=Date.now();setClock(now);if(now>=blockedUntil)setBlockedUntil(0); },1000); return () => window.clearInterval(timer); },[blockedUntil]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!captcha || seconds || submitting) return;
    // Read the actual DOM values: password managers can autofill without firing
    // input/change events, so a React form store may still hold empty values.
    const fields = new FormData(event.currentTarget);
    const values: LoginValues = {
      username: String(fields.get('username') ?? '').trim(),
      password: String(fields.get('password') ?? ''),
      captcha: String(fields.get('captcha') ?? '').trim(),
    };
    if (!values.username) { setErrorText('请输入管理员账号'); return; }
    if (!values.password) { setErrorText('请输入密码'); return; }
    if (!/^[a-zA-Z0-9]{5}$/.test(values.captcha)) { setErrorText('请输入图片中的 5 位验证码'); return; }
    if (captcha.expiresAt <= Date.now()) { setErrorText('验证码已过期，请输入新验证码'); await refreshCaptcha(); return; }
    setErrorText('');
    setSubmitting(true);
    try {
      await adminApi.login({...values,captchaId:captcha.id});
      const session = await adminApi.bootstrap();
      if (rememberPassword) offerBrowserPasswordSave(values.username, values.password);
      onSuccess(session);
      message.success('登录成功');
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : '登录失败');
      if (error instanceof ApiError && error.retryAfterSeconds) { setBlockedUntil(Date.now()+error.retryAfterSeconds*1000); setClock(Date.now()); }
      if (error instanceof ApiError && ['LOGIN_FAILED','LOGIN_LOCKED'].includes(error.code??'')) clearField('password');
      await refreshCaptcha();
    } finally { setSubmitting(false); }
  };
  return <main className="login-page">
    <section className="login-introduction" aria-label="管理后台介绍">
      <div className="login-introduction-copy"><Typography.Title>稳定、安全地<br />管理每一次授权。</Typography.Title><Typography.Paragraph>连接业务系统，统一管理客户、企业资料与设备授权。</Typography.Paragraph></div>
      <div className="login-features">
        <div><KeyOutlined /><strong>统一管理</strong><span>客户与授权</span></div>
        <div><DesktopOutlined /><strong>掌握设备</strong><span>使用情况</span></div>
        <div><SafetyCertificateOutlined /><strong>安全保护</strong><span>登录与操作</span></div>
      </div>
    </section>
    <Card className="login-card" bordered={false}>
      <div className="login-brand"><div className="brand-mark" aria-hidden="true">融</div><div><strong>数据融合 · 管理后台</strong><span>授权与运营管理中心</span></div></div>
      <div className="login-copy"><Typography.Title level={2}>欢迎回来</Typography.Title><Typography.Paragraph>请验证身份后进入管理后台</Typography.Paragraph></div>
      {errorText && <Alert className="login-alert" role="alert" type="error" showIcon message={errorText} />}
      {seconds > 0 && <Alert className="login-alert" role="status" type="warning" showIcon message={`请在 ${Math.floor(seconds/60)} 分 ${seconds%60} 秒后重试`} />}
      <form ref={formRef} name="admin-login" action="/api/admin/login" method="post" autoComplete="on" noValidate onSubmit={(event) => void submit(event)}>
        <div className="login-field"><label htmlFor="admin-username">管理员账号</label><Input id="admin-username" name="username" prefix={<UserOutlined />} autoComplete="username" placeholder="请输入账号" maxLength={80} autoFocus readOnly={submitting} size="large" /></div>
        <div className="login-field"><label htmlFor="admin-password">密码</label><Input.Password id="admin-password" name="password" prefix={<LockOutlined />} autoComplete="current-password" aria-describedby="password-manager-help" placeholder="请输入密码" maxLength={256} readOnly={submitting} size="large" /></div>
        <div className="login-field"><label htmlFor="admin-captcha">图片验证码</label>
          <div className="captcha-row"><Input id="admin-captcha" name="captcha" aria-label="图片验证码" autoComplete="off" maxLength={5} placeholder="不区分大小写" disabled={submitting} size="large" />
            <button className="captcha-image" type="button" onClick={() => void refreshCaptcha()} disabled={refreshing || submitting} aria-label="刷新验证码" title="点击更换验证码">{captcha ? <img src={captcha.image} alt="登录验证码，点击更换" /> : refreshing ? '加载中…' : '点击重新加载'}</button></div>
        </div>
        <label className="login-remember"><input type="checkbox" checked={rememberPassword} onChange={event => setRememberPassword(event.target.checked)} />记住密码</label>
        <div id="password-manager-help" className="login-password-help">由当前浏览器保存和自动填入账号密码，验证码仍需每次填写。</div>
        {window.location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) && <div className="login-http-warning">当前使用 HTTP，密码及登录凭证传输未加密，请勿在不可信网络中使用。</div>}
        <Button block type="primary" htmlType="submit" disabled={!captcha || seconds>0} loading={submitting} className="login-submit">{seconds ? '暂时无法登录' : '登录管理后台'}</Button>
      </form>
      <div className="login-security"><SafetyCertificateOutlined /> 连续输错 5 次将锁定 15 分钟<br /><span>验证码两分钟有效，请妥善保管登录信息</span></div>
    </Card>
  </main>;
}

const licenseStatusLabels = { active: '有效', revoked: '已停用', expired: '已过期', customerDisabled: '客户已停用' } as const;

function useLicenseStatus(customers: CustomerRecord[]) {
  const disabledCustomers = useMemo(() => new Set(customers.filter(customer => !customer.enabled).map(customer => customer.id)), [customers]);
  return (license: LicenseRecord): keyof typeof licenseStatusLabels => {
    if (license.status === 'revoked') return 'revoked';
    if (license.customer_enabled === 0 || disabledCustomers.has(license.customer_id)) return 'customerDisabled';
    return license.expires_at <= Date.now() ? 'expired' : 'active';
  };
}
function LicenseStatusTag({ status }: { status: keyof typeof licenseStatusLabels }) {
  return <Tag color={status === 'active' ? 'success' : 'default'}>{licenseStatusLabels[status]}</Tag>;
}

function Overview({ data, onNavigate }: { data: BootstrapData; onNavigate: (page: PageKey) => void }) {
  const statusOf = useLicenseStatus(data.customers);
  const activeLicenses = data.licenses.filter(item => statusOf(item) === 'active');
  const activeDevices = data.devices.filter(item => item.status === 'active');
  const stats = [
    { title: '客户', value: data.summary?.customers ?? data.customers.length, icon: <TeamOutlined />, color: 'neutral' },
    { title: '有效授权', value: data.summary?.activeLicenses ?? activeLicenses.length, icon: <KeyOutlined />, color: 'neutral' },
    { title: '在用设备', value: data.summary?.activeDevices ?? activeDevices.length, icon: <DesktopOutlined />, color: 'neutral' },
    { title: '业务系统', value: data.summary?.enabledSystems ?? data.systems.filter((item) => item.enabled).length, icon: <CodeSandboxOutlined />, color: 'neutral' },
  ];
  const latestRelease = data.summary?.latestRelease ?? data.updates.filter(item => item.target_type === 'app' && item.enabled).sort((a, b) => b.published_at - a.published_at)[0];
  const names = new Map([...data.systems, ...data.tools].map(item => [item.id, item.name]));
  return <PageContainer className="overview-page" title="运营概览" subTitle={new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })} ghost>
    <Row gutter={[12, 12]}>{stats.map((item) => <Col xs={12} lg={6} key={item.title}><Card className="stat-card" bordered={false}><div className={`stat-icon ${item.color}`}>{item.icon}</div><Statistic title={item.title} value={item.value} /></Card></Col>)}</Row>
    <Card title="最近授权" extra={<Button type="link" onClick={() => onNavigate('licenses')}>全部授权</Button>} className="overview-licenses" bordered={false}><ProTable<LicenseRecord> rowKey="id" search={false} options={false} pagination={false} scroll={{ x: 680 }} dataSource={data.summary?.recentLicenses ?? data.licenses.slice(0, 6)} columns={[
        { title: '客户', dataIndex: 'customer_name', ellipsis: true },
        { title: '授权范围', width: '38%', render: (_, row) => [...jsonArray(row.allowed_systems_json), ...jsonArray(row.allowed_tools_json)].map(id => names.get(id) ?? id).join('、') || '—' },
        { title: '方式', dataIndex: 'mode', width: 85, render: (_, row) => <Tag color={row.mode === 'online' ? 'blue' : 'gold'}>{row.mode === 'online' ? '在线' : '离线'}</Tag> },
        { title: '有效期至', dataIndex: 'expires_at', width: 120, render: (_, row) => dateOnly(row.expires_at) },
        { title: '状态', dataIndex: 'status', width: 110, render: (_, row) => <LicenseStatusTag status={statusOf(row)} /> },
      ]} /></Card>
    <Card title="授权与版本说明" bordered={false} className="overview-notes"><div className="overview-note-grid">
      <div className="model-item"><CloudServerOutlined /><div><strong>在线激活</strong><span>激活码绑定设备，在线校验与自动更新</span></div></div>
      <div className="model-item"><SafetyCertificateOutlined /><div><strong>离线许可证</strong><span>许可证绑定设备码，安装包人工更新</span></div></div>
      <div className="model-item"><CodeSandboxOutlined /><div><strong>最近发布版本</strong><span>{latestRelease ? `${latestRelease.version} · ${dateOnly(latestRelease.published_at)}` : '暂无已上线的应用版本'}</span></div></div>
    </div></Card>
  </PageContainer>;
}

function CustomersPage({ data, reload }: { data: BootstrapData; reload: () => Promise<void> }) {
  const paged = useManagementTable<CustomerRecord>(data, 'customers');
  const canManage = data.user?.role !== 'viewer';
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CustomerRecord | null>(null);
  const [filters, setFilters] = useState<Record<string, unknown>>({});
  const filteredRows = data.customers.filter((row) => contains(row.name, filters.name) && contains(row.contact, filters.contact)
    && (filters.enabled === undefined || filters.enabled === '' || String(row.enabled) === String(filters.enabled)));
  const columns: ProColumns<CustomerRecord>[] = [
    { title: '客户/单位名称', dataIndex: 'name', copyable: true, ellipsis: true },
    { title: '联系人或备注', dataIndex: 'contact', ellipsis: true, renderText: (value) => value || '—' },
    { title: '状态', dataIndex: 'enabled', width: 90, valueEnum: { 1: { text: '启用', status: 'Success' }, 0: { text: '停用', status: 'Default' } } },
    { title: '创建时间', dataIndex: 'created_at', search: false, valueType: 'dateTime', width: 180, render: (_, row) => dateTime(row.created_at) },
    { title: '操作', valueType: 'option', width: 150, hideInTable: !canManage, render: (_, row) => <Space><Button type="link" icon={<EditOutlined />} onClick={() => { setEditing(row); setOpen(true); }}>编辑</Button><Popconfirm title={row.enabled ? '确定停用该客户？' : '确定重新启用该客户？'} onConfirm={async () => { await adminApi.updateCustomer(row.id, { enabled: !row.enabled }); message.success(row.enabled ? '客户已停用' : '客户已启用'); await reload(); }}><Button danger={Boolean(row.enabled)} type="link">{row.enabled ? '停用' : '启用'}</Button></Popconfirm></Space> },
  ];
  return <PageContainer title="客户管理" subTitle="维护授权单位及联系人" extra={canManage ? <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setOpen(true); }}>新增客户</Button> : undefined}>
    <ProTable<CustomerRecord> {...paged} rowKey="id" headerTitle={false} dataSource={data.paginated ? undefined : filteredRows} columns={columns} search={adminTableSearch} onSubmit={(values) => setFilters(values)} onReset={() => setFilters({})} pagination={{ defaultPageSize: 10 }} options={{ reload }} scroll={{ x: 800 }} />
    <ModalForm<CustomerValues> key={editing?.id ?? 'new-customer'} width={440} title={editing ? '编辑客户' : '新增客户'} open={open} onOpenChange={setOpen} initialValues={editing ?? undefined} modalProps={{ destroyOnClose: true, className: 'admin-form-sheet', styles: { mask: { background: 'rgba(29,29,31,.08)' } } }} onFinish={async (values) => { if (editing) await adminApi.updateCustomer(editing.id, values); else await adminApi.createCustomer(values); message.success(editing ? '客户信息已更新' : '客户已创建'); await reload(); return true; }}>
      <ProFormText name="name" label="客户/单位名称" rules={[{ required: true }, { max: 200 }]} />
      <ProFormText name="contact" label="联系人或备注" rules={[{ max: 200 }]} />
    </ModalForm>
  </PageContainer>;
}

function LicenseMatterTags({ license, systemMap, matterMap }: { license: LicenseRecord; systemMap: Map<string, string>; matterMap: Map<string, string> }) {
  try {
    const scope = licenseScopeSnapshot(license);
    return <Space wrap>{scope.allowedSystems.flatMap(systemId => {
      if (!scope.allowedMatters || !Object.hasOwn(scope.allowedMatters, systemId)) return [<Tag key={systemId}>{systemMap.get(systemId) ?? systemId} · 全部事项（历史授权）</Tag>];
      const ids = scope.allowedMatters[systemId];
      return ids.length ? ids.map(id => <Tag color="blue" key={`${systemId}:${id}`}>{matterMap.get(`${systemId}:${id}`) ?? id}</Tag>) : [<Tag key={systemId}>{systemMap.get(systemId) ?? systemId} · 无业务事项</Tag>];
    })}</Space>;
  } catch { return <Typography.Text type="danger">授权范围数据异常，请联系管理员核查</Typography.Text>; }
}

function LicensesPage({ data, reload }: { data: BootstrapData; reload: () => Promise<void> }) {
  const paged = useManagementTable<LicenseRecord>(data, 'licenses');
  const canManage = data.user?.role !== 'viewer';
  const { message, modal } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<LicenseRecord | null>(null);
  useEffect(() => {
    if (!selected) return;
    if (!data.paginated) { setSelected(data.licenses.find(row => row.id === selected.id) ?? null); return; }
    const controller = new AbortController();
    void listManagement<LicenseRecord>('licenses', { id: selected.id, pageSize: 1 }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setSelected(result.rows[0] ?? null); }).catch(() => {});
    return () => controller.abort();
  }, [data, selected?.id]);
  const [renewing, setRenewing] = useState<LicenseRecord | null>(null);
  const [scopeEditing, setScopeEditing] = useState<LicenseRecord | null>(null);
  const [filters, setFilters] = useState<Record<string, unknown>>({});
  const systemMap = useMemo(() => new Map(data.systems.map((item) => [item.id, item.name])), [data.systems]);
  const matterMap = useMemo(() => new Map(data.matters.map((item) => [`${item.system_id}:${item.id}`, item.name])), [data.matters]);
  const statusOf = useLicenseStatus(data.customers);
  const selectedStatus = selected && statusOf(selected);
  const reference = String(filters.reference ?? '').trim().toLowerCase();
  const deviceLicenses = useMemo(() => {
    const matching = new Set<string>();
    if (!reference) return matching;
    const masked = /^[0-9a-f]{12}(?:…|\.\.\.)[0-9a-f]{8}$/.test(reference);
    const deviceReference = masked ? reference.replace('...', '…') : reference;
    for (const device of data.devices) {
      const code = device.device_id.toLowerCase();
      if (code === deviceReference || (masked && shortCode(code) === deviceReference)) matching.add(device.license_id);
    }
    return matching;
  }, [data.devices, reference]);
  const componentOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const item of data.systems) names.set('system:' + item.id, item.name);
    for (const item of data.tools ?? []) names.set('tool:' + item.id, item.name);
    for (const license of data.licenses) {
      for (const id of jsonArray(license.allowed_systems_json)) if (!names.has('system:' + id)) names.set('system:' + id, id);
      for (const id of jsonArray(license.allowed_tools_json)) if (!names.has('tool:' + id)) names.set('tool:' + id, id);
    }
    return Array.from(names, ([value, label]) => ({ value, label }));
  }, [data.systems, data.tools, data.licenses]);
  const filteredRows = data.licenses.filter((row) => (!reference || row.id.toLowerCase() === reference || deviceLicenses.has(row.id))
    && contains(row.customer_name, filters.customer_name) && (!filters.mode || row.mode === filters.mode)
    && (!filters.component || jsonArray(row.allowed_systems_json).some(id => filters.component === 'system:' + id)
      || jsonArray(row.allowed_tools_json).some(id => filters.component === 'tool:' + id))
    && (!filters.status || statusOf(row) === filters.status));
  const columns: ProColumns<LicenseRecord>[] = [
    { title: '授权编号或设备码', dataIndex: 'reference', hideInTable: true,
      fieldProps: { placeholder: '粘贴授权编号或设备码', allowClear: true } },
    { title: '客户', dataIndex: 'customer_name', ellipsis: true },
    { title: '授权编号', dataIndex: 'id', search: false, width: 170,
      render: (_, row) => <Typography.Text code title={row.id} copyable={{ text: row.id, tooltips: ['复制授权编号', '已复制'] }}>{shortCode(row.id)}</Typography.Text> },
    { title: '授权系统 / 工具', dataIndex: 'component', hideInTable: true, valueType: 'select',
      fieldProps: { options: componentOptions, showSearch: true, optionFilterProp: 'label', allowClear: true, placeholder: '搜索系统或工具' } },
    { title: '激活方式', dataIndex: 'mode', width: 105, valueEnum: { online: { text: '在线', status: 'Processing' }, offline: { text: '离线', status: 'Warning' } } },
    { title: '授权系统 / 工具', dataIndex: 'allowed_systems_json', search: false, render: (_, row) => <Space size={[0, 4]} wrap>{jsonArray(row.allowed_systems_json).map((id) => <Tag key={id}>{systemMap.get(id) ?? id}</Tag>)}{jsonArray(row.allowed_tools_json).map(id => <Tag color="purple" key={`tool:${id}`}>{data.tools?.find(tool => tool.id === id)?.name ?? id}</Tag>)}</Space> },
    { title: '设备数', dataIndex: 'max_devices', width: 85, search: false },
    { title: '有效期至', dataIndex: 'expires_at', width: 125, valueType: 'date', search: false, render: (_, row) => dateOnly(row.expires_at) },
    { title: '状态', dataIndex: 'status', width: 110, valueEnum: licenseStatusLabels, render: (_, row) => <LicenseStatusTag status={statusOf(row)} /> },
    { title: '操作', valueType: 'option', width: reference && canManage ? 216 : 150, render: (_, row) => <Space wrap size={4}>
      <Button type="link" icon={<EyeOutlined />} onClick={() => setSelected(row)}>详情</Button>
      {reference && canManage && statusOf(row) === 'active' && <Button type="link" onClick={() => setScopeEditing(row)}>调整授权</Button>}
      {canManage && row.status === 'active' && <Popconfirm title="确定停用该授权？" description="其下在线设备将在下次校验时失效。" onConfirm={async () => { await adminApi.revokeLicense(row.id); message.success('授权已停用'); await reload(); }}><Button danger type="link">停用</Button></Popconfirm>}
    </Space> },
  ];
  const showKey = (value: string, offline: boolean) => modal.info({
    width: 720, title: offline ? '离线许可证已生成' : '在线激活码已生成',
    content: <div className="key-result"><Typography.Paragraph type="secondary">密钥只在本次操作中展示，请立即保存并安全交付。</Typography.Paragraph><Input.TextArea value={value} autoSize={{ minRows: 4, maxRows: 10 }} readOnly /><Button icon={<KeyOutlined />} onClick={async () => { await navigator.clipboard.writeText(value); message.success('密钥已复制'); }}>复制密钥</Button></div>,
  });
  return <PageContainer title="授权管理" subTitle="签发在线激活码或绑定设备的离线许可证">
    {scopeEditing && canManage && <LicenseScopeEditor key={scopeEditing.id} license={scopeEditing} data={data} onClose={() => setScopeEditing(null)} onSaved={async () => { setSelected(null); await reload(); }} />}
    <ModalForm<{ expiresDate: string }> title="授权续期" open={Boolean(renewing)} onOpenChange={(value) => { if (!value) setRenewing(null); }} modalProps={{ destroyOnClose: true }} onFinish={async (values) => {
      if (!renewing) return false;
      try { await adminApi.renewLicense(renewing.id, dayjs(values.expiresDate).endOf('day').valueOf()); message.success(renewing.mode === 'offline' ? '已续期，请补发许可证并在客户端重新导入' : '已续期，客户端下次在线校验生效'); setSelected(null); await reload(); return true; } catch { return false; }
    }}><ProFormDatePicker name="expiresDate" label="新的截止日期" rules={[{ required: true }]} /></ModalForm>
    <ProTable<LicenseRecord> {...paged} rowKey="id" headerTitle="全部授权" dataSource={data.paginated ? undefined : filteredRows} columns={columns} search={adminTableSearch} onSubmit={(values) => setFilters(values)} onReset={() => setFilters({})} pagination={{ defaultPageSize: 10 }} options={{ reload }} scroll={{ x: 1050 }} toolBarRender={() => canManage ? [<Button type="primary" icon={<PlusOutlined />} key="new" onClick={() => setOpen(true)}>签发授权</Button>] : []} />
    <ModalForm<LicenseValues> title="签发授权" width={720} open={open} onOpenChange={setOpen} modalProps={{ destroyOnClose: true, keyboard: false, maskClosable: false }} initialValues={{ mode: 'online', scope: emptyScope, maxDevices: 1, allowExport: true, allowAutoSync: false, allowAutoUpdate: true }} onFinish={async (values) => {
      const { scope, ...settings } = values;
      const dateValue = dayjs.isDayjs(values.expiresDate) ? values.expiresDate : dayjs(values.expiresDate);
      const result = await adminApi.createLicense({ ...settings, ...scope, maxDevices: values.mode === 'offline' ? 1 : values.maxDevices, expiresAt: dateValue.endOf('day').valueOf(), allowAutoUpdate: values.mode === 'online' && values.allowAutoUpdate });
      await reload(); message.success('授权已生成'); showKey(result.activationCode ?? result.offlineKey ?? '', values.mode === 'offline'); return true;
    }}>
      <Row gutter={16}><Col xs={24} sm={12}><Form.Item name="customerId" label="客户单位" rules={[{ required: true }]}><CustomerSelect data={data} enabledOnly placeholder="搜索客户单位" /></Form.Item></Col><Col xs={24} sm={12}><ProFormSelect name="mode" label="激活方式" options={[{ label: '在线激活', value: 'online' }, { label: '离线激活', value: 'offline' }]} rules={[{ required: true }]} /></Col></Row>
      <Row gutter={16}><Col xs={24} sm={12}><ProFormDatePicker name="expiresDate" label="授权有效期" width="md" fieldProps={{ disabledDate: (current: Dayjs) => current && current < dayjs().startOf('day') }} rules={[{ required: true }]} /></Col><Col xs={24} sm={12}><ProFormDependency name={['mode']}>{({ mode }) => mode === 'offline' ? <Typography.Paragraph>离线授权固定绑定 1 台设备</Typography.Paragraph> : <ProFormDigit name="maxDevices" label="最大设备数" fieldProps={{ precision: 0 }} min={1} max={100} width="md" rules={[{ required: true }]} />}</ProFormDependency></Col></Row>
      <Form.Item name="scope" label="授权范围" rules={[{ validator: async (_, value) => {
        const error = scopeValidationError(value ?? emptyScope, data.matters);
        if (error) throw new Error(error);
      } }]}><LicenseScopePicker data={data} /></Form.Item>
      <ProFormDependency name={['mode']}>{({ mode }) => mode === 'offline' ? <ProFormText name="deviceId" label="离线设备码" fieldProps={{ maxLength: 64, showCount: true }} rules={[{ required: true }, { pattern: /^[a-f0-9]{64}$/, message: '请输入 64 位小写设备码' }]} /> : null}</ProFormDependency>
      <Row gutter={16}><Col span={8}><ProFormSwitch name="allowExport" label="允许导出" /></Col><Col span={8}><ProFormSwitch name="allowAutoSync" label="允许自动同步" /></Col><Col span={8}><ProFormDependency name={['mode']}>{({ mode }) => mode === 'online' ? <ProFormSwitch name="allowAutoUpdate" label="允许自动更新" /> : null}</ProFormDependency></Col></Row>
    </ModalForm>
    <Drawer width={620} className="license-details-drawer" title="授权详情" open={Boolean(selected)} onClose={() => setSelected(null)} extra={selected && (selectedStatus === 'active' || selectedStatus === 'expired') && canManage ? <Space wrap>
      <Button icon={<EditOutlined />} disabled={selectedStatus === 'expired'} title={selectedStatus === 'expired' ? '请先续期授权' : undefined} onClick={() => setScopeEditing(selected)}>调整授权</Button>
      <Button onClick={() => setRenewing(selected)}>续期</Button>
      {selected.mode === 'online' ? <Popconfirm title="生成新激活码？" description="未使用的旧码将失效；已激活设备不受影响。设备满额时请先到设备管理停用旧设备。" onConfirm={async () => { try { const result = await adminApi.issueCode(selected.id); showKey(result.activationCode, false); await reload(); } catch {} }}><Button disabled={selectedStatus !== 'active'}>补发/追加激活码</Button></Popconfirm>
        : <Button disabled={selectedStatus !== 'active'} onClick={async () => { try { const result = await adminApi.offlineKey(selected.id); showKey(result.offlineKey, true); } catch {} }}>补发离线许可证</Button>}
    </Space> : undefined}>{selected && <Descriptions bordered column={1} size="small" items={[
      { key: 'customer', label: '客户单位', children: selected.customer_name },
      { key: 'mode', label: '激活方式', children: selected.mode === 'online' ? '在线激活' : '离线激活' },
      { key: 'systems', label: '授权系统', children: <Space wrap>{jsonArray(selected.allowed_systems_json).map((id) => <Tag key={id}>{systemMap.get(id) ?? id}</Tag>)}</Space> },
      { key: 'tools', label: '授权工具', children: <Space wrap>{jsonArray(selected.allowed_tools_json).map(id => <Tag color="purple" key={id}>{data.tools?.find(tool => tool.id === id)?.name ?? id}</Tag>)}</Space> },
      { key: 'matters', label: '授权事项', children: <LicenseMatterTags license={selected} systemMap={systemMap} matterMap={matterMap} /> },
      { key: 'devices', label: '最大设备数', children: selected.max_devices },
      { key: 'features', label: '功能权限', children: <Space wrap>{selected.allow_export ? <Tag color="green">数据导出</Tag> : null}{selected.allow_auto_sync ? <Tag color="green">自动同步</Tag> : null}{selected.allow_auto_update ? <Tag color="green">自动更新</Tag> : null}</Space> },
      { key: 'expires', label: '有效期至', children: dateTime(selected.expires_at) },
      { key: 'status', label: '当前状态', children: <LicenseStatusTag status={statusOf(selected)} /> },
      { key: 'id', label: '授权编号', children: <Typography.Text copyable>{selected.id}</Typography.Text> },
    ]} />}</Drawer>
  </PageContainer>;
}

function DevicesPage({ data, reload }: { data: BootstrapData; reload: () => Promise<void> }) {
  const paged = useManagementTable<DeviceRecord>(data, 'devices');
  const canManage = data.user?.role !== 'viewer';
  const { message } = AntApp.useApp();
  const [filters, setFilters] = useState<Record<string, unknown>>({});
  const filteredRows = data.devices.filter((row) => contains(row.customer_name, filters.customer_name) && contains(row.device_id, filters.device_id) && (!filters.status || row.status === filters.status));
  const columns: ProColumns<DeviceRecord>[] = [
    { title: '客户', dataIndex: 'customer_name', ellipsis: true },
    { title: '设备码', dataIndex: 'device_id', copyable: true, ellipsis: true, renderText: (value) => shortCode(String(value)) },
    { title: '激活时间', dataIndex: 'activated_at', valueType: 'dateTime', search: false, render: (_, row) => dateTime(row.activated_at) },
    { title: '最后在线', dataIndex: 'last_seen_at', valueType: 'dateTime', search: false, render: (_, row) => dateTime(row.last_seen_at) },
    { title: '状态', dataIndex: 'status', valueEnum: { active: { text: '在用', status: 'Success' }, revoked: { text: '已停用', status: 'Default' } } },
    { title: '操作', valueType: 'option', hideInTable: !canManage, render: (_, row) => row.status === 'active' ? <Popconfirm title="确定停用该设备？" description="在线设备下次校验生效；离线许可证不能远程即时停用。" onConfirm={async () => { await adminApi.revokeDevice(row.id); message.success('设备已停用'); await reload(); }}><Button danger type="link">停用</Button></Popconfirm> : null },
  ];
  return <PageContainer title="设备管理" subTitle="在线校验与离线绑定分别管理"><Alert className="page-notice" type="info" showIcon message="在线设备约每 5 分钟校验；离线绑定记录不代表当前在线，无法远程即时停用。换机请先停用旧设备，再补发激活码。" /><ProTable<DeviceRecord> {...paged} rowKey="id" headerTitle="设备列表" dataSource={data.paginated ? undefined : filteredRows} columns={columns} search={adminTableSearch} onSubmit={(values) => setFilters(values)} onReset={() => setFilters({})} pagination={{ defaultPageSize: 10 }} options={{ reload }} scroll={{ x: 900 }} /></PageContainer>;
}

function SystemsPage({ data, reload }: { data: BootstrapData; reload: () => Promise<void> }) {
  const canManage = data.user?.role === 'admin';
  const { message } = AntApp.useApp();
  const [filters, setFilters] = useState<Record<string, unknown>>({});
  const [editing, setEditing] = useState<SystemRecord | null>(null);
  const counts = useMemo(() => new Map(data.systems.map((system) => [system.id, data.summary?.systemLicenseCounts[system.id] ?? data.licenses.filter((license) => jsonArray(license.allowed_systems_json).includes(system.id)).length])), [data]);
  const filteredRows = data.systems.filter((row) => contains(row.name, filters.name) && contains(row.id, filters.id) && (filters.enabled === undefined || filters.enabled === '' || String(row.enabled) === String(filters.enabled)));
  const columns: ProColumns<SystemRecord>[] = [
    { title: '系统名称', dataIndex: 'name' }, { title: '系统标识', dataIndex: 'id', copyable: true },
    { title: '版本', dataIndex: 'version', width: 110, search: false }, { title: '授权数', search: false, width: 100, render: (_, row) => counts.get(row.id) ?? 0 },
    { title: '状态', dataIndex: 'enabled', width: 90, valueEnum: { 1: { text: '启用', status: 'Success' }, 0: { text: '停用', status: 'Default' } } },
    { title: '加入时间', dataIndex: 'created_at', search: false, valueType: 'dateTime', render: (_, row) => dateTime(row.created_at) },
    { title: '操作', valueType: 'option', width: 90, hideInTable: !canManage, render: (_, row) => <Button type="link" icon={<EditOutlined />} onClick={() => setEditing(row)}>维护</Button> },
  ];
  return <PageContainer title="业务系统" subTitle="管理业务系统及可分配范围"><Alert className="page-notice" type="info" showIcon message="停用仅禁止新分配，不撤销既有授权；如需撤销，请前往客户或授权管理停用。" /><ProTable<SystemRecord> rowKey="id" headerTitle="系统列表" dataSource={filteredRows} columns={columns} search={adminTableSearch} onSubmit={(values) => setFilters(values)} onReset={() => setFilters({})} pagination={false} options={{ reload }} scroll={{ x: 950 }} />
    <ModalForm<SystemValues> key={editing?.id ?? 'system'} title="维护业务系统" open={Boolean(editing)} onOpenChange={(value) => { if (!value) setEditing(null); }} initialValues={editing ? { name: editing.name, version: editing.version, enabled: Boolean(editing.enabled) } : undefined} modalProps={{ destroyOnClose: true }} onFinish={async (values) => { if (!editing) return false; await adminApi.updateSystem(editing.id, values); message.success('业务系统已更新'); await reload(); return true; }}>
      <ProFormText name="name" label="系统名称" rules={[{ required: true }, { max: 200 }]} />
      <ProFormText name="version" label="当前版本" rules={[{ required: true }, { pattern: /^\d+\.\d+\.\d+$/, message: '请输入正确版本号' }]} />
      <ProFormSwitch name="enabled" label="允许分配授权" />
    </ModalForm>
  </PageContainer>;
}

function AuditPage() {
  const labels: Record<string, string> = {
    'admin.login': '管理员登录', 'admin.login_restored': '恢复记住的登录', 'admin.logout': '管理员退出', 'customer.created': '创建客户', 'customer.updated': '更新客户',
    'license.created': '签发授权', 'license.revoked': '停用授权', 'device.revoked': '停用设备', 'system.updated': '更新业务系统',
    'update.created': '发布版本', 'update.updated': '变更版本状态', 'update.uploaded': '上传版本草稿', 'update.interrupted_upload_recovered': '恢复中断的上传',
    'license.renewed': '授权续期', 'license.scope_updated': '调整授权范围', 'license.code_issued': '补发激活码', 'license.offline_reissued': '补发离线许可证',
    'admin.created': '新增后台账号', 'admin.updated': '修改账号权限', 'admin.password_changed': '修改密码',
    'enterprise.created': '登记企业', 'enterprise.corrected': '修正企业资料', 'enterprise.queried': '查询企业', 'enterprise.revalidated': '重新核验企业', 'enterprise.settings': '变更企业查询开关',
  };
  const columns: ProColumns<AuditRecord>[] = [
    { title: '操作时间', dataIndex: 'created_at', width: 180, search: false, render: (_, row) => dateTime(row.created_at) },
    { title: '管理员', dataIndex: 'username', width: 130 },
    { title: '操作类型', dataIndex: 'action', width: 170, valueEnum: labels, render: (_, row) => labels[row.action] ?? row.action },
    { title: '对象类型', dataIndex: 'target_type', width: 130, search: false, renderText: (value) => value || '—' },
    { title: '对象 ID', dataIndex: 'target_id', ellipsis: true, copyable: true, search: false, renderText: (value) => value || '—' },
    { title: '详细信息', dataIndex: 'metadata_json', ellipsis: true, search: false, renderText: (value) => value || '—' },
  ];
  return <PageContainer title="操作审计" subTitle="按条件查询全部历史记录，每页 20 条"><ProTable<AuditRecord> rowKey="id" columns={columns} search={adminTableSearch} request={async (params) => { const result = await adminApi.audits(params.current ?? 1, String(params.username ?? ''), String(params.action ?? '')); return { data: result.rows, total: result.total, success: true }; }} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 1050 }} /></PageContainer>;
}

export function AdminShell({ initialData, onLoggedOut }: { initialData: BootstrapData; onLoggedOut: () => void }) {
  const { message } = AntApp.useApp();
  const [data, setData] = useState(initialData);
  const [page, setPage] = useState<PageKey>(() => { const value=window.location.hash.slice(2); return ['overview','customers','enterprises','returns','licenses','devices','systems','updates','audits','security'].includes(value) ? value as PageKey : 'overview'; });
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  useEffect(()=>{window.location.hash=`/${page}`;},[page]);
  useEffect(()=>{const handler=()=>{const value=window.location.hash.slice(2);if(['overview','customers','enterprises','returns','licenses','devices','systems','updates','audits','security'].includes(value))setPage(value as PageKey);};window.addEventListener('hashchange',handler);return()=>window.removeEventListener('hashchange',handler);},[]);
  const reload = useCallback(async () => {
    try { setData(await adminApi.bootstrap()); }
    catch (error) { if (error instanceof ApiError && error.status === 401) onLoggedOut(); else message.error(error instanceof Error ? error.message : '数据刷新失败'); }
  }, [message, onLoggedOut]);
  useEffect(() => {
    const listener = (event: Event) => {
      const error = (event as CustomEvent<ApiError>).detail;
      if (error.status === 401) { message.warning('登录已失效，请重新登录'); onLoggedOut(); }
      else message.error(error.message);
    };
    window.addEventListener('admin-api-error', listener);
    return () => window.removeEventListener('admin-api-error', listener);
  }, [message, onLoggedOut]);
  const logout = async () => { try { await adminApi.logout(); onLoggedOut(); } catch {} };
  const route = { path: '/', routes: [
    { path: '/overview', name: '运营概览', icon: <DashboardOutlined /> },
    { path: '/customers', name: '客户管理', icon: <TeamOutlined /> },
    { path: '/enterprises', name: '企业信息', icon: <TeamOutlined /> },
    { path: '/returns', name: '回流数据', icon: <HistoryOutlined /> },
    { path: '/licenses', name: '授权管理', icon: <KeyOutlined /> },
    { path: '/devices', name: '设备管理', icon: <DesktopOutlined /> },
    { path: '/systems', name: '业务系统', icon: <CodeSandboxOutlined /> },
    { path: '/updates', name: '版本更新', icon: <CloudServerOutlined /> },
    { path: '/audits', name: '操作审计', icon: <HistoryOutlined /> },
    { path: '/security', name: '账号与安全', icon: <LockOutlined /> },
  ] };
  const content = page === 'overview' ? <Overview data={data} onNavigate={setPage} /> : page === 'customers' ? <CustomersPage data={data} reload={reload} /> : page === 'licenses' ? <LicensesPage data={data} reload={reload} /> : page === 'devices' ? <DevicesPage data={data} reload={reload} /> : page === 'systems' ? <SystemsPage data={data} reload={reload} /> : page === 'updates' ? <UpdatesPage data={data} reload={reload} /> : page === 'returns' ? <ReturnDataPage data={data} /> : page === 'security' ? <SecurityPage role={data.user?.role} onLoggedOut={onLoggedOut} /> : <AuditPage />;
  return <div className={`apple-admin-layout ${collapsed ? 'is-collapsed' : ''}`}>
    <button type="button" className="skip-to-content" onClick={() => document.getElementById('admin-main')?.focus()}>跳到主要内容</button>
    {mobileMenuOpen && <button type="button" className="admin-menu-backdrop" aria-label="关闭导航菜单" onClick={() => setMobileMenuOpen(false)} />}
    <aside id="admin-navigation" className={`admin-sidebar ${collapsed ? 'ant-layout-sider-collapsed' : ''} ${mobileMenuOpen ? 'is-mobile-open' : ''}`} aria-label="管理导航">
      <div className="admin-brand"><div className="layout-logo" aria-hidden="true">融</div><span>数据融合<strong>管理后台</strong></span></div>
      <button className="ant-pro-sider-collapsed-button admin-collapse-button" type="button" onClick={() => setCollapsed(value => !value)} aria-label={collapsed ? '展开侧栏' : '收起侧栏'} aria-expanded={!collapsed}>{collapsed ? <RightOutlined /> : <LeftOutlined />}</button>
      <nav>{route.routes.map(item => <a key={item.path} href={`#${item.path}`} title={item.name} aria-label={item.name} aria-current={item.path === `/${page}` ? 'page' : undefined} onClick={(event) => { event.preventDefault(); setPage(item.path.slice(1) as PageKey); setMobileMenuOpen(false); }}>{item.icon}<span className="nav-label">{item.name}</span></a>)}</nav>
      <div className="admin-sidebar-footer"><SafetyCertificateOutlined /><span>授权与运营管理中心</span></div>
    </aside>
    <div className="admin-main-column"><header className="admin-topbar">
      <button type="button" className="admin-mobile-menu" aria-label={mobileMenuOpen ? '关闭导航菜单' : '打开导航菜单'} aria-controls="admin-navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(value => !value)}><MenuOutlined /></button>
      <div className="admin-topbar-actions"><Button type="text" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button><Button type="text" icon={<LogoutOutlined />} onClick={() => void logout()}>退出</Button><span className="admin-user"><span className="admin-user-avatar"><CustomerServiceOutlined /></span><span>{data.user?.username ?? '管理员'}</span></span></div>
    </header>
      <main id="admin-main" tabIndex={-1} className="admin-content">{Boolean(data.user?.passwordChangeRequired) && <Alert type="warning" showIcon message="当前账号需要升级密码" description="请到账号与安全设置符合新规则的密码，之后即可继续管理操作。" action={<Button onClick={()=>setPage('security')}>修改密码</Button>} style={{marginBottom:16}} />}{page === 'enterprises' ? <EnterprisePage role={data.user?.role} /> : content}</main>
    </div>
  </div>;
}

export default function AdminApp() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<BootstrapData | null>(null);
  const [startupError,setStartupError]=useState('');
  const [loginError, setLoginError] = useState<ApiError>();
  const reloadSession = useCallback(() => {
    setLoading(true); setStartupError(''); setLoginError(undefined);
    void loadAdminSession().then(setData).catch(error => {
      setData(null);
      if (error instanceof ApiError && error.status === 429) setLoginError(error);
      else if (!(error instanceof ApiError && error.status === 401)) setStartupError(error instanceof Error ? error.message : '后台加载失败');
    }).finally(() => setLoading(false));
  }, []);
  useEffect(reloadSession, [reloadSession]);
  if (loading) return <Spin fullscreen tip="正在载入管理后台…" />;
  if (startupError) return <Result status="warning" title="暂时无法连接管理后台" subTitle={startupError} extra={<Button type="primary" onClick={()=>window.location.reload()}>重新连接</Button>} />;
  if (!data) return <LoginPage onSuccess={setData} initialError={loginError} />;
  return <AdminShell initialData={data} onLoggedOut={reloadSession} />;
}
