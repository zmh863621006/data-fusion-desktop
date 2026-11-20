import { useEffect, useRef, useState } from 'react';
import { AppIcon } from './AppIcon';
import { ExportNotice, type ExportResult } from './ExportNotice';
import './HrssLedgerPage.css';
import { HrssBatchDateNotice } from './HrssDateNotice';
import { hrssTaskDateLabel } from '../../core/hrss/date-filters';
import { BatchPageOptions, selectBatchOption, useCompletedBatches } from './useCompletedBatches';

export interface HrssListColumn { key: string; label: string; sensitive?: boolean }
interface Row { recordKey: string; data: Record<string, unknown>; updatedAt?: number; rowNo?: number }
const SYSTEM_ID = 'guangdong-hrss';

export function hrssDisplayValue(column: HrssListColumn, value: unknown): string {
  const text = value === null || value === undefined || value === '' ? '' : String(value);
  if (!text) return '—';
  if (!column.sensitive && !/^(name|personName|cardNumber|idNumber|phone|mobile|contactName|contactPhone)$/.test(column.key)) return text;
  if (/name/i.test(column.key)) return text.slice(0, 1) + '*'.repeat(Math.min(4, Math.max(1, text.length - 1)));
  if (text.length <= 7) return '***';
  return text.slice(0, 3) + '********' + text.slice(-4);
}

export function HrssLedgerPage({ matterId, matterName, columns, batchId = '', onBatchChange, allowExport = false, preview = false, onViewAll }: {
  matterId: string; matterName: string; columns: readonly HrssListColumn[]; batchId?: string;
  onBatchChange?: (id: string) => void; allowExport?: boolean; preview?: boolean; onViewAll?: () => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const batchPages = useCompletedBatches(SYSTEM_ID, matterId, batchId, revision, !preview);
  const { batches } = batchPages;
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exporting, setExporting] = useState(false);
  const generation = useRef(0), exportLock = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true); setRows([]); setError(''); setExportResult(null);
    const request = batchId
      ? window.desktopApi.tasks.output(batchId, page, preview ? 10 : pageSize, search || undefined)
      : window.desktopApi.records.list({ systemId: SYSTEM_ID, matterId, keyword: search || undefined, page, pageSize: preview ? 10 : pageSize });
    void request.then((result: { rows: Row[]; total: number }) => {
      if (current !== generation.current) return;
      setRows(preview ? result.rows.slice(0, 5) : result.rows); setTotal(result.total);
    }).catch(error => { if (current === generation.current) { setTotal(0); setError(error instanceof Error ? error.message : '列表台账读取失败'); } })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { ++generation.current; };
  }, [matterId, batchId, page, pageSize, search, revision, preview]);

  const exportData = async () => {
    if (exportLock.current) return;
    exportLock.current = true; setExporting(true); setError(''); setExportResult(null);
    const current = generation.current;
    try {
      const result = batchId ? await window.desktopApi.tasks.exportOutput(batchId, search || undefined)
        : await window.desktopApi.records.export({ systemId: SYSTEM_ID, matterId, keyword: search || undefined }, 'xlsx');
      if (current === generation.current) setExportResult(result as ExportResult | null);
    } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : '导出失败'); }
    finally { exportLock.current = false; setExporting(false); }
  };
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const visibleColumns = preview ? columns.slice(0, 5) : columns;
  return <section className={`hrss-ledger ${preview ? 'hrss-ledger-preview' : ''}`} aria-label="人社列表台账">
    <header className="hrss-ledger-head"><div><span className="eyebrow">{preview ? '本机数据' : '业务台账'}</span><h2>{preview ? '本地列表预览' : matterName}</h2><p>{batchId ? '当前查看已完成回流的列表快照。' : '合并保存历次列表记录；重新回流会更新相同业务记录。'}个人信息默认脱敏显示。</p></div>
      {preview ? <button className="secondary" onClick={onViewAll}>查看台账 <AppIcon name="chevron" size={14} /></button>
        : allowExport && <button className="primary" aria-busy={exporting} disabled={exporting || loading || !total} onClick={() => void exportData()}><AppIcon name="download" size={17} />{exporting ? '正在导出…' : batchId ? '导出当前批次' : '导出台账'}</button>}
    </header>
    {!preview && batchId && <HrssBatchDateNotice details={batches.find(task => task.id === batchId)?.details} />}
    {(error || batchPages.error) && <p className="inline-error" role="alert">{error || batchPages.error}<button className="link-button" onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {exportResult && <ExportNotice result={exportResult} />}
    {!preview && <form className="hrss-ledger-filters" onSubmit={event => { event.preventDefault(); setPage(1); setSearch(keyword.trim()); setRevision(value => value + 1); }}>
      <label><span>回流批次</span><select value={batchId} onChange={event => selectBatchOption(event.target.value, batchPages, id => { setPage(1); onBatchChange?.(id); })}><option value="">当前合并台账</option>{batches.map(task => <option key={task.id} value={task.id} title={hrssTaskDateLabel(task.details)}>{new Date(task.finishedAt ?? task.createdAt).toLocaleString()} · {task.id.slice(0, 8).toUpperCase()}{task.details?.dateFilterStatus === 'pending' ? ' · 日期筛选待接入' : ''}</option>)}<BatchPageOptions {...batchPages} /></select></label>
      <label><span>列表搜索</span><input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="申请编号、姓名或单位" /></label>
      <button className="primary" type="submit" disabled={loading}>查询</button><button className="secondary" type="button" disabled={loading} onClick={() => setRevision(value => value + 1)} aria-label="刷新台账"><AppIcon name="refresh" size={18} /></button>
    </form>}
    <div className="panel hrss-list-table" aria-busy={loading}><table><thead><tr><th>序号</th>{visibleColumns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>
      {rows.map((row, index) => <tr key={row.recordKey}><td>{row.rowNo ?? ((page - 1) * pageSize + index + 1)}</td>{visibleColumns.map(column => <td key={column.key}>{hrssDisplayValue(column, row.data[column.key])}</td>)}</tr>)}
      {!rows.length && <tr><td colSpan={visibleColumns.length + 1} className="empty">{loading ? '正在读取本地列表…' : error ? '暂时无法读取数据' : '尚无列表记录，请先登录原系统并完成回流'}</td></tr>}
    </tbody></table></div>
    <footer className="hrss-ledger-footer"><span>{loading ? '正在读取…' : `共 ${total.toLocaleString()} 条列表记录`}{preview && total > 5 ? '，预览最近5条' : ''}</span>
      {!preview && <div><label>每页<select value={pageSize} onChange={event => { setPage(1); setPageSize(Number(event.target.value)); }}><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select>条</label><button className="secondary" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page} / {pageCount}</span><button className="secondary" disabled={loading || page >= pageCount} onClick={() => setPage(value => value + 1)}>下一页</button></div>}
    </footer>
  </section>;
}
