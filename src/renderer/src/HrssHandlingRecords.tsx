import { HRSS_HANDLING_COLUMNS, hrssHandlingStatusLabel, readHrssHandlingRecords } from '../../core/hrss/handling-records';
import { AppIcon } from './AppIcon';
import { Modal } from './Modal';

/** Workflow history is already in the local snapshot; opening this panel makes no source requests. */
export function HrssHandlingRecords({ data, onClose }: { data: Record<string, unknown>; onClose: () => void }) {
  const records = readHrssHandlingRecords(data.handlingRecords);
  const maskOperator = (name: string) => name ? name.slice(0, 1) + '*'.repeat(Math.min(4, Math.max(1, name.length - 1))) : '—';
  const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) || '—' : '—';
  return <Modal onClose={onClose} labelledBy="hrss-handling-title" className="hrss-handling-panel" backdropClassName="hrss-handling-backdrop">
    <header className="hrss-handling-header"><div><span className="eyebrow">本地办理记录</span><h2 id="hrss-handling-title">办理记录</h2></div>
      <button type="button" className="secondary" aria-label="关闭办理记录" onClick={onClose}><AppIcon name="close" size={18} /></button></header>
    <dl className="hrss-handling-identity"><div><dt>申请编号</dt><dd>{text(data.applyBh)}</dd></div><div><dt>单位名称</dt><dd>{text(data.unitName)}</dd></div><div><dt>申请日期</dt><dd>{text(data.applyDate)}</dd></div></dl>
    <p className="hrss-handling-summary">{hrssHandlingStatusLabel(data.handlingRecordStatus)}{data.handlingRecordStatus === 'collected' || data.handlingRecordStatus === 'skipped-pending' ? ` · 共 ${records.length} 条` : ''}。按申请日期筛选办件，办理记录保留全部时间范围。</p>
    {records.length ? <div className="hrss-handling-table"><table><thead><tr><th>序号</th>{HRSS_HANDLING_COLUMNS.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead>
      <tbody>{records.map((record, index) => <tr key={index}><td>{index + 1}</td>{HRSS_HANDLING_COLUMNS.map(column => <td key={column.key}>{column.key === 'operator' ? maskOperator(record.operator) : text(record[column.key])}</td>)}</tr>)}</tbody></table></div>
      : <p className="hrss-handling-empty">{data.handlingRecordStatus === 'skipped-pending' ? '该办件为待受理，已保留在业务列表中，暂无办理记录。' : data.handlingRecordStatus === 'collected' ? '原系统未返回办理记录。' : '此记录尚未采集办理记录，请重新回流后查看。'}</p>}
    <footer>个人姓名默认脱敏显示；Excel 导出保留完整办理记录。</footer>
  </Modal>;
}
