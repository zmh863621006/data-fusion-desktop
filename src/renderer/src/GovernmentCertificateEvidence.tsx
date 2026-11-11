import {
  CERTIFICATE_FIELDS, CERTIFICATE_STATUS_LABELS, certificateEvidenceText, readCertificateEnrichment,
} from '../../plugins/government-info/certificate-fields';

export function GovernmentCertificateEvidence({ data, editing }: { data: Record<string, unknown>; editing: boolean }) {
  const evidence = readCertificateEnrichment(data.certificateEnrichment);
  if (!evidence) return null;
  return <section>
    <h3 className="drawer-section-title">证照补充依据 · {CERTIFICATE_STATUS_LABELS[evidence.status]}</h3>
    <p className="muted">仅补证照字段，不代表完整双公示或当前证照有效。制证日期不等于许可决定日期。</p>
    <div className="detail-list">{CERTIFICATE_FIELDS.map(({ key, label }) => <div key={key}>
      <span>{label}</span><strong>{certificateEvidenceText(evidence.fields[key])}</strong>
    </div>)}</div>
    <p className="muted">{editing ? '手工修改不会改写回流来源说明。' : ''}以上为回流时的取值依据，手工修改后的值需另行核对。</p>
  </section>;
}
