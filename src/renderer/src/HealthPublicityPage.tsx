import { useEffect, useMemo, useRef, useState } from 'react';
import { DOUBLE_PUBLICITY_TEMPLATE } from '../../core/double-publicity/template';
import { validateExport } from '../../core/double-publicity/validation';
import type { HealthPublicityDocument, HealthPublicityState } from '../../core/tools/health-publicity/types';
import { AppIcon } from './AppIcon';
import { Modal } from './Modal';
import { ExportNotice, type ExportResult } from './ExportNotice';

const required = new Set(['xkXdrMc','xkXdrLb','xkXdrShxym','xkFrdb','xkXkws','xkWsh','xkXklb','xkNr','xkJdrq','xkYxqz','xkYxqzi','xkXkjg','xkXkjgdm','xkZt','xkLydw','xkLydwdm']);
const dates = new Set(['xkJdrq','xkYxqz','xkYxqzi']);

export function HealthPublicityPage({ licensed, allowExport }: { licensed: boolean; allowExport: boolean }) {
  const [state, setState] = useState<HealthPublicityState>({ documents: [], authorityCode: '' });
  const [authorityCode, setAuthorityCode] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<HealthPublicityDocument | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const busyRef = useRef(false);
  const [errors, setErrors] = useState<Array<{ fileName: string; message: string }>>([]);
  const apply = (value: HealthPublicityState) => { setState(value); setAuthorityCode(value.authorityCode); };
  useEffect(() => {
    if (!licensed) return;
    void window.desktopApi.healthTool.state().then(value => { apply(value); setSelected(value.documents.map(doc => doc.id)); }).catch(error => setMessage(error instanceof Error ? error.message : '工具数据加载失败'));
  }, [licensed]);
  const validation = useMemo(() => validateExport(state.documents.map(doc => ({ systemId: 'health-publicity', matterId: 'word-to-publicity', recordKey: doc.id, firstSeenAt: doc.createdAt, updatedAt: doc.createdAt,
    data: { ...doc.data, xkXkjgdm: doc.data.xkXkjgdm || state.authorityCode, xkLydwdm: doc.data.xkLydwdm || state.authorityCode } }))), [state]);
  const issues = new Map(validation.issues.map(issue => [issue.recordKey, issue]));
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage(''); setExportResult(null);
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const importFiles = () => run(async () => {
    const result = await window.desktopApi.healthTool.importFiles();
    if (!result) return;
    apply(result.state); setErrors(result.errors);
    setSelected(current => [...new Set([...current, ...result.state.documents.map(doc => doc.id)])]);
    setMessage(`已导入 ${result.added} 份，跳过重复 ${result.duplicates} 份，失败 ${result.errors.length} 份。请核对字段后导出。`);
  });
  const exportFiles = () => run(async () => {
    if (authorityCode !== state.authorityCode) throw new Error('机关信用代码有未保存的修改，请先保存');
    const result = await window.desktopApi.healthTool.export(selected);
    setExportResult(result);
    apply(await window.desktopApi.healthTool.state());
    if (!result) setMessage('已取消导出');
  });
  const closeEditor = () => {
    if (editing && JSON.stringify(draft) !== JSON.stringify(editing.data) && !window.confirm('尚未保存字段修改，确定放弃本次修改？')) return;
    setEditing(null);
  };
  if (!licensed) return <>
    <header className="page-header"><div><span className="eyebrow">工具</span><h1>卫健局双公示工具</h1><p>从医疗机构登记批复 Word 生成行政许可双公示表格，无需登录业务系统。</p></div></header>
    <section className="panel health-locked"><h3>当前授权尚未包含此工具</h3><p>请联系管理员单独授权“卫健局双公示工具”。工具可以独立使用，不必购买业务系统回流权限。</p></section>
  </>;
  return <>
    <header className="page-header"><div><span className="eyebrow">工具 / 本地文档处理</span><h1>卫健局双公示工具</h1><p>从 Word 批复生成双公示表格，核对字段与提取依据后导出。</p></div><button className="primary" disabled={busy || !selected.length || !allowExport} onClick={() => void exportFiles()}><AppIcon name="download" size={16} />导出所选 {selected.length} 条</button></header>
    <section className="health-import" aria-label="导入 Word 文档"><span className="system-card-icon"><AppIcon name="document" size={28} /></span><div><h2>选择 Word 批复，开始生成</h2><p>支持 DOCX，每次最多 50 份。仅在本机解析，不上传原文。</p></div><button className="secondary" disabled={busy} onClick={() => void importFiles()}><AppIcon name="upload" size={16} />{busy ? '处理中…' : '导入 Word 批复'}</button></section>
    <section className="panel health-settings"><div><strong>许可机关 / 数据来源单位信用代码</strong><p>文书未提供时，可在此统一补填。只对对应字段为空的记录生效，不覆盖逐条核对后的值。</p></div><label><span className="sr-only">机关统一社会信用代码</span><input aria-label="机关统一社会信用代码" value={authorityCode} maxLength={18} placeholder="未知请留空，不会自动猜填" onChange={event => setAuthorityCode(event.target.value)} disabled={busy} /></label><button className="secondary" disabled={busy} onClick={() => void run(async () => { apply(await window.desktopApi.healthTool.settings(authorityCode)); setMessage('机关信用代码已保存'); })}>保存</button></section>
    {!allowExport && <div className="message page-message">当前授权不包含导出，请联系管理员开启导出功能。</div>}
    {message && <div role="status" className="message page-message">{message}</div>}
    {exportResult && <ExportNotice result={exportResult} />}
    {errors.length > 0 && <section className="panel health-errors"><h3>未能导入的文件</h3>{errors.map((error, index) => <p key={index}>{error.fileName}：{error.message}</p>)}</section>}
    <section className="panel health-documents"><div className="panel-head"><div><h3>文档记录</h3><p>共 {state.documents.length} 份 · {validation.invalid} 条存在待补填或填写问题。点击“核对字段”查看原文和提取依据。</p></div><small>重复文档按内容识别，不重复生成记录</small></div>
      <div className="table-wrap"><table className="data-table health-table"><thead><tr><th><input type="checkbox" aria-label="选择全部文档" disabled={busy || !state.documents.length} checked={state.documents.length > 0 && selected.length === state.documents.length} onChange={event => setSelected(event.target.checked ? state.documents.map(doc => doc.id) : [])} /></th><th>登记类型 / 文书号</th><th>行政相对人</th><th>决定日期</th><th>核对状态</th><th>操作</th></tr></thead><tbody>{state.documents.map(doc => {
        const issue = issues.get(doc.id);
        return <tr key={doc.id} className={issue ? 'health-row-warning' : ''}><td><input type="checkbox" aria-label={`选择 ${doc.fileName}`} disabled={busy} checked={selected.includes(doc.id)} onChange={event => setSelected(current => event.target.checked ? [...current, doc.id] : current.filter(id => id !== doc.id))} /></td><td><strong>{doc.kind}</strong><div>{doc.data.xkWsh}</div><small title={doc.fileName}>{doc.fileName}</small></td><td>{doc.data.xkXdrMc}<small>{doc.data.xkXdrShxym || '待核实机构统一社会信用代码'}</small></td><td>{doc.data.xkJdrq || '待补填'}</td><td title={issue?.fields.map(field => `${field.label}：${field.message}`).join('\n')}><span className={`status-chip ${issue ? 'warning' : 'ready'}`}>{issue ? `待核对 ${issue.fields.length} 项` : '必填项已填写'}</span><small>{doc.warnings.length} 条提取提醒</small></td><td><button className="text-button" disabled={busy} onClick={() => { setEditing(doc); setDraft({ ...doc.data }); }}>核对字段</button><button className="text-button health-remove" disabled={busy} onClick={() => { if (window.confirm('从本地工具移除此记录及手工修改？原 Word 文件不会删除。')) void run(async () => { apply(await window.desktopApi.healthTool.remove(doc.id)); setSelected(current => current.filter(id => id !== doc.id)); }); }}>移除</button></td></tr>;
      })}</tbody></table>{!state.documents.length && <div className="empty">导入 Word 批复开始生成双公示表格。支持执业登记、变更登记和注销登记，每次最多 50 份。</div>}</div>
    </section>
    {editing && <Modal backdropClassName="health-modal-backdrop" className="health-editor" labelledBy="health-editor-title" onClose={() => { if (!busy) closeEditor(); }}><div className="panel-head"><div><span className="eyebrow">31 个模板字段 · 原文对照</span><h2 id="health-editor-title">核对双公示字段</h2><p>{editing.fileName}</p></div><button className="secondary" disabled={busy} onClick={closeEditor}>关闭</button></div>
      <div className="health-editor-body"><div className="health-fields"><details className="health-warning"><summary>提取提醒 {editing.warnings.length} 条{issues.get(editing.id) ? ` · 待核对 ${issues.get(editing.id)!.fields.length} 项` : ''}，点击查看</summary>{editing.warnings.map((warning, index) => <p key={index}>{warning}</p>)}{issues.get(editing.id) && <p>待核对：{issues.get(editing.id)!.fields.map(field => field.label).join('、')}</p>}</details>
        {DOUBLE_PUBLICITY_TEMPLATE.map(([key, label]) => <label key={key} className={`health-field ${required.has(key) && !draft[key] && !(['xkXkjgdm','xkLydwdm'].includes(key) && state.authorityCode) ? 'health-field-missing' : ''}`}><span>{label}{required.has(key) && <em> *</em>}</span>{key === 'xkNr' || key === 'bz' ? <textarea value={draft[key] ?? ''} maxLength={30000} rows={key === 'xkNr' ? 6 : 2} onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} /> : key === 'xkXdrLb' ? <select value={draft[key] ?? ''} onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))}><option value="">请选择</option>{['法人及非法人组织','个体工商户','自然人'].map(value => <option key={value}>{value}</option>)}</select> : <input type={dates.has(key) ? 'date' : 'text'} value={draft[key] ?? ''} placeholder={['xkXkjgdm','xkLydwdm'].includes(key) ? state.authorityCode || '待补填' : ''} maxLength={30000} onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} />}<small>{draft[key] !== editing.sourceData[key] ? '已手工填写或调整。原文提取值：' + (editing.sourceData[key] || '未提供') : editing.evidence[key] || (['xkXkjgdm','xkLydwdm'].includes(key) && state.authorityCode ? '导出时采用已保存的机关信用代码' : '原文未提供，需核实后补填')}</small></label>)}
      </div><div className="health-source"><h3>Word 原文</h3><p>原文只读。字段修改不会覆盖原文或提取依据。</p><pre>{editing.sourceText}</pre></div></div>
      <footer className="health-editor-footer"><span>* 按机构主体的现有双公示规则标注，保存不等于通过报送审核。</span><div className="button-row"><button className="secondary" disabled={busy} onClick={closeEditor}>取消</button><button className="primary" disabled={busy} onClick={() => void run(async () => { apply(await window.desktopApi.healthTool.update(editing.id, draft)); setEditing(null); setMessage('字段已保存；原文和提取依据保持不变'); })}>保存字段</button></div></footer>
    </Modal>}
  </>;
}
