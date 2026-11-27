import { useEffect, useRef, useState } from 'react';
import type { HousingBindingApi, HousingBindingDetail, HousingBindingJob, HousingBindingRow, HousingBindingState, HousingImportPreview } from '../../core/housing-binding/types';
import { AppIcon } from './AppIcon';
import './HousingBindingPage.css';

const JOB_PAGE_SIZE = 20;
const ROW_PAGE_SIZE = 50;
export const housingJobIsActive = (job: Pick<HousingBindingJob, 'phase'>): boolean => ['queued', 'running', 'waiting-login'].includes(job.phase);
export const housingJobCanRetry = (job: HousingBindingJob): boolean => !housingJobIsActive(job)
  && (job.failed > 0 || job.pending > 0 || ['interrupted', 'failed', 'cancelled'].includes(job.phase));
export const housingJobLabel = (phase: HousingBindingJob['phase']): string => ({ queued: '等待执行', running: '正在绑定', 'waiting-login': '等待重新登录', completed: '已完成', failed: '任务失败', cancelled: '已取消', interrupted: '上次执行中断' })[phase];
export const housingRowLabel = (status: HousingBindingRow['status']): string => ({ pending: '待处理', binding: '正在绑定', succeeded: '绑定成功', 'already-bound': '已绑定，跳过', failed: '绑定失败', unknown: '结果待核对' })[status];
export function housingImportCanSubmit(preview: HousingImportPreview | null): boolean {
  return Boolean(preview?.importId && preview.validCount > 0 && preview.issues.length === 0);
}
const timestamp = (value: number) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const failureMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function HousingBindingCounts({ job }: { job: HousingBindingJob }) {
  return <dl className="housing-counts" aria-label="绑定任务统计">
    <div><dt>房屋总数</dt><dd>{job.total}</dd></div>
    <div className="housing-count-success"><dt>绑定成功</dt><dd>{job.succeeded}</dd></div>
    <div><dt>已绑定跳过</dt><dd>{job.skipped}</dd></div>
    <div className={job.failed ? 'housing-count-failed' : ''}><dt>失败／待核对</dt><dd>{job.failed}</dd></div>
    <div><dt>待处理</dt><dd>{job.pending}</dd></div>
  </dl>;
}

export function HousingImportSummary({ preview }: { preview: HousingImportPreview }) {
  return <div className={`housing-import-summary${preview.issues.length ? ' has-errors' : ''}`} role="status">
    <div className="housing-file-heading"><AppIcon name="document" size={19} /><strong title={preview.fileName}>{preview.fileName}</strong></div>
    <p>读取 {preview.totalRows} 行 · 有效编码 {preview.validCount} 条{preview.duplicateCount ? ` · 已去重 ${preview.duplicateCount} 条` : ''}</p>
    {preview.issues.length ? <><p className="housing-validation-error">请修正以下内容后重新上传。</p><ul>{preview.issues.slice(0, 8).map((issue, index) => <li key={`${issue.rowNumber}-${index}`}>第 {issue.rowNumber} 行：{issue.message}</li>)}</ul>{preview.issues.length > 8 && <p>另有 {preview.issues.length - 8} 项问题。</p>}</>
      : preview.codes.length ? <p className="housing-code-sample">编码预览：{preview.codes.slice(0, 2).map(row => row.code).join('、')}{preview.validCount > 2 ? '…' : ''}</p> : null}
  </div>;
}

export function HousingBindingResultTable({ rows, loading }: { rows: HousingBindingRow[]; loading?: boolean }) {
  return <div className="housing-table-scroll"><table className="housing-result-table"><thead><tr><th>Excel 行号</th><th>房屋编码</th><th>结果</th><th>说明</th></tr></thead><tbody>
    {rows.map(row => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td className="housing-code-value">{row.code}</td><td><span className={`housing-status housing-row-${row.status}`}>{housingRowLabel(row.status)}</span></td><td className="housing-result-message">{row.message || '—'}</td></tr>)}
    {!rows.length && <tr><td colSpan={4} className="housing-empty">{loading ? '正在读取处理结果…' : '暂无处理结果。'}</td></tr>}
  </tbody></table></div>;
}

