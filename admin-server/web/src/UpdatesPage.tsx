import { useEffect, useRef, useState } from 'react';
import { App, Alert, Button, Descriptions, Form, Input, Modal, Progress, Segmented, Space, Tag, Typography } from 'antd';
import { CloudUploadOutlined, PlusOutlined } from '@ant-design/icons';
import { ModalForm, PageContainer, ProFormText, ProTable, type ProColumns } from '@ant-design/pro-components';
import { adminApi, ApiError } from './api';
import { adminTableSearch } from './presentation';
import { RELEASE_STATUS_LABELS, RELEASE_VERSION_PATTERN, WINDOWS_RELEASE_TARGET, releaseFileError, releaseFileSize, releaseStatus,
  releaseTargetLabel, releasesForTarget, type ReleaseArch, type ReleasePlatform, type ReleaseTarget, type UploadedRelease, type UploadReleaseValues } from './releases';
import type { BootstrapData, UpdateRecord } from './types';

const contains = (value: unknown, query: unknown) => !query || String(value ?? '').toLowerCase().includes(String(query).trim().toLowerCase());
const dateTime = (value?: number) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试';

export function ReleaseTargetPicker({ target, disabled, onPlatformChange, onArchitectureChange }: {
  target: ReleaseTarget; disabled?: boolean; onPlatformChange: (platform: ReleasePlatform) => void; onArchitectureChange: (arch: ReleaseArch) => void;
}) {
  return <div className="release-target-picker">
    <Segmented<ReleasePlatform> aria-label="发布平台" value={target.platform} disabled={disabled} onChange={onPlatformChange}
      options={[{ label: 'Windows', value: 'win32' }, { label: '信创', value: 'linux' }]} />
    {target.platform === 'linux' && <Segmented<ReleaseArch> aria-label="麒麟芯片架构" value={target.arch} disabled={disabled} onChange={onArchitectureChange}
      options={[{ label: <span>x86_64<span className="release-chip-vendors"> · Intel / AMD</span></span>, value: 'x64' },
        { label: <span>ARM64<span className="release-chip-vendors"> · 飞腾 / 鲲鹏</span></span>, value: 'arm64' }]} />}
  </div>;
}

export function ReleaseDetails({ release }: { release: Pick<UpdateRecord, 'version' | 'fileName' | 'bytes' | 'sha256' | 'url' | 'notes' | 'platform' | 'arch' | 'installer'> }) {
  return <Descriptions column={1} size="small" className="release-details">
    <Descriptions.Item label="版本号">{release.version}</Descriptions.Item>
    <Descriptions.Item label="适用环境">{releaseTargetLabel(release)} · {release.installer === 'deb' || release.platform === 'linux' ? 'DEB' : 'EXE'}</Descriptions.Item>
    <Descriptions.Item label="安装包">{release.fileName || '外链安装包'} · {releaseFileSize(release.bytes)}</Descriptions.Item>
    <Descriptions.Item label="服务器 SHA256"><Typography.Text copyable className="release-hash">{release.sha256}</Typography.Text></Descriptions.Item>
    <Descriptions.Item label="下载地址"><Typography.Text copyable className="release-url">{release.url}</Typography.Text></Descriptions.Item>
    {release.notes && <Descriptions.Item label="更新说明"><span className="release-notes">{release.notes}</span></Descriptions.Item>}
  </Descriptions>;
}

