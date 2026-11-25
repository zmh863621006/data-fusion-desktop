import { useMemo, useRef, useState } from 'react';
import type { QueryFieldSchema } from '../../core/query/types';
import { validateFilters } from '../../core/query/validation';
import { Modal } from './Modal';
import { AppIcon } from './AppIcon';
import './BatchReturnPanel.css';

export interface BatchReturnMatter {
  id: string;
  name: string;
  departmentId?: string;
  departmentName?: string;
  departmentOrder?: number;
  matterOrder?: number;
  executionMode?: 'interactive-query' | 'one-click-return';
  querySchema: QueryFieldSchema[];
  defaultFilters?: Record<string, unknown>;
}
export interface BatchReturnPayload {
  matterIds: string[];
  startDate: string;
  endDate: string;
  filtersByMatter?: Record<string, Record<string, unknown>>;
}
export interface BatchReturnCreated { batchId: string; taskIds: string[]; count: number }

const ordinaryDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const extraFields = (matter: BatchReturnMatter) => matter.querySchema.filter(field => !['startDate', 'endDate'].includes(field.key));

/** Freeze only declared per-matter controls; another matter's filters never enter this payload. */
export function buildBatchReturnPayload(matters: readonly BatchReturnMatter[], selected: ReadonlySet<string>, startDate: string, endDate: string,
  values: Record<string, Record<string, unknown>>): BatchReturnPayload {
  if (!ordinaryDate(startDate) || !ordinaryDate(endDate) || startDate > endDate) throw new Error('请选择有效的开始日期和结束日期，开始日期不能晚于结束日期。');
  const chosen = matters.filter(matter => selected.has(matter.id));
  if (!chosen.length) throw new Error('请至少选择一个业务事项。');
  const filtersByMatter: Record<string, Record<string, unknown>> = {};
  const errors: string[] = [];
  for (const matter of chosen) {
    const extra = Object.fromEntries(extraFields(matter).flatMap(field => {
      const value = values[matter.id]?.[field.key] ?? matter.defaultFilters?.[field.key];
      return value === undefined ? [] : [[field.key, structuredClone(value)]];
    }));
    const all = { ...extra, ...Object.fromEntries(matter.querySchema.filter(field => field.key === 'startDate' || field.key === 'endDate')
      .map(field => [field.key, field.key === 'startDate' ? startDate : endDate])) };
    try { validateFilters(matter.querySchema, all); }
    catch (error) { errors.push(`${matter.name}：${error instanceof Error ? error.message : '请补齐查询条件'}`); }
    if (Object.keys(extra).length) filtersByMatter[matter.id] = extra;
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { matterIds: chosen.map(matter => matter.id), startDate, endDate,
    ...(Object.keys(filtersByMatter).length ? { filtersByMatter } : {}) };
}

function ExtraControl({ field, value, onChange, disabled }: { field: QueryFieldSchema; value: unknown; onChange: (value: unknown) => void; disabled: boolean }) {
  if (field.type === 'select' || field.type === 'multi-select') return <select disabled={disabled} multiple={field.type === 'multi-select'}
    value={field.type === 'multi-select' ? (Array.isArray(value) ? value.map(String) : []) : String(value ?? '')}
    onChange={event => onChange(field.type === 'multi-select'
      ? [...event.target.selectedOptions].map(option => field.options?.find(item => String(item.value) === option.value)?.value ?? option.value)
      : field.options?.find(option => String(option.value) === event.target.value)?.value ?? '')}>
    {field.type === 'select' && <option value="">请选择</option>}{field.options?.map(option => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
  </select>;
  if (field.type === 'date-range') return <span className="batch-extra-range">{[0, 1].map(index => <input key={index} type="date" aria-label={`${field.label}${index ? '结束' : '开始'}`}
    disabled={disabled} value={String(Array.isArray(value) ? value[index] ?? '' : '')} onChange={event => {
      const next = Array.isArray(value) ? [...value] : ['', '']; next[index] = event.target.value; onChange(next);
    }} />)}</span>;
  return <input disabled={disabled} type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} placeholder={field.placeholder}
    value={String(value ?? '')} onChange={event => onChange(field.type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)} />;
}

export function BatchReturnPanel({ systemId, systemName, matters, currentMatterId, startDate: initialStart, endDate: initialEnd, canRun,
  canSelectMatter = () => true, onClose, onCreated, submit }: {
  systemId: string; systemName: string; matters: readonly BatchReturnMatter[]; currentMatterId: string; startDate: string; endDate: string;
  canRun: boolean; canSelectMatter?: (id: string) => boolean; onClose: () => void; onCreated: (result: BatchReturnCreated) => void;
  submit: (systemId: string, payload: BatchReturnPayload) => Promise<BatchReturnCreated>;
}) {
  const eligible = useMemo(() => matters.filter(matter => matter.executionMode === 'one-click-return' && canSelectMatter(matter.id))
    .sort((a, b) => (a.departmentOrder ?? 0) - (b.departmentOrder ?? 0) || (a.matterOrder ?? 0) - (b.matterOrder ?? 0)), [matters, canSelectMatter]);
  const [selection, setSelection] = useState<Set<string>>(() => new Set(eligible.some(matter => matter.id === currentMatterId) ? [currentMatterId] : []));
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState(initialStart);
  const [endDate, setEndDate] = useState(initialEnd);
  const [values, setValues] = useState<Record<string, Record<string, unknown>>>({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const visible = eligible.filter(matter => `${matter.departmentName ?? ''} ${matter.name}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const groups = new Map<string, { name: string; matters: BatchReturnMatter[] }>();
  for (const matter of visible) {
    const key = matter.departmentId ?? '_all', group = groups.get(key) ?? { name: matter.departmentName ?? '业务事项', matters: [] };
    group.matters.push(matter); groups.set(key, group);
  }
  const chosen = eligible.filter(matter => selection.has(matter.id));
  const withExtras = chosen.filter(matter => extraFields(matter).length);
  const selectGroup = (items: readonly BatchReturnMatter[], selected: boolean) => {
    setError('');
    setSelection(current => {
      const next = new Set(current); for (const matter of items) selected ? next.add(matter.id) : next.delete(matter.id); return next;
    });
  };
  const close = () => { if (!inFlight.current) onClose(); };
  const create = async () => {
    if (inFlight.current || !canRun) return;
    let payload: BatchReturnPayload;
    try { payload = buildBatchReturnPayload(eligible, selection, startDate, endDate, values); }
    catch (error) { setError(error instanceof Error ? error.message : '请检查所选业务和日期。'); return; }
    inFlight.current = true; setSubmitting(true); setError('');
    try { const result = await submit(systemId, payload); onCreated(result); }
    catch (error) { setError(error instanceof Error ? error.message : '批量任务创建失败，请重试。'); }
    finally { inFlight.current = false; setSubmitting(false); }
  };
  const serial = ['guangdong-hrss', 'shenzhen-integrated-services'].includes(systemId);
  return <Modal onClose={close} labelledBy="batch-return-title" className="batch-return-panel" backdropClassName="batch-return-backdrop">
    <header className="batch-return-head"><div><span className="eyebrow">{systemName}</span><h2 id="batch-return-title">批量回流</h2><p>每个业务生成独立任务，使用下方选定的日期。</p></div>
      <button className="icon-button" disabled={submitting} aria-label="关闭批量回流" onClick={close}><AppIcon name="close" /></button></header>
    <div className="batch-return-content">
      <section className="batch-return-dates" aria-label="批量回流日期"><label>开始日期<input type="date" disabled={submitting} value={startDate} max={endDate || undefined} onChange={event => { setStartDate(event.target.value); setError(''); }} /></label>
        <label>结束日期<input type="date" disabled={submitting} value={endDate} min={startDate || undefined} onChange={event => { setEndDate(event.target.value); setError(''); }} /></label></section>
      <div className="batch-return-selection-head"><div><h3>选择业务事项</h3><span aria-live="polite">已选 {chosen.length} / {eligible.length} 项</span></div>
        <div className="batch-return-selection-actions"><button className="link-button" disabled={submitting || !eligible.length} onClick={() => selectGroup(eligible, true)}>全选当前系统</button>
          <button className="link-button" disabled={submitting || !chosen.length} onClick={() => { setSelection(new Set()); setError(''); }}>清空</button></div></div>
      <label className="batch-return-search"><AppIcon name="search" size={18} /><input type="search" disabled={submitting} placeholder="搜索业务或部门" aria-label="搜索业务或部门" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div className="batch-return-groups">{[...groups].map(([id, group]) => {
        const wholeGroup = eligible.filter(matter => (matter.departmentId ?? '_all') === id);
        const selectedCount = wholeGroup.filter(matter => selection.has(matter.id)).length;
        return <section key={id} className="batch-return-group"><div className="batch-return-group-head"><h4>{group.name}</h4>
          <button className="link-button" disabled={submitting} onClick={() => selectGroup(wholeGroup, selectedCount !== wholeGroup.length)}>{selectedCount === wholeGroup.length ? '取消本组' : '全选本组'}</button></div>
          {group.matters.map(matter => <label key={matter.id} className={`batch-return-choice${selection.has(matter.id) ? ' selected' : ''}`}><input type="checkbox" disabled={submitting}
            checked={selection.has(matter.id)} onChange={event => selectGroup([matter], event.target.checked)} /><span>{matter.name}</span></label>)}</section>;
      })}{!visible.length && <p className="batch-return-empty">{eligible.length ? '没有匹配的业务事项。' : '当前系统暂无可选业务事项。'}</p>}</div>
      {withExtras.length > 0 && <section className="batch-return-extra"><h3>各业务查询条件</h3><p>除日期外，以下条件分别应用到对应业务。</p>{withExtras.map(matter => <details key={matter.id} open={extraFields(matter).some(field => {
        const value = values[matter.id]?.[field.key] ?? matter.defaultFilters?.[field.key];
        return field.required && (value === undefined || value === null || value === '' || Array.isArray(value) && !value.length);
      })}>
        <summary>{matter.name}</summary><div className="batch-return-extra-fields">{extraFields(matter).map(field => <label key={field.key}><span>{field.label}{field.required ? ' *' : ''}</span>
          <ExtraControl field={field} disabled={submitting} value={values[matter.id]?.[field.key] ?? matter.defaultFilters?.[field.key]} onChange={value => { setValues(current => ({ ...current, [matter.id]: { ...current[matter.id], [field.key]: value } })); setError(''); }} /></label>)}</div></details>)}</section>}
    </div>
    {error && <div className="inline-error batch-return-error" role="alert">{error}</div>}
    <footer className="batch-return-footer"><p role={!canRun ? 'status' : undefined}>{!canRun ? '请先登录原系统，再创建回流任务。' : serial ? '按业务顺序逐项执行，其他业务进入等待队列。' : '各业务独立执行，并行数量遵循应用设置。'}</p>
      <div><button className="secondary" onClick={close} disabled={submitting}>取消</button><button className="primary" disabled={submitting || !canRun || !chosen.length} onClick={() => void create()}>{submitting ? '正在创建任务…' : `开始回流（${chosen.length}项）`}</button></div></footer>
  </Modal>;
}
