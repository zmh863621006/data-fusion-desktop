import { useEffect, useRef, useState } from 'react';
import type { OneWindowBatch, OneWindowFilters, OneWindowPlan, OneWindowState } from '../../core/one-window/types';
import { DEFAULT_ONE_WINDOW_SCHEDULE } from '../../core/one-window/scheduler';
import { ONE_WINDOW_STATES } from '../../plugins/shenzhen-one-window/catalog';
import { AppIcon } from './AppIcon';
import { Modal } from './Modal';
import './OneWindowPage.css';

const dateTime = (value: number | null | undefined) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
const uploadLabel = (batch: OneWindowBatch) => ({ pending: '待推送', uploading: '正在推送', uploaded: '已推送至后台', failed: '推送失败' })[batch.uploadStatus];
const sections: Record<string, string> = {
  identifiers: '关联编号', base: '主体基本信息', item: '事项信息', opinions: '办理意见', form: '电子表单',
  materials: '申请材料', files: '受理文件', licenses: '证照目录', processFiles: '过程文件', printFiles: '打印文件',
  delivery: '送达信息', ems: '邮寄信息', sourceList: '原系统列表字段',
  fileDelivery: '文件送达', unionHandle: '联办流转', businessFlow: '办理流程', serviceList: '服务清单',
};
const fieldLabels: Record<string, string> = {
  bsnum: '申办流水号', receiveNumber: '受理编号', matterName: '业务事项', applicant: '申请主体',
  creditCode: '统一社会信用代码', legalPerson: '法定代表人', organizationName: '办理部门',
  receivedAt: '受理时间', submittedAt: '提交时间', finishedAt: '办结时间',
  data: '业务数据', fields: '表单字段', name: '名称', version: '版本', label: '字段名称', value: '字段值',
  complete: '已采集', partial: '部分详情需重试', absent: '原系统无数据', failed: '采集失败',
  code0: '广告形式', code1: '其他形式', code2: '广告材质', code3: '其他材质', code4: '长度', code5: '宽度', code6: '厚度', code7: '下沿距地高度',
};
const display = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);

function SectionValue({ section }: { section: unknown }) {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return <DetailValue value={section} />;
  const wrapper = section as Record<string, unknown>;
  const data = wrapper.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return <DetailValue value={data ?? section} />;
  const record = data as Record<string, unknown>;
  const fields = Array.isArray(record.fields) ? record.fields as Array<{ key?: string; label?: string; value?: unknown }> : [];
  const hasForm = record.data && typeof record.data === 'object' && !Array.isArray(record.data);
  const values = hasForm ? (record.displayData ?? record.data) as Record<string, unknown> : null;
  return <>
    {wrapper.message ? <p className="one-window-section-message">{display(wrapper.message)}</p> : null}
    {values ? <dl className="one-window-fields">{Object.entries(values).map(([key, value]) => <div key={key}><dt>{fields.find(field => field.key === key)?.label ?? key}</dt><dd><DetailValue value={value} /></dd></div>)}</dl>
      : fields.length && fields.every(field => 'value' in field) ? <dl className="one-window-fields">{fields.map((field, index) => <div key={index}><dt>{field.label ?? field.key}</dt><dd><DetailValue value={field.value} /></dd></div>)}</dl>
        : <DetailValue value={data} />}
    {(hasForm || fields.length > 0) && <details className="one-window-detail-section"><summary>完整响应字段</summary><DetailValue value={data} /></details>}
  </>;
}

function DetailValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  if (Array.isArray(value)) return value.length ? <div className="one-window-array">{value.map((item, index) => <div className="one-window-array-item" key={index}><span className="muted">第 {index + 1} 项</span><DetailValue value={item} /></div>)}</div> : <span className="muted">无记录</span>;
  if (typeof value === 'object') return <dl className="one-window-fields">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{fieldLabels[key] ?? key}</dt><dd><DetailValue value={item} /></dd></div>)}</dl>;
  return <span className="one-window-value">{display(value)}</span>;
}

