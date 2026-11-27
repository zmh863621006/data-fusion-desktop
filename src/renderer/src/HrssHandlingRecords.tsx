import { handlingColumns, hrssHandlingStatusLabel, readHandlingRecords } from '../../core/hrss/handling-records';
import { AppIcon } from './AppIcon';
import { Modal } from './Modal';

/** Workflow history is already in the local snapshot; opening this panel makes no source requests. */
export function HrssHandlingRecords({ systemId = 'guangdong-hrss', data, onClose }: { systemId?: string; data: Record<string, unknown>; onClose: () => void }) {
  const isShenzhen = systemId === 'shenzhen-integrated-services';
  const records = readHandlingRecords(data.handlingRecords, systemId);
  const columns = handlingColumns(systemId);
  const maskOperator = (name: string) => name ? name.slice(0, 1) + '*'.repeat(Math.min(4, Math.max(1, name.length - 1))) : '—';
  const text = (value: unknown) => typeof value === 'boolean' ? value ? '是' : '否' : typeof value === 'string' || typeof value === 'number' ? String(value) || '—' : '—';
  const failed = data.handlingRecordStatus === 'failed';
  const subjectName = text(data.subjectName);
  const identity = isShenzhen ? [
    ['办件编号', text(data.caseNumber ?? data.applicationNumber ?? data.processNumber)],
    ['申请人 / 单位', data.subjectType === 'per' || data.subjectType === '1' ? maskOperator(subjectName === '—' ? '' : subjectName) : subjectName],
    ['接收时间', text(data.receivedAt)],
    ['申办流水号', text(data.applicationNumber)],
    ['业务流水号', text(data.processNumber)],
    ['业务状态', text(data.businessState)],
  ] : [['申请编号', text(data.applyBh)], ['单位名称', text(data.unitName)], ['申请日期', text(data.applyDate)]];
  return <Modal onClose={onClose} labelledBy="hrss-handling-title" className={`hrss-handling-panel${isShenzhen ? ' shenzhen-handling-panel' : ''}`} backdropClassName="hrss-handling-backdrop">
    <header className="hrss-handling-header"><div><span className="eyebrow">本地办理记录</span><h2 id="hrss-handling-title">办理记录</h2></div>
      <button type="button" className="secondary" aria-label="关闭办理记录" onClick={onClose}><AppIcon name="close" size={18} /></button></header>
    <dl className="hrss-handling-identity">{identity.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p className="hrss-handling-summary">{hrssHandlingStatusLabel(data.handlingRecordStatus)}{data.handlingRecordStatus === 'collected' || data.handlingRecordStatus === 'skipped-pending' ? ` · 共 ${records.length} 条` : failed && records.length ? ` · 保留上次 ${records.length} 条记录` : ''}。{isShenzhen ? '按所选日期筛选办件，办理过程保留全部时间范围。' : '按申请日期筛选办件，办理记录保留全部时间范围。'}</p>
    {failed && <p className="hrss-handling-warning" role="status">本次未能完整获取办理过程，已保留办件资料{records.length ? '及上次采集的记录' : ''}。重新回流后可补齐。</p>}
    {records.length ? <div className="hrss-handling-table" role="region" aria-label="办理过程明细" tabIndex={0}><table><thead><tr><th>序号</th>{columns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead>
      <tbody>{records.map((record, index) => <tr key={index}><td>{index + 1}</td>{columns.map(column => <td key={column.key}>{column.key === 'operator' || column.key === 'reviewer' ? maskOperator(String(record[column.key] ?? '')) : text(record[column.key])}</td>)}</tr>)}</tbody></table></div>
      : <p className="hrss-handling-empty">{failed ? '办理过程待补齐，请重新回流后查看。' : data.handlingRecordStatus === 'skipped-pending' ? '该办件为待受理，已保留在业务列表中，暂无办理记录。' : data.handlingRecordStatus === 'collected' ? '原系统未返回办理记录。' : '此记录尚未采集办理记录，请重新回流后查看。'}</p>}
    <footer>个人姓名默认脱敏显示；Excel 导出保留完整办理记录。</footer>
  </Modal>;
}