export function HousingBindingPage({ sessionStatus, onLogin, compact = false, onOpenWorkspace, api: suppliedApi }: {
  sessionStatus: string; onLogin(): void; compact?: boolean; onOpenWorkspace?(): void; api?: HousingBindingApi;
}) {
  const api = suppliedApi ?? (typeof window === 'undefined' ? undefined : window.desktopApi.housingBinding);
  const [acceptanceNumber, setAcceptanceNumber] = useState('');
  const [certificateNumber, setCertificateNumber] = useState('');
  const [preview, setPreview] = useState<HousingImportPreview | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [templateDirectory, setTemplateDirectory] = useState('');
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [list, setList] = useState<HousingBindingState>({ jobs: [], total: 0 });
  const [listLoading, setListLoading] = useState(true);
  const [detail, setDetail] = useState<HousingBindingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [jobPage, setJobPage] = useState(1);
  const [rowPage, setRowPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const actionInFlight = useRef(false);
  const actionGeneration = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; actionGeneration.current++; }; }, []);

  useEffect(() => {
    let disposed = false;
    let active = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setListLoading(true); setListError('');
    const refresh = async () => {
      if (!api) { if (!disposed) { setListLoading(false); setListError('自动绑定模块尚未就绪，请重新打开应用。'); } return; }
      try {
        const result = await api.state(compact ? 1 : jobPage);
        if (disposed) return;
        setList(result); setListError(''); setListLoading(false);
        setSelectedJobId(current => current || result.jobs[0]?.id || '');
        active = result.jobs.some(housingJobIsActive);
        if (active) timer = setTimeout(() => { void refresh(); }, 3000);
      } catch (error) {
        if (disposed) return;
        setListError(failureMessage(error, '任务列表暂时无法读取')); setListLoading(false);
        if (active) timer = setTimeout(() => { void refresh(); }, 3000);
      }
    };
    void refresh();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [api, compact, jobPage, revision]);

  useEffect(() => {
    let disposed = false;
    let active = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setDetail(null); setDetailError('');
    if (!api || !selectedJobId) return;
    setDetailLoading(true);
    const refresh = async () => {
      try {
        const result = await api.detail(selectedJobId, compact ? 1 : rowPage);
        if (disposed) return;
        if (result.job.id !== selectedJobId) throw new Error('任务结果与当前选择不匹配，请重新选择任务。');
        setDetail(result); setDetailLoading(false); setDetailError('');
        active = housingJobIsActive(result.job);
        if (active) timer = setTimeout(() => { void refresh(); }, 3000);
      } catch (error) {
        if (disposed) return;
        setDetailLoading(false); setDetailError(failureMessage(error, '处理明细暂时无法读取'));
        if (active) timer = setTimeout(() => { void refresh(); }, 3000);
      }
    };
    void refresh();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [api, selectedJobId, compact, rowPage, revision]);

  async function perform(name: string, operation: (bindingApi: HousingBindingApi) => Promise<void>) {
    if (actionInFlight.current || !api) return;
    actionInFlight.current = true; const generation = ++actionGeneration.current;
    setBusy(name); setMessage('');
    try { await operation(api); }
    catch (error) { if (mounted.current && generation === actionGeneration.current) setMessage(failureMessage(error, '操作未完成，请重试。')); }
    finally { actionInFlight.current = false; if (mounted.current && generation === actionGeneration.current) setBusy(''); }
  }

  function importWorkbook() {
    void perform('import', async bindingApi => {
      const generation = actionGeneration.current;
      if (mounted.current) setPreview(null);
      const result = await bindingApi.importWorkbook();
      if (mounted.current && generation === actionGeneration.current && result) setPreview(result);
    });
  }

  function createTask() {
    if (!acceptanceNumber.trim() || !certificateNumber.trim() || !housingImportCanSubmit(preview) || sessionStatus !== 'authenticated') return;
    const input = { acceptanceNumber: acceptanceNumber.trim(), certificateNumber: certificateNumber.trim(), importId: preview!.importId };
    void perform('create', async bindingApi => {
      const generation = actionGeneration.current;
      const job = await bindingApi.create(input);
      if (!mounted.current || generation !== actionGeneration.current) return;
      setPreview(null); setSelectedJobId(job.id); setRowPage(1); setJobPage(1); setRevision(value => value + 1);
      setMessage('自动绑定任务已创建，可以在下方查看处理进度。');
    });
  }

  function taskAction(action: 'cancel' | 'retry', jobId: string) {
    void perform(`${action}:${jobId}`, async bindingApi => {
      const generation = actionGeneration.current;
      const job = await bindingApi[action](jobId);
      if (!mounted.current || generation !== actionGeneration.current) return;
      setSelectedJobId(job.id); setRowPage(1); setJobPage(1); setRevision(value => value + 1);
      setMessage(action === 'cancel' ? '停止后续处理；已提交但未确认的房屋会保留为待核对，重试时先检查已有关系。' : '已创建重试任务，将核对原有关联后继续处理未完成项。');
    });
  }

  const visibleDetail = detail?.job.id === selectedJobId ? detail : null;
  const currentJob = visibleDetail?.job ?? list.jobs.find(job => job.id === selectedJobId);
  const jobPages = Math.max(1, Math.ceil(list.total / JOB_PAGE_SIZE));
  const rowPages = Math.max(1, Math.ceil((visibleDetail?.total ?? 0) / ROW_PAGE_SIZE));
  return <section className={`housing-binding-page${compact ? ' housing-binding-compact' : ''}`} aria-label="房屋编码自动绑定">
    <section className="panel housing-binding-form-panel">
      <header className="housing-panel-head"><div><span className="housing-eyebrow">租赁办件辅助</span><h2>房屋编码自动绑定</h2><p>填写办件与产权资料，上传房屋编码，整批生成一条顺序执行的任务。</p></div>
        {compact && onOpenWorkspace && <button className="text-button" onClick={onOpenWorkspace}>全部任务 <AppIcon name="chevron" size={15} /></button>}</header>
      <form onSubmit={event => { event.preventDefault(); createTask(); }}>
        <div className="housing-binding-fields"><label>受理编号<input autoComplete="off" required maxLength={100} value={acceptanceNumber} placeholder="填写原系统受理编号" disabled={Boolean(busy)} onChange={event => setAcceptanceNumber(event.target.value)} /></label>
          <label>产权证号<input autoComplete="off" required maxLength={200} value={certificateNumber} placeholder="填写本批房屋对应的产权证号" disabled={Boolean(busy)} onChange={event => setCertificateNumber(event.target.value)} /></label></div>
        <div className="housing-upload-row"><div><h3>房屋编码清单</h3><p id="housing-upload-help">上传 .xlsx，表头使用“房屋编码”。完整房屋编码请按文本格式填写，保留前导零。</p></div><div className="housing-button-row"><button type="button" className="text-button" disabled={Boolean(busy) || !api} onClick={() => { void perform('template', async bindingApi => { const generation = actionGeneration.current; const result = await bindingApi.template(); if (mounted.current && generation === actionGeneration.current) { setTemplateDirectory(result.directory); setMessage(`模板已保存：${result.fileName}，位于应用导出目录。`); } }); }}><AppIcon name="download" size={16} />{busy === 'template' ? '正在生成…' : '下载模板'}</button>
            <button type="button" className="secondary" aria-describedby="housing-upload-help" disabled={Boolean(busy) || !api} onClick={importWorkbook}><AppIcon name="upload" size={17} />{busy === 'import' ? '正在读取…' : preview ? '重新上传' : '上传 Excel'}</button></div></div>
        {preview && <HousingImportSummary preview={preview} />}
        <div className="housing-create-row"><button type="submit" className="primary" disabled={Boolean(busy) || !api || sessionStatus !== 'authenticated' || !acceptanceNumber.trim() || !certificateNumber.trim() || !housingImportCanSubmit(preview)}>{busy === 'create' ? '正在创建任务…' : `创建自动绑定任务${housingImportCanSubmit(preview) ? `（${preview!.validCount}条）` : ''}`}</button>
          {sessionStatus !== 'authenticated' ? <><span className="housing-session-note">请先完成原系统登录。</span><button type="button" className="text-button" disabled={Boolean(busy)} onClick={onLogin}>登录房屋租赁系统 <AppIcon name="arrow" size={16} /></button></> : <span className="housing-session-note"><AppIcon name="check" size={16} />原系统已登录 · 已绑定的房屋自动跳过</span>}</div>
      </form>
      {message && <p className="housing-message" role="status">{message}</p>}
      {templateDirectory && <button type="button" className="text-button housing-template-folder" disabled={Boolean(busy)} onClick={() => { void perform('folder', async bindingApi => { if (!await bindingApi.openTemplateFolder()) throw new Error('暂时无法打开模板所在文件夹，请稍后重试。'); }); }}>打开模板所在文件夹 <AppIcon name="chevron" size={15} /></button>}
    </section>

    <section className="panel housing-jobs-panel" aria-label="自动绑定任务">
      <header className="housing-panel-head"><div><h3>{compact ? '最近绑定任务' : '绑定任务'}</h3><p>每批房屋对应一条任务，处理结果保存在本机。</p></div><button className="text-button" disabled={Boolean(busy)} onClick={() => setRevision(value => value + 1)}><AppIcon name="refresh" size={16} />刷新</button></header>
      {listError && <p className="housing-message" role="status">{listError}</p>}
      <div className="housing-table-scroll"><table className="housing-job-table"><thead><tr><th>受理编号 / 产权证号</th><th>房屋数量</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>
        {(compact ? list.jobs.slice(0, 3) : list.jobs).map(job => <tr key={job.id} className={job.id === selectedJobId ? 'is-selected' : ''}><td><button className="housing-job-select" aria-pressed={job.id === selectedJobId} onClick={() => { setSelectedJobId(job.id); setRowPage(1); }}>{job.acceptanceNumber}</button><span className="housing-certificate-number">{job.certificateNumber}</span></td><td>{job.total}</td><td><span className={`housing-status housing-phase-${job.phase}`}>{housingJobLabel(job.phase)}</span></td><td>{timestamp(job.createdAt)}</td><td><button className="link-button" onClick={() => { setSelectedJobId(job.id); setRowPage(1); }}>查看结果</button></td></tr>)}
        {!list.jobs.length && <tr><td colSpan={5} className="housing-empty">{listLoading ? '正在读取绑定任务…' : '暂无绑定任务，上传房屋编码后即可创建。'}</td></tr>}
      </tbody></table></div>
      {!compact && list.total > JOB_PAGE_SIZE && <div className="housing-pagination"><span>共 {list.total} 条任务 · 第 {jobPage}/{jobPages} 页</span><button className="secondary" disabled={jobPage <= 1 || listLoading} onClick={() => setJobPage(value => value - 1)}>上一页</button><button className="secondary" disabled={jobPage >= jobPages || listLoading} onClick={() => setJobPage(value => value + 1)}>下一页</button></div>}
    </section>

    {selectedJobId && <section className="panel housing-detail-panel" aria-label="房屋绑定处理明细">
      <header className="housing-panel-head"><div><h3>处理明细</h3>{currentJob && <p>{currentJob.acceptanceNumber} · {currentJob.certificateNumber}</p>}</div><div className="housing-button-row">
        {currentJob && housingJobIsActive(currentJob) && <button className="secondary" disabled={Boolean(busy)} onClick={() => taskAction('cancel', currentJob.id)}>{busy === `cancel:${currentJob.id}` ? '正在取消…' : '取消任务'}</button>}
        {currentJob && housingJobCanRetry(currentJob) && <button className="secondary" disabled={Boolean(busy) || sessionStatus !== 'authenticated'} onClick={() => taskAction('retry', currentJob.id)}>{busy === `retry:${currentJob.id}` ? '正在创建…' : '重试未完成项'}</button>}
      </div></header>
      {detailError && <p className="housing-message" role="status">{detailError}</p>}
      {currentJob?.phase === 'waiting-login' && <div className="housing-login-pause" role="status"><div><strong>任务已暂停，等待重新登录</strong><p>完成登录后继续处理剩余房屋，已确认的关联会保留。</p></div><button className="secondary" onClick={onLogin}>重新登录</button></div>}
      {currentJob && <><HousingBindingCounts job={currentJob} />{currentJob.error && <p className="housing-message" role="status">{currentJob.error}</p>}<div className="housing-task-progress"><progress aria-label="房屋编码处理进度" value={Math.max(0, currentJob.total - currentJob.pending)} max={Math.max(1, currentJob.total)} /><span>已处理 {Math.max(0, currentJob.total - currentJob.pending)}/{currentJob.total} 条</span></div></>}
      <HousingBindingResultTable rows={compact ? visibleDetail?.rows.slice(0, 5) ?? [] : visibleDetail?.rows ?? []} loading={detailLoading} />
      {compact && (visibleDetail?.total ?? 0) > 5 && onOpenWorkspace && <button className="text-button housing-detail-more" onClick={onOpenWorkspace}>进入任务页查看全部结果 <AppIcon name="chevron" size={15} /></button>}
      {!compact && (visibleDetail?.total ?? 0) > ROW_PAGE_SIZE && <div className="housing-pagination"><span>共 {visibleDetail!.total} 个房屋 · 第 {rowPage}/{rowPages} 页</span><button className="secondary" disabled={rowPage <= 1 || detailLoading} onClick={() => setRowPage(value => value - 1)}>上一页</button><button className="secondary" disabled={rowPage >= rowPages || detailLoading} onClick={() => setRowPage(value => value + 1)}>下一页</button></div>}
    </section>}
  </section>;
}
