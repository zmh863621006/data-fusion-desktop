import { readOversizeApplicationEvidence } from '../../plugins/oversize-transport/application';

export function OversizeApplicationEvidence({ data }: { data: Record<string, unknown> }) {
  const evidence = readOversizeApplicationEvidence(data.oversizeApplicationEnrichment);
  if (!evidence) return null;
  return <section>
    <h3 className="drawer-section-title">办件补充依据 · {evidence.status === 'matched' ? '编号已匹配' : evidence.status === 'conflict' ? '待核对' : '未补齐'}</h3>
    <p className="muted">{evidence.reason}</p>
    <div className="detail-list">
      <div><span>申请编号</span><strong>{evidence.reqNo}</strong></div>
      <div><span>查询接口</span><strong>{evidence.path}</strong></div>
      {evidence.creditCode && <div><span>办件信用代码 · {evidence.field}</span><strong>{evidence.creditCode}</strong></div>}
      {evidence.transportName && <div><span>办件企业名称</span><strong>{evidence.transportName}</strong></div>}
    </div>
    <p className="muted">经办人不是法人，不用于回填法人。以上为回流时依据，手工修改后的字段需另行核对。</p>
  </section>;
}
