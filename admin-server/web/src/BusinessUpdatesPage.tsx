import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Descriptions, Form, Input, Modal, Progress, Segmented, Space, Tag, Typography } from 'antd';
import { CloudUploadOutlined, PlusOutlined } from '@ant-design/icons';
import { ModalForm, PageContainer, ProFormText, ProTable, type ProColumns } from '@ant-design/pro-components';
import { ReleaseTargetPicker } from './UpdatesPage';
import { RELEASE_VERSION_PATTERN, releaseFileSize } from './releases';
import { businessApi, businessFileError, businessReleasesForTarget, businessTargetLabel, defaultBusinessTarget, uploadBusinessRelease, type BusinessRelease, type BusinessReleaseList, type BusinessTarget } from './business-releases';
import type { BootstrapData } from './types';

const label = { uploading: '上传中', draft: '待发布', published: '已发布', disabled: '已下线' };
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试';
export function BusinessReleaseDetails({ release, storageMode = 'oss' }: { release: BusinessRelease; storageMode?: 'oss' | 'local' }) {
  return <Descriptions column={1} size="small" className="release-details">
    <Descriptions.Item label="业务版本">{release.version}</Descriptions.Item>
    <Descriptions.Item label="运行环境">{businessTargetLabel(release.target)}</Descriptions.Item>
    <Descriptions.Item label="最低基础版本">{release.metadata?.minShellVersion ?? '校验中'}</Descriptions.Item>
    <Descriptions.Item label="后台地址">{release.metadata?.backend.origin ?? '校验中'}</Descriptions.Item>
    <Descriptions.Item label="地址修订号">{release.metadata?.backend.revision ?? '—'}</Descriptions.Item>
    <Descriptions.Item label="业务包">{release.fileName} · {releaseFileSize(release.bytes)}</Descriptions.Item>
    <Descriptions.Item label="服务器 SHA256"><Typography.Text copyable className="release-hash">{release.sha256 || '校验中'}</Typography.Text></Descriptions.Item>
    <Descriptions.Item label={storageMode === 'local' ? '内网更新入口' : '固定 OSS 更新入口'}><Typography.Text copyable className="release-url">{release.feedUrl ?? '尚未配置更新入口'}</Typography.Text></Descriptions.Item>
    {release.enabled && <Descriptions.Item label="业务包下载"><Typography.Text copyable className="release-url">{release.url}</Typography.Text></Descriptions.Item>}
    {release.notes && <Descriptions.Item label="更新说明">{release.notes}</Descriptions.Item>}
  </Descriptions>;
}
export function BusinessDistributionNotice({ catalog }: { catalog: BusinessReleaseList }) {
  return <>
    <Alert className="page-notice" type="info" showIcon message={catalog.storageMode === 'local' ? '通过内网发布业务更新' : '通过固定 OSS 入口发布业务更新'}
      description={`新基础包启动时从${catalog.storageMode === 'local' ? '内网更新入口' : '固定 OSS 入口'}检查业务版本。离线时允许使用已校验版本；确认存在新版后，必须完成更新才能进入应用。旧客户端继续使用基础安装包通道。`} />
    {!catalog.configured && <Alert className="page-notice" type="warning" showIcon message="业务更新入口尚未就绪" description="可以上传草稿；请先完成当前发布环境配置，再正式发布。" />}
  </>;
}
export function BusinessUpdatesPage({ data }: { data: BootstrapData }) {
  const { message } = App.useApp(), canManage = data.user?.role === 'admin';
  const [target, setTarget] = useState<BusinessTarget>({ ...defaultBusinessTarget });
  const [catalog, setCatalog] = useState<BusinessReleaseList>({ rows: [], configured: false, feedBase: null }), [loadError, setLoadError] = useState('');
  const [open, setOpen] = useState(false), [uploading, setUploading] = useState(false), [percent, setPercent] = useState(0), [uploadError, setUploadError] = useState('');
  const [frozenTarget, setFrozenTarget] = useState(target), [file, setFile] = useState<File | null>(null), [uploaded, setUploaded] = useState<BusinessRelease | null>(null);
  const [changing, setChanging] = useState<BusinessRelease | null>(null), [inspecting, setInspecting] = useState<BusinessRelease | null>(null), [publishError, setPublishError] = useState('');
  const [form] = Form.useForm<{ version: string; notes?: string }>(); const picker = useRef<HTMLInputElement>(null), controller = useRef<AbortController | null>(null), alive = useRef(true);
  const [page, setPage] = useState(1), [loading, setLoading] = useState(false);
  const listController = useRef<AbortController | null>(null);
  const load = async () => {
    listController.current?.abort(); const pending = new AbortController(); listController.current = pending; setLoading(true);
    try { const rows = await businessApi.list(data.paginated ? { paginated: '1', page: String(page), pageSize: '10', ...target, electronMajor: String(target.electronMajor) } : undefined, pending.signal);
      if (alive.current && !pending.signal.aborted) { setCatalog(rows); setLoadError(''); } }
    catch (error) { if (alive.current && !pending.signal.aborted) setLoadError(errorText(error)); }
    finally { if (alive.current && !pending.signal.aborted) setLoading(false); }
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); listController.current?.abort(); }; }, []);
  useEffect(() => { void load(); return () => listController.current?.abort(); }, [data, target, page]);
  const changeTarget = (patch: Partial<BusinessTarget>) => { setPage(1); setTarget(value => { const next = { ...value, ...patch }; if (next.platform === 'win32') { next.arch = 'x64'; next.variant = 'standard'; } else next.electronMajor = 44; return next; }); };
  const begin = () => { setFrozenTarget({ ...target }); form.resetFields(); setFile(null); setUploaded(null); setUploadError(''); setPercent(0); setOpen(true); };
  const close = () => { if (uploading) controller.current?.abort(); else setOpen(false); };
  const upload = async () => {
    if (controller.current) return;
    let values: { version: string; notes?: string }; try { values = await form.validateFields(); } catch { return; }
    const invalid = businessFileError(file, values.version, frozenTarget); if (invalid) { setUploadError(invalid); return; }
    const pending = new AbortController(); controller.current = pending; setUploading(true); setPercent(0); setUploadError('');
    try { const row = await uploadBusinessRelease(file!, { ...values, target: frozenTarget }, { signal: pending.signal, onProgress: value => { if (alive.current) setPercent(value); } });
      if (alive.current) { setUploaded(row); await load(); } } catch (error) { if (alive.current) setUploadError(errorText(error)); }
    finally { if (alive.current) setUploading(false); if (controller.current === pending) controller.current = null; }
  };
  const columns: ProColumns<BusinessRelease>[] = [
    { title: '业务版本', dataIndex: 'version', copyable: true, width: 110 },
    { title: '最低基础版本', width: 120, renderText: (_, row) => row.metadata?.minShellVersion ?? '校验中' },
    { title: '后台地址 / 修订', ellipsis: true, render: (_, row) => <span title={row.metadata?.backend.origin}>{row.metadata?.backend.origin ?? '校验中'}<span className="release-file-meta">修订 {row.metadata?.backend.revision ?? '—'}</span></span> },
    { title: '业务包', dataIndex: 'fileName', ellipsis: true, render: (_, row) => <span>{row.fileName}<span className="release-file-meta">{releaseFileSize(row.bytes)}</span></span> },
    { title: '状态', dataIndex: 'status', width: 95, render: (_, row) => <Tag color={row.status === 'published' ? 'success' : row.status === 'draft' ? 'processing' : 'default'}>{label[row.status]}</Tag> },
    { title: '发布时间', width: 165, renderText: (_, row) => row.publishedAt ? new Date(row.publishedAt).toLocaleString('zh-CN', { hour12: false }) : '—' },
    { title: '操作', width: 135, valueType: 'option', render: (_, row) => <Space size={8}><Button type="link" onClick={() => setInspecting(row)}>详情</Button>
      {canManage && row.status !== 'uploading' && <Button type="link" danger={row.enabled} disabled={!catalog.configured} onClick={() => { setPublishError(''); setChanging(row); }}>{row.enabled ? '下线' : '发布'}</Button>}</Space> },
  ];
  return <PageContainer title="业务更新包" subTitle="发布启动前更新的业务程序，保留用户授权、登录会话和本机数据">
    <ReleaseTargetPicker target={target} disabled={open} onPlatformChange={platform => changeTarget({ platform })} onArchitectureChange={arch => changeTarget({ arch })} onVariantChange={variant => changeTarget({ variant })} />
    {target.platform === 'win32' && <div className="release-target-picker"><Segmented<22 | 44> aria-label="业务运行环境" disabled={open} value={target.electronMajor} onChange={electronMajor => changeTarget({ electronMajor })}
      options={[{ label: 'Windows 10/11 · Electron 44', value: 44 }, { label: 'Windows 7 · Electron 22', value: 22 }]} /></div>}
    {!loadError && <BusinessDistributionNotice catalog={catalog} />}
    {loadError && <Alert className="page-notice" type="error" showIcon message={loadError} action={<Button onClick={() => void load()}>重试</Button>} />}
    <ProTable<BusinessRelease> loading={loading} key={JSON.stringify(target)} rowKey="id" headerTitle="业务版本记录" dataSource={businessReleasesForTarget(catalog.rows, target)} columns={columns} search={false} options={{ reload: () => void load() }} pagination={data.paginated ? { current: page, total: catalog.total, pageSize: 10, showSizeChanger: false, onChange: setPage } : { pageSize: 10 }} scroll={{ x: 1050 }}
      toolBarRender={() => canManage ? [<Button key="upload" type="primary" icon={<PlusOutlined />} onClick={begin}>上传业务包</Button>] : []} />
    <Modal title={`上传业务包 · ${businessTargetLabel(frozenTarget)}`} width={700} open={open} onCancel={close} maskClosable={!uploading} keyboard={!uploading} destroyOnClose
      footer={uploaded ? [<Button key="close" onClick={close}>暂不发布</Button>, <Button key="publish" type="primary" disabled={!catalog.configured} onClick={() => { setOpen(false); setChanging(uploaded); setPublishError(''); }}>核对并发布</Button>]
        : [<Button key="cancel" onClick={close}>{uploading ? '取消上传' : '取消'}</Button>, <Button key="upload" type="primary" loading={uploading} onClick={() => void upload()}>上传并校验</Button>]}>
      {uploaded ? <><Alert type="success" showIcon message="业务包已校验 · 待发布" description="草稿保存在私有存储，发布后才会更新版本清单。请核对业务版本、最低基础版本和后台地址修订。" /><BusinessReleaseDetails release={uploaded} storageMode={catalog.storageMode} /></>
        : <><Alert type="info" showIcon message="上传为私有草稿，核对后再发布" description="最低基础版本和后台地址从业务包内部读取。更换后台地址必须提高地址修订号，修订号不能降低。" />
          <Form form={form} layout="vertical" disabled={uploading} preserve={false} className="release-upload-form">
            <Form.Item name="version" label="业务版本" rules={[{ required: true, message: '请输入业务版本' }, { pattern: RELEASE_VERSION_PATTERN, message: '请输入正确版本，例如 1.1.0' }]}><Input placeholder="例如 1.1.0" /></Form.Item>
            <Form.Item label="业务 ASAR 包" required><div className="release-file-picker"><input ref={picker} type="file" accept=".asar" hidden disabled={uploading} aria-label="选择业务 ASAR 包" onChange={event => { setFile(event.target.files?.[0] ?? null); setUploadError(''); }} />
              <Button icon={<CloudUploadOutlined />} disabled={uploading} onClick={() => picker.current?.click()}>选择业务包</Button><div className="release-selected-file"><strong>{file?.name ?? '未选择文件'}</strong><span>{file ? releaseFileSize(file.size) : '文件名 business-版本号.asar，最大 256 MB'}</span></div></div></Form.Item>
            <Form.Item name="notes" label="更新说明" rules={[{ max: 1000 }]}><Input.TextArea maxLength={1000} showCount autoSize={{ minRows: 3, maxRows: 6 }} /></Form.Item>
          </Form>{uploading && <div role="status" aria-live="polite"><Progress percent={percent} status="active" /><p>{percent >= 99 ? '正在等待服务器完成校验…' : '正在上传业务包…'}</p></div>}</>}
      {uploadError && <Alert className="release-upload-error" type="error" showIcon message={uploadError} />}
    </Modal>
    <ModalForm<{ confirmPassword: string }> title={`${changing?.enabled ? '下线' : '发布'}业务版本 ${changing?.version ?? ''}`} width={700} open={Boolean(changing)} onOpenChange={value => { if (!value) setChanging(null); }} modalProps={{ destroyOnClose: true, maskClosable: false }}
      submitter={{ searchConfig: { submitText: changing?.enabled ? '确认下线' : '确认发布' } }} onFinish={async values => {
        if (!changing) return false;
        try { await businessApi.publish(changing.id, !changing.enabled, values.confirmPassword); message.success(changing.enabled ? '历史业务版本已下线' : catalog.storageMode === 'local' ? '业务版本已发布到内网更新入口' : '业务版本已发布到固定 OSS 更新入口'); await load(); return true; }
        catch (error) { setPublishError(errorText(error)); return false; }
      }}>
      <Alert className="page-notice" type="warning" showIcon message={changing?.enabled ? '当前通道头版本不能直接下线' : '发布后，新客户端下次启动必须更新此业务版本'} description={changing?.enabled ? '请先发布更高版本的修复或回退业务包，再下线历史版本；已下载缓存不会被删除。' : '请先完成目标运行环境测试。最低基础版本不满足时，客户端会提示更新基础包。'} />
      {changing && <BusinessReleaseDetails release={changing} storageMode={catalog.storageMode} />}{publishError && <Alert className="release-upload-error" type="error" showIcon message={publishError} />}
      <ProFormText.Password name="confirmPassword" label="请输入当前账号密码确认" fieldProps={{ autoComplete: 'current-password' }} rules={[{ required: true }]} />
    </ModalForm>
    <Modal title="业务版本详情" width={700} open={Boolean(inspecting)} onCancel={() => setInspecting(null)} footer={<Button onClick={() => setInspecting(null)}>关闭</Button>} destroyOnClose>{inspecting && <BusinessReleaseDetails release={inspecting} storageMode={catalog.storageMode} />}</Modal>
  </PageContainer>;
}