export function UpdatesPage({ data, reload }: { data: BootstrapData; reload: () => Promise<void> }) {
  const canManage = data.user?.role === 'admin';
  const { message } = App.useApp();
  const [open, setOpen] = useState(false), [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File | null>(null), [percent, setPercent] = useState(0);
  const [uploadError, setUploadError] = useState(''), [publishError, setPublishError] = useState('');
  const [uploaded, setUploaded] = useState<UploadedRelease | null>(null);
  const [changing, setChanging] = useState<UpdateRecord | null>(null);
  const [inspecting, setInspecting] = useState<UpdateRecord | null>(null);
  const [filters, setFilters] = useState<Record<string, unknown>>({});
  const [platform, setPlatform] = useState<ReleasePlatform>('win32');
  const [linuxArch, setLinuxArch] = useState<ReleaseArch>('x64');
  const target: ReleaseTarget = { platform, arch: platform === 'linux' ? linuxArch : 'x64' };
  const [uploadTarget, setUploadTarget] = useState<ReleaseTarget>({ ...WINDOWS_RELEASE_TARGET });
  const [form] = Form.useForm<UploadReleaseValues>();
  const inputRef = useRef<HTMLInputElement>(null), uploadController = useRef<AbortController | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; uploadController.current?.abort(); }; }, []);
  const filteredRows = releasesForTarget(data.updates, target).filter(row => contains(row.version, filters.version)
    && contains(row.notes, filters.notes) && (!filters.status || releaseStatus(row) === filters.status));
  const begin = () => { setUploadTarget({ ...target }); form.resetFields(); setFile(null); setUploaded(null); setUploadError(''); setPercent(0); setOpen(true); };
  const cancelUpload = () => { uploadController.current?.abort(); };
  const closeUpload = () => { if (uploading) { cancelUpload(); return; } setOpen(false); };
  const upload = async () => {
    if (uploadController.current) return;
    let values: UploadReleaseValues;
    try { values = { ...await form.validateFields(), ...uploadTarget }; } catch { return; }
    const validation = releaseFileError(file, values.version, uploadTarget);
    if (validation) { setUploadError(validation); return; }
    if (uploadController.current) return;
    const controller = new AbortController(); uploadController.current = controller;
    setUploadError(''); setPercent(0); setUploading(true);
    try {
      const result = await adminApi.uploadRelease(file!, values, { signal: controller.signal, onProgress: value => { if (alive.current) setPercent(value); } });
      if (!alive.current) return;
      setUploaded(result);
      await reload().catch(() => {});
    } catch (error) {
      if (!alive.current) return;
      setUploadError(errorText(error));
      if (error instanceof ApiError && error.code === 'UPLOAD_CANCELLED') await reload().catch(() => {});
    } finally { if (alive.current) setUploading(false); if (uploadController.current === controller) uploadController.current = null; }
  };
  const requestPublish = (row: UpdateRecord) => { setPublishError(''); setChanging(row); };
  const publishUploaded = () => {
    if (!uploaded) return;
    setOpen(false); requestPublish({ ...uploaded, target_type: 'app', published_at: 0, enabled: 0, managed: true });
  };
  const columns: ProColumns<UpdateRecord>[] = [
    { title: '版本', dataIndex: 'version', copyable: true, width: 105 },
    { title: '适用环境', key: 'target', width: 195, search: false, render: (_, row) => releaseTargetLabel(row) },
    { title: '安装包', dataIndex: 'fileName', search: false, ellipsis: true, render: (_, row) => <div><span>{row.fileName || '历史外链版本'}</span><span className="release-file-meta">{releaseFileSize(row.bytes)}{row.managed ? ' · 服务器托管' : ' · 外链'}</span></div> },
    { title: '更新说明', dataIndex: 'notes', ellipsis: true, renderText: value => value || '—' },
    { title: '发布时间', dataIndex: 'published_at', width: 165, search: false, render: (_, row) => dateTime(row.published_at) },
    { title: '状态', dataIndex: 'status', width: 95, valueEnum: Object.fromEntries(Object.entries(RELEASE_STATUS_LABELS).map(([key, text]) => [key, { text }])),
      render: (_, row) => <Tag color={releaseStatus(row) === 'published' ? 'success' : releaseStatus(row) === 'draft' ? 'processing' : 'default'}>{RELEASE_STATUS_LABELS[releaseStatus(row)]}</Tag> },
    { title: '操作', valueType: 'option', width: canManage ? 130 : 70, render: (_, row) => <Space size={8}>
      <Button type="link" onClick={() => setInspecting(row)}>详情</Button>
      {canManage && releaseStatus(row) !== 'uploading' && <Button danger={Boolean(row.enabled)} type="link" onClick={() => requestPublish(row)}>{row.enabled ? '下线' : '发布'}</Button>}
    </Space> },
  ];
  return <PageContainer title="版本更新" subTitle="上传安装包、核对服务器摘要，再发布到桌面更新通道">
    <ReleaseTargetPicker target={target} disabled={open} onPlatformChange={value => { setPlatform(value); setFilters({}); }} onArchitectureChange={value => { setLinuxArch(value); setFilters({}); }} />
    <Alert className="page-notice release-guidance" type="info" showIcon message={`发布到 ${releaseTargetLabel(target)}`}
      description={platform === 'win32'
        ? '新版会自动检查并下载，经校验后在空闲时提示确认安装，不中断回流任务。旧客户端需在“设置 → 检查更新”中确认安装。离线授权仍通过安装包升级。'
        : '麒麟新版会检查并下载对应架构的 DEB，校验后交给系统安装器确认安装。1.0.20 及更早的麒麟客户端需先手动安装一次新版。x86_64 与 ARM64 分别发布，互不覆盖。'} />
    {platform === 'linux' && linuxArch === 'arm64' && <Alert className="release-architecture-notice" type="warning" showIcon
      message="ARM64 发布前请完成目标电脑实测" description="可先上传为草稿，完成飞腾或鲲鹏麒麟电脑上的安装、回流及覆盖升级验收后，再发布到此架构。" />}
    <ProTable<UpdateRecord> key={`${platform}-${target.arch}`} rowKey="id" headerTitle={`${releaseTargetLabel(target)} · 版本记录`} dataSource={filteredRows} columns={columns} search={adminTableSearch} onSubmit={values => setFilters(values)} onReset={() => setFilters({})} pagination={{ pageSize: 10 }} options={{ reload }} scroll={{ x: 1200 }} toolBarRender={() => canManage ? [<Button type="primary" icon={<PlusOutlined />} key="new" onClick={begin}>发布新版本</Button>] : []} />
    <Modal title={`上传新版本 · ${releaseTargetLabel(uploadTarget)}`} width={700} open={open} onCancel={closeUpload} destroyOnClose maskClosable={!uploading} keyboard={!uploading} className="release-upload-modal"
      footer={uploaded ? [<Button key="close" onClick={closeUpload}>暂不发布</Button>, <Button key="publish" type="primary" onClick={publishUploaded}>核对并发布</Button>]
        : [<Button key="cancel" onClick={closeUpload}>{uploading ? '取消上传' : '取消'}</Button>, <Button key="upload" type="primary" disabled={uploading} loading={uploading} onClick={() => void upload()}>上传并校验</Button>]}>
      {uploaded ? <><Alert type="success" showIcon message="上传完成 · 待发布" description="SHA256 和文件大小由服务器计算。请核对下列信息，只有再次确认发布才会推送给客户端。" /><ReleaseDetails release={uploaded} /></>
        : <><Alert type="info" showIcon message="先上传为草稿，不会立即推送给客户端" description={`适用环境：${releaseTargetLabel(uploadTarget)}。服务器将核对安装包格式、版本与架构并计算摘要。`} />
          <Form form={form} layout="vertical" disabled={uploading} className="release-upload-form" preserve={false}>
            <Form.Item name="version" label="版本号" rules={[{ required: true, message: '请输入版本号' }, { pattern: RELEASE_VERSION_PATTERN, message: '请输入正确版本号，例如 1.0.3' }, { max: 32 }]}><Input placeholder="例如 1.0.3" autoComplete="off" /></Form.Item>
            <Form.Item label={uploadTarget.platform === 'linux' ? `麒麟 ${uploadTarget.arch === 'arm64' ? 'ARM64' : 'x86_64'} 安装包` : 'Windows 64 位通用安装包'} required>
              <div className="release-file-picker"><input ref={inputRef} type="file" accept={uploadTarget.platform === 'linux' ? '.deb' : '.exe'} aria-label={uploadTarget.platform === 'linux' ? '选择麒麟安装包' : '选择 Windows 安装包'} className="release-native-file" hidden disabled={uploading} onChange={event => { setFile(event.target.files?.[0] ?? null); setUploadError(''); }} />
                <Button icon={<CloudUploadOutlined />} onClick={() => inputRef.current?.click()} disabled={uploading}>选择安装包</Button>
                <div className="release-selected-file"><strong>{file?.name || '未选择文件'}</strong><span>{file ? releaseFileSize(file.size) : uploadTarget.platform === 'linux'
                  ? `文件名：数据融合助手-麒麟版-版本号-${uploadTarget.arch}.deb，最大 500 MB`
                  : '文件名：数据融合助手-安装包-版本号-x64.exe，最大 500 MB'}</span></div>
              </div>
            </Form.Item>
            <Form.Item name="notes" label="更新说明" rules={[{ max: 1000, message: '更新说明不能超过 1000 字' }]}><Input.TextArea maxLength={1000} showCount autoSize={{ minRows: 3, maxRows: 6 }} placeholder="简要说明本次修复和新增功能，供使用人员查看" /></Form.Item>
          </Form>
          {uploading && <div className="release-upload-progress" role="status" aria-live="polite"><Progress percent={percent} status="active" /><span>{percent >= 99 ? '正在等待服务器完成校验…' : '正在上传安装包，请勿关闭页面。可随时取消上传。'}</span></div>}
        </>}
      {uploadError && <Alert className="release-upload-error" type={uploadError.includes('取消') ? 'info' : 'error'} showIcon message={uploadError} />}
    </Modal>
    <ModalForm<{ confirmPassword: string }> title={`${changing?.enabled ? '下线' : '发布'}版本 ${changing?.version ?? ''} · ${releaseTargetLabel(changing ?? {})}`} width={700} open={Boolean(changing)} onOpenChange={value => { if (!value) { setChanging(null); setPublishError(''); } }} modalProps={{ destroyOnClose: true, maskClosable: false }}
      submitter={{ searchConfig: { submitText: changing?.enabled ? '确认下线' : '确认发布' } }} onFinish={async values => {
        if (!changing) return false;
        setPublishError('');
        try { await adminApi.updateRelease(changing.id, { enabled: !changing.enabled, confirmPassword: values.confirmPassword }); message.success(changing.enabled ? '版本已下线，客户端不再获取该更新' : '版本已发布，在线客户端可检测更新'); await reload(); return true; }
        catch (error) { setPublishError(errorText(error)); return false; }
      }}>
      <Alert type={changing?.enabled ? 'warning' : 'info'} showIcon message={changing?.enabled ? '下线只停止后续分发，不回退已安装的客户端' : '发布后会进入正式更新通道，请确认已经完成测试'} />
      {changing && <ReleaseDetails release={changing} />}
      {publishError && <Alert className="release-upload-error" type="error" showIcon message={publishError} />}
      <ProFormText.Password name="confirmPassword" label="请输入当前账号密码确认操作" fieldProps={{ autoComplete: 'current-password' }} rules={[{ required: true, message: '请输入当前账号密码' }]} />
    </ModalForm>
    <Modal title={`版本 ${inspecting?.version ?? ''}`} width={700} open={Boolean(inspecting)} onCancel={() => setInspecting(null)} footer={<Button onClick={() => setInspecting(null)}>关闭</Button>} destroyOnClose>
      {inspecting && <><Tag color={releaseStatus(inspecting) === 'published' ? 'success' : 'default'}>{RELEASE_STATUS_LABELS[releaseStatus(inspecting)]}</Tag><ReleaseDetails release={inspecting} /></>}
    </Modal>
  </PageContainer>;
}