export function OneWindowPage({ matterId, matterName, section, batchId, onBatchChange, sessionStatus, allowExport, allowAutoSync, defaultPageSize }: {
  matterId: string; matterName: string; section: 'return' | 'data'; batchId: string; onBatchChange(id: string): void;
  sessionStatus: string; allowExport: boolean; allowAutoSync: boolean; defaultPageSize: number;
}) {
  const [state, setState] = useState<OneWindowState | null>(null);
  const [plan, setPlan] = useState<OneWindowPlan>({ matterId, schedule: { ...DEFAULT_ONE_WINDOW_SCHEDULE },
    filters: { dateType: 'all', startDate: '', endDate: '', state: '' }, nextRunAt: null, lastRunAt: null });
  const initialized = useRef(false);
  const mounted = useRef(true);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState('');
  const [batchPage, setBatchPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Array<{ recordKey: string; data: Record<string, unknown> }>>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const batchesKey = useRef('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const latest = await window.desktopApi.oneWindow.state(matterId, batchPage);
        if (disposed) return;
        setState(latest);
        if (!initialized.current) { setPlan(latest.plan); initialized.current = true; }
        const key = latest.batches.map(batch => batch.taskId + batch.uploadStatus).join('|');
        if (batchesKey.current !== key) { batchesKey.current = key; setRevision(value => value + 1); }
      } catch (error) { if (!disposed) setError(error instanceof Error ? error.message : '回流状态加载失败'); }
      finally { if (!disposed) timer = setTimeout(refresh, 3_000); }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [matterId, batchPage]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    void window.desktopApi.oneWindow.records(matterId, { batchId: batchId || undefined, keyword: appliedKeyword, page, pageSize: defaultPageSize })
      .then(result => { if (!disposed) { setRows(result.rows); setTotal(result.total); } })
      .catch(error => { if (!disposed) { setRows([]); setError(error instanceof Error ? error.message : '回流数据加载失败'); } })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [matterId, batchId, page, appliedKeyword, defaultPageSize, revision]);

  const setFilters = (patch: Partial<OneWindowFilters>) => { setPlan(value => ({ ...value, filters: { ...value.filters, ...patch } })); setDirty(true); };
  const setSchedule = (patch: Partial<OneWindowPlan['schedule']>) => { setPlan(value => ({ ...value, schedule: { ...value.schedule, ...patch } })); setDirty(true); };
  const save = async () => {
    setSaving(true); setError(''); setMessage('');
    try {
      const saved = await window.desktopApi.oneWindow.savePlan(matterId, { schedule: plan.schedule, filters: plan.filters });
      if (mounted.current) { setPlan(saved); setDirty(false); setMessage('当前业务的回流设置已保存'); }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '设置保存失败'); }
    finally { if (mounted.current) setSaving(false); }
  };
  const run = async () => {
    if (busy || state?.running) return;
    setBusy(true); setError(''); setMessage('正在获取业务列表和详情，处理进度可在回流任务中查看');
    try {
      const task = await window.desktopApi.oneWindow.run(matterId, plan.filters);
      if (!mounted.current) return;
      if (task.status !== 'completed') throw new Error(task.error ?? '本批次回流未完成');
      const result = task.result as { total?: number; uploadStatus?: string };
      setMessage(`本批次已保存 ${result?.total ?? 0} 条业务详情，${result?.uploadStatus === 'uploaded' ? 'Excel 已推送至后台' : 'Excel 待重新推送，请查看批次推送状态'}`);
      setRevision(value => value + 1);
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '回流失败'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const retry = async (id: string) => {
    setRetrying(id); setError('');
    try { await window.desktopApi.oneWindow.retry(id); if (mounted.current) setMessage('本批次 Excel 已补推至后台'); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '重新推送失败'); }
    finally { if (mounted.current) { setRetrying(''); setRevision(value => value + 1); } }
  };
  const openFolder = async (id: string) => {
    try { await window.desktopApi.oneWindow.openFolder(id); }
    catch (error) { setError(error instanceof Error ? error.message : '无法打开文件夹'); }
  };
  const running = busy || Boolean(state?.running);
  const authenticated = (state?.sessionStatus ?? sessionStatus) === 'authenticated';
  const nextRunAt = state?.plan.nextRunAt;

  return <div className="one-window-page">
    {message && <div className="message" role="status">{message}</div>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    {section === 'return' && <>
      <section className="panel one-window-controls">
        <div className="panel-head"><div><h2>{matterName}</h2><p>获取办件列表与完整业务详情，生成 Excel 后自动推送至后台。</p></div></div>
        <div className="one-window-form">
          <label><span>日期条件</span><select value={plan.filters.dateType} onChange={event => setFilters({ dateType: event.target.value as OneWindowFilters['dateType'] })}><option value="all">全部日期</option><option value="received">接收／受理日期</option><option value="finished">办结日期</option></select></label>
          {plan.filters.dateType !== 'all' && <><label><span>开始日期</span><input type="date" value={plan.filters.startDate} onChange={event => setFilters({ startDate: event.target.value })} /></label><label><span>结束日期</span><input type="date" value={plan.filters.endDate} onChange={event => setFilters({ endDate: event.target.value })} /></label></>}
          <label><span>办理状态</span><select value={plan.filters.state} onChange={event => setFilters({ state: event.target.value })}>{ONE_WINDOW_STATES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        </div>
        <div className="one-window-actions"><button className="primary" disabled={running || !authenticated || !allowExport} onClick={() => void run()}><AppIcon name="refresh" size={17} />{running ? '正在回流…' : '立即回流并推送'}</button><span className="muted">{authenticated ? '会话已验证' : '请先在原系统标签页完成登录'}</span></div>
      </section>
      <section className="panel one-window-controls" aria-label="当前业务定时回流设置">
        <div className="panel-head"><div><h3>定时回流</h3><p>应用运行期间按北京时间执行，使用本页保存的日期和状态条件。</p></div><button className="secondary" disabled={!dirty || saving || !initialized.current} onClick={() => void save()}>{saving ? '正在保存…' : '保存设置'}</button></div>
        <div className="one-window-toggles"><label><input type="checkbox" checked={plan.schedule.loginAutoRun} disabled={!allowAutoSync || !allowExport} onChange={event => setSchedule({ loginAutoRun: event.target.checked })} /><span>识别登录后立即回流一次</span></label><label><input type="checkbox" checked={plan.schedule.enabled} disabled={!allowAutoSync || !allowExport} onChange={event => setSchedule({ enabled: event.target.checked })} /><span>开启定时回流</span></label></div>
        <div className="one-window-form">
          <label><span>执行方式</span><select value={plan.schedule.mode} onChange={event => setSchedule({ mode: event.target.value as OneWindowPlan['schedule']['mode'] })}><option value="interval">按间隔执行</option><option value="daily">每天执行</option><option value="weekly">每周执行</option></select></label>
          {plan.schedule.mode === 'interval' ? <label><span>间隔分钟</span><input type="number" min={1} max={10080} value={plan.schedule.intervalMinutes} onChange={event => setSchedule({ intervalMinutes: Number(event.target.value) })} /></label> : <label><span>执行时间</span><input type="time" value={plan.schedule.time} onChange={event => setSchedule({ time: event.target.value })} /></label>}
        </div>
        {plan.schedule.mode === 'weekly' && <fieldset className="one-window-weekdays"><legend>执行日期</legend>{['一', '二', '三', '四', '五', '六', '日'].map((label, index) => { const day = index + 1; return <label key={day}><input type="checkbox" checked={plan.schedule.weekdays.includes(day)} onChange={event => setSchedule({ weekdays: event.target.checked ? [...plan.schedule.weekdays, day] : plan.schedule.weekdays.filter(value => value !== day) })} />周{label}</label>; })}</fieldset>}
        <div className="one-window-schedule-status" role="status">{state?.plan.schedule.enabled ? `下次计划 ${dateTime(nextRunAt)}${authenticated ? '' : '，等待登录后执行'}` : '定时回流已关闭'}{dirty && <span> · 有未保存的设置</span>}</div>
        {!allowAutoSync && <p className="muted">当前授权未开启自动同步功能。</p>}
      </section>
    </>}

    <section className="panel one-window-batches">
      <div className="panel-head"><div><h3>回流批次与后台推送</h3><p>本批次 Excel 同时保存在应用导出目录。</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>批次</th><th>回流时间</th><th>办件数</th><th>详情情况</th><th>后台推送</th><th>操作</th></tr></thead><tbody>{state?.batches.map(batch => <tr key={batch.taskId}><td>{batch.taskId.slice(0, 8).toUpperCase()}</td><td>{dateTime(batch.createdAt)}</td><td>{batch.total}</td><td>{batch.partialCount ? `${batch.partialCount} 条需补充详情` : '详情已采集'}</td><td><span className={`status-chip ${batch.uploadStatus === 'uploaded' ? 'ready' : batch.uploadStatus === 'failed' ? 'warning' : ''}`}>{uploadLabel(batch)}</span>{batch.uploadError && <div className="one-window-upload-error">{batch.uploadError}</div>}</td><td><div className="button-row"><button className="link-button" onClick={() => { onBatchChange(batch.taskId); setPage(1); }}>查看数据</button>{batch.filePath && <button className="link-button" onClick={() => void openFolder(batch.taskId)}>打开文件夹</button>}{allowExport && batch.uploadStatus === 'failed' && <button className="link-button" disabled={Boolean(retrying)} onClick={() => void retry(batch.taskId)}>{retrying === batch.taskId ? '重推中…' : '重新推送'}</button>}</div></td></tr>)}{!state?.batches.length && <tr><td colSpan={6} className="empty">{state ? '完成回流后，批次和推送结果会显示在这里' : '正在加载批次…'}</td></tr>}</tbody></table></div>
      {Boolean(state && state.batchTotal > 20) && <div className="one-window-pagination"><span>共 {state?.batchTotal} 个批次</span><button className="secondary" disabled={batchPage <= 1} onClick={() => setBatchPage(value => value - 1)}>上一页</button><button className="secondary" disabled={batchPage * 20 >= (state?.batchTotal ?? 0)} onClick={() => setBatchPage(value => value + 1)}>下一页</button></div>}
    </section>

    <section className="panel one-window-data">
      <div className="panel-head"><div><h3>{batchId ? '批次业务详情' : '业务台账'}</h3><p>{batchId ? `批次 ${batchId.slice(0, 8).toUpperCase()} · ${total} 条` : `共 ${total} 条业务记录`}</p></div>{batchId && <button className="secondary" onClick={() => { onBatchChange(''); setPage(1); }}>查看合并台账</button>}</div>
      <form className="one-window-search" onSubmit={event => { event.preventDefault(); setAppliedKeyword(keyword.trim()); setPage(1); }}><label><span className="sr-only">搜索办件</span><input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索办件流水号、申请主体或业务字段" /></label><button className="secondary" type="submit"><AppIcon name="search" size={16} />查询</button></form>
      <div className="table-wrap" aria-busy={loading}><table><thead><tr><th>受理编号</th><th>申请主体</th><th>信用代码</th><th>法定代表人</th><th>办理状态</th><th>受理时间</th><th>详情</th></tr></thead><tbody>{rows.map(row => <tr key={row.recordKey}><td title={display(row.data.bsnum)}>{display(row.data.receiveNumber ?? row.data.bsnum)}</td><td>{display(row.data.applicant)}</td><td>{display(row.data.creditCode)}</td><td>{display(row.data.legalPerson)}</td><td>{display(row.data.statusLabel)}</td><td>{display(row.data.receivedAt)}</td><td><button className="link-button" onClick={() => setSelected(row.data)}>查看详情</button>{row.data.detailStatus === 'partial' && <span className="one-window-partial">部分详情需补充</span>}</td></tr>)}{!rows.length && <tr><td colSpan={7} className="empty">{loading ? '正在加载数据…' : '当前条件没有回流数据'}</td></tr>}</tbody></table></div>
      {total > defaultPageSize && <div className="one-window-pagination"><span>第 {page} 页 · 共 {total} 条</span><button className="secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><button className="secondary" disabled={page * defaultPageSize >= total} onClick={() => setPage(value => value + 1)}>下一页</button></div>}
    </section>

    {selected && <Modal className="one-window-detail" backdropClassName="one-window-backdrop" labelledBy="one-window-detail-title" onClose={() => setSelected(null)}><div className="panel-head"><div><h2 id="one-window-detail-title">{display(selected.applicant)}</h2><p>{display(selected.bsnum)}</p></div><button className="secondary" onClick={() => setSelected(null)}>关闭</button></div>
      <dl className="one-window-fields">{['receiveNumber', 'matterName', 'creditCode', 'legalPerson', 'organizationName', 'receivedAt', 'finishedAt'].map(key => <div key={key}><dt>{fieldLabels[key] ?? key}</dt><dd>{display(selected[key])}</dd></div>)}</dl>
      {selected.detailStatus === 'partial' && <div className="message">部分详情尚未获取，原始列表和成功获取的内容已保留。再次回流会继续补充。</div>}
      {Object.entries((selected.details ?? {}) as Record<string, unknown>).map(([key, value]) => <details className="one-window-detail-section" key={key} open={['base', 'form'].includes(key)}><summary>{sections[key] ?? key}</summary><SectionValue section={value} /></details>)}
      <details className="one-window-detail-section"><summary>原系统列表字段</summary><DetailValue value={selected.sourceList} /></details>
    </Modal>}
  </div>;
}
