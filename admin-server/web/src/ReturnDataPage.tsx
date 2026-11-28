import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, DatePicker, Descriptions, Drawer, Empty, Form, Input, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { DownloadOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import type { Dayjs } from 'dayjs';
import type { BootstrapData } from './types';
import { CustomerSelect } from './management-pagination';
import { downloadReturnBatch, latestReturnRequest, returnApi, returnBatchLabel, type ReturnBatch, type ReturnDetail, type ReturnFilters, type ReturnList, type ReturnPagination, type ReturnRecord } from './returns';

const dateTime = (value?: number) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const errorText = (error: unknown) => error instanceof Error ? error.message : '数据读取失败，请稍后重试';
type FilterValues = Omit<ReturnFilters, 'from' | 'to'> & { dates?: [Dayjs, Dayjs] };
const firstPage: ReturnPagination = { page: 1, pageSize: 20 };

export function ReturnRecordData({ record }: { record: ReturnRecord }) {
  return <div className="return-record-data">
    <Descriptions size="small" column={1} items={[
      { key: 'key', label: '记录标识', children: record.recordKey },
      { key: 'first', label: '首次采集', children: dateTime(record.firstSeenAt) },
      { key: 'updated', label: '最近更新', children: dateTime(record.updatedAt) },
    ]} />
    <pre tabIndex={0} aria-label="原始业务记录">{JSON.stringify(record.data, null, 2)}</pre>
  </div>;
}

export function ReturnBatchSummary({ batch }: { batch: ReturnBatch }) {
  return <Descriptions className="return-batch-summary" bordered size="small" column={1} items={[
    { key: 'customer', label: '所属客户', children: batch.customerName },
    { key: 'device', label: '设备标识', children: <Typography.Text copyable className="return-identifier">{batch.deviceId}</Typography.Text> },
    { key: 'business', label: '业务系统', children: batch.systemName || batch.systemId },
    { key: 'matter', label: '业务事项', children: batch.matterName || batch.matterId },
    { key: 'batch', label: '本机批次', children: <span className="return-identifier">{batch.clientBatchId}</span> },
    { key: 'started', label: '采集开始', children: dateTime(batch.startedAt) },
    { key: 'finished', label: '采集结束', children: dateTime(batch.finishedAt) },
    { key: 'uploaded', label: '上传完成', children: dateTime(batch.completedAt) },
    { key: 'count', label: '接收记录', children: `${batch.receivedRows} / ${batch.rowCount} 条` },
    { key: 'state', label: '上传状态', children: <Tag color={batch.state === 'completed' ? 'success' : 'processing'}>{returnBatchLabel(batch.state)}</Tag> },
  ]} />;
}

export function ReturnDataPage({ data }: { data: BootstrapData }) {
  const [form] = Form.useForm<FilterValues>();
  const systemId = Form.useWatch('systemId', form);
  const [filters, setFilters] = useState<ReturnFilters>({});
  const [pagination, setPagination] = useState<ReturnPagination>(firstPage);
  const [list, setList] = useState<ReturnList>();
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const listRequests = useRef(latestReturnRequest());
  const [selected, setSelected] = useState<string>();
  const [details, setDetails] = useState<ReturnDetail>();
  const [detailPage, setDetailPage] = useState<ReturnPagination>(firstPage);
  const [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState(''), [detailReload, setDetailReload] = useState(0);
  const detailRequests = useRef(latestReturnRequest());
  const [downloading, setDownloading] = useState(false), [downloadError, setDownloadError] = useState('');
  const downloadController = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; downloadController.current?.abort(); };
  }, []);
  useEffect(() => {
    const requests = listRequests.current;
    setLoading(true); setError(''); setList(undefined);
    void requests.run(signal => returnApi.list(filters, pagination, signal), value => { setList(value); setLoading(false); }, failure => { setError(errorText(failure)); setLoading(false); });
    return () => requests.cancel();
  }, [filters, pagination, reload]);
  useEffect(() => {
    const requests = detailRequests.current;
    setDetails(undefined); setDetailError(''); setDownloadError('');
    if (!selected) { setDetailLoading(false); return; }
    setDetailLoading(true);
    void requests.run(signal => returnApi.detail(selected, detailPage, signal), value => {
      if (value.batch.id !== selected) { setDetailError('返回的批次不匹配，请重新打开详情'); setDetailLoading(false); return; }
      setDetails(value); setDetailLoading(false);
    }, failure => { setDetailError(errorText(failure)); setDetailLoading(false); });
    return () => requests.cancel();
  }, [selected, detailPage, detailReload]);

  const open = (batch: ReturnBatch) => {
    detailRequests.current.cancel(); downloadController.current?.abort();
    setDetails(undefined); setDetailError(''); setDownloadError(''); setDownloading(false); setDetailLoading(true);
    setDetailPage({ ...firstPage }); setSelected(batch.id);
  };
  const close = () => {
    detailRequests.current.cancel(); downloadController.current?.abort();
    setSelected(undefined); setDetails(undefined); setDetailError(''); setDownloadError(''); setDownloading(false);
  };
  const exportData = async () => {
    if (!selected || details?.batch.id !== selected || details.batch.state !== 'completed' || downloading) return;
    const id = selected, controller = new AbortController(); downloadController.current = controller;
    setDownloading(true); setDownloadError('');
    try {
      const blob = await downloadReturnBatch(id, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = `回流数据-${id}.json`; anchor.hidden = true;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (failure) { if (mounted.current && !controller.signal.aborted) setDownloadError(errorText(failure)); }
    finally { if (mounted.current && downloadController.current === controller) { setDownloading(false); downloadController.current = null; } }
  };
  const submit = (values: FilterValues) => {
    const { dates, ...rest } = values;
    listRequests.current.cancel(); setList(undefined); setLoading(true); setPagination({ ...firstPage });
    setFilters({ ...rest, from: dates?.[0]?.startOf('day').valueOf(), to: dates?.[1]?.endOf('day').valueOf() });
  };
  const changeDetailPage = (page: number, pageSize: number) => {
    detailRequests.current.cancel(); setDetails(undefined); setDetailLoading(true); setDetailPage({ page, pageSize });
  };
  const currentDetails = details?.batch.id === selected ? details : undefined;

  return <PageContainer title="回流数据" subTitle="按客户与设备查看已上传的业务批次和原始记录">
    <Card className="return-filters" bordered={false}>
      <Form form={form} layout="vertical" onFinish={submit}>
        <div className="return-filter-grid">
          <Form.Item name="customerId" label="所属客户"><CustomerSelect data={data} placeholder="全部客户，输入名称搜索" /></Form.Item>
          <Form.Item name="deviceId" label="设备标识"><Input allowClear maxLength={128} placeholder="输入设备标识" /></Form.Item>
          <Form.Item name="systemId" label="业务系统"><Select allowClear showSearch optionFilterProp="label" placeholder="全部系统" onChange={() => form.setFieldValue('matterId', undefined)} options={data.systems.map(row => ({ value: row.id, label: row.name }))} /></Form.Item>
          <Form.Item name="matterId" label="业务事项"><Select allowClear showSearch optionFilterProp="label" placeholder={systemId ? '全部事项' : '先选择业务系统'} disabled={!systemId} options={data.matters.filter(row => row.system_id === systemId).map(row => ({ value: row.id, label: row.name }))} /></Form.Item>
          <Form.Item name="dates" label="上传日期"><DatePicker.RangePicker allowClear format="YYYY-MM-DD" /></Form.Item>
          <Form.Item name="state" label="上传状态"><Select allowClear placeholder="全部状态" options={[{ value: 'uploading', label: '接收中' }, { value: 'completed', label: '已上传' }]} /></Form.Item>
          <Form.Item name="keyword" label="批次 / 业务记录关键词"><Input allowClear maxLength={200} placeholder="输入关键词" /></Form.Item>
        </div>
        <Space wrap className="return-filter-actions"><Button type="primary" htmlType="submit" icon={<SearchOutlined />}>查询</Button><Button onClick={() => { form.resetFields(); submit({}); }}>重置</Button></Space>
      </Form>
    </Card>
    {error && <Alert className="page-notice" type="error" showIcon message="回流数据读取失败" description={error} action={<Button onClick={() => setReload(value => value + 1)}>重试</Button>} />}
    <Card className="return-batch-list" bordered={false} title={<span>回流批次{list ? <span className="return-count">共 {list.total} 个批次</span> : null}</span>}
      extra={<Button icon={<ReloadOutlined />} onClick={() => setReload(value => value + 1)} loading={loading}>刷新</Button>}>
      <Table<ReturnBatch> rowKey="id" dataSource={list?.rows ?? []} loading={loading} scroll={{ x: 1150 }}
        locale={{ emptyText: error ? '读取失败，请重试' : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无符合条件的回流批次" /> }}
        columns={[
          { title: '所属客户 / 设备', key: 'customer', width: 215, render: (_, row) => <div><strong>{row.customerName}</strong><span className="return-table-secondary return-identifier" title={row.deviceId}>{row.deviceId.slice(0, 12)}…{row.deviceId.slice(-8)}</span></div> },
          { title: '业务系统 / 事项', key: 'business', width: 260, render: (_, row) => <div>{row.systemName || row.systemId}<span className="return-table-secondary">{row.matterName || row.matterId}</span></div> },
          { title: '本机批次', dataIndex: 'clientBatchId', width: 180, ellipsis: true },
          { title: '已接收 / 总记录', key: 'count', width: 150, render: (_, row) => `${row.receivedRows} / ${row.rowCount}` },
          { title: '上传状态', key: 'state', width: 100, render: (_, row) => <Tag color={row.state === 'completed' ? 'success' : 'processing'}>{returnBatchLabel(row.state)}</Tag> },
          { title: '上传时间', key: 'created', width: 170, render: (_, row) => dateTime(row.completedAt || row.createdAt) },
          { title: '操作', key: 'action', width: 95, fixed: 'right', render: (_, row) => <Button type="link" onClick={() => open(row)}>查看明细</Button> },
        ]}
        pagination={{ current: pagination.page, pageSize: pagination.pageSize, total: list?.total ?? 0, showSizeChanger: true, pageSizeOptions: [20, 50, 100],
          showTotal: total => `共 ${total} 个批次`, onChange: (page, pageSize) => { listRequests.current.cancel(); setList(undefined); setLoading(true); setPagination({ page, pageSize }); } }} />
    </Card>
    <Drawer className="return-detail-drawer" title="回流批次详情" width={820} open={Boolean(selected)} onClose={close} destroyOnClose
      extra={<Button icon={<DownloadOutlined />} loading={downloading} disabled={!currentDetails || currentDetails.batch.state !== 'completed' || detailLoading} onClick={() => void exportData()}>下载原始数据</Button>}>
      {downloadError && <Alert className="page-notice" type="error" showIcon message={downloadError} />}
      <Spin spinning={detailLoading}><div className="return-detail-content" aria-busy={detailLoading}>
        {detailError ? <Alert type="error" showIcon message="批次明细读取失败" description={detailError} action={<Button onClick={() => setDetailReload(value => value + 1)}>重试</Button>} /> : currentDetails ? <>
          <ReturnBatchSummary batch={currentDetails.batch} />
          {currentDetails.batch.state !== 'completed' && <Alert className="page-notice" type="info" showIcon message="此批次仍在接收中" description="下列为服务器已接收的记录，客户端完成上传后可下载完整数据。" action={<Button onClick={() => setDetailReload(value => value + 1)}>刷新</Button>} />}
          <Typography.Title level={5} className="return-records-heading">业务记录 · 共 {currentDetails.total} 条</Typography.Title>
          <Table<ReturnRecord> rowKey="rowNo" size="small" dataSource={currentDetails.rows} scroll={{ x: 500 }}
            locale={{ emptyText: currentDetails.batch.state === 'completed' ? '此批次没有业务记录' : '尚未收到业务记录' }}
            columns={[{ title: '序号', dataIndex: 'rowNo', width: 72 }, { title: '记录标识', dataIndex: 'recordKey', ellipsis: true }, { title: '最近更新', key: 'updated', width: 175, render: (_, row) => dateTime(row.updatedAt) }]}
            expandable={{ expandedRowRender: row => <ReturnRecordData record={row} />, rowExpandable: () => true, expandRowByClick: true, columnTitle: '展开', columnWidth: 55 }}
            pagination={{ current: detailPage.page, pageSize: detailPage.pageSize, total: currentDetails.total, showSizeChanger: true, pageSizeOptions: [20, 50, 100], onChange: changeDetailPage }} />
        </> : <div className="return-detail-placeholder" aria-live="polite">正在读取批次明细…</div>}
      </div></Spin>
    </Drawer>
  </PageContainer>;
}
