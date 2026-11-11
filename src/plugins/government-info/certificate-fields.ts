/** Neutral certificate fields: these are not a double-publicity permit mapping. */
export const CERTIFICATE_FIELDS = [
  { key: 'certificateName', label: '证件名称', source: 'zjmc' },
  { key: 'certificateNumber', label: '证件编号', source: 'zjbh' },
  { key: 'certificateIssuedDate', label: '制证日期', source: 'zzsj' },
  { key: 'certificateValidFrom', label: '证件有效期起', source: 'zjyxqstart' },
  { key: 'certificateValidTo', label: '证件有效期止', source: 'zjyxqend' },
] as const;

export type CertificateFieldKey = typeof CERTIFICATE_FIELDS[number]['key'];
type MissingReason = 'not-returned' | 'empty' | 'masked' | 'invalid-type' | 'unavailable';
export interface CertificateFieldEvidence {
  state: 'detail' | 'existing' | 'local' | 'missing';
  method?: 'WfGetRunningData';
  path?: string;
  reason?: MissingReason;
}
export interface CertificateEnrichment {
  version: 1;
  status: 'partial' | 'empty' | 'failed';
  fields: Record<CertificateFieldKey, CertificateFieldEvidence>;
}

export function certificateValueIssue(value: unknown): MissingReason | undefined {
  if (value === undefined) return 'not-returned';
  if (value === null) return 'empty';
  if (typeof value !== 'string') return 'invalid-type';
  if (!value.trim() || /^(?:null|undefined|--?|—|暂无)$/i.test(value.trim())) return 'empty';
  if (/[*＊●•]/.test(value)) return 'masked';
  return undefined;
}

export function supplementCertificateFields(
  input: Record<string, unknown>,
  primary: Record<string, unknown>,
  failed = false,
): Record<string, unknown> {
  const record: Record<string, unknown> = { ...input, fillStatus: '0' };
  const fields = {} as CertificateEnrichment['fields'];
  for (const { key, source } of CERTIFICATE_FIELDS) {
    if (!certificateValueIssue(input[key])) {
      fields[key] = { state: 'existing' };
      continue;
    }
    const issue = failed ? 'unavailable' : certificateValueIssue(primary[source]);
    if (issue) {
      fields[key] = { state: 'missing', reason: issue };
    } else {
      record[key] = (primary[source] as string).trim();
      fields[key] = { state: 'detail', method: 'WfGetRunningData', path: `recordBean.primaryBean.${source}` };
    }
  }
  const status = failed ? 'failed' : CERTIFICATE_FIELDS.some(({ key }) => !certificateValueIssue(record[key])) ? 'partial' : 'empty';
  return { ...record, certificateEnrichment: { version: 1, status, fields } satisfies CertificateEnrichment };
}

export function readCertificateEnrichment(value: unknown): CertificateEnrichment | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const metadata = value as CertificateEnrichment;
  if (metadata.version !== 1 || !['partial', 'empty', 'failed'].includes(metadata.status) || !metadata.fields) return undefined;
  if (!CERTIFICATE_FIELDS.every(({ key }) => metadata.fields[key]
    && ['detail', 'existing', 'local', 'missing'].includes(metadata.fields[key].state))) return undefined;
  return metadata;
}

/** Opted into by five matters only. A transient detail failure must not erase local certificates. */
export function mergeCertificateRecord(incoming: Record<string, unknown>, previous: Record<string, unknown>): Record<string, unknown> {
  if (incoming.cityLsh !== previous.cityLsh || incoming.sxmc !== previous.sxmc
    || (previous.sblsh && incoming.sblsh !== previous.sblsh)) return incoming;
  const evidence = readCertificateEnrichment(incoming.certificateEnrichment);
  const result = { ...incoming };
  const fields = evidence ? { ...evidence.fields } : undefined;
  for (const { key } of CERTIFICATE_FIELDS) {
    if (certificateValueIssue(previous[key])) continue;
    result[key] = previous[key];
    if (fields) fields[key] = { state: 'local' };
  }
  if (evidence && fields) {
    result.certificateEnrichment = {
      ...evidence, fields,
      status: evidence.status === 'failed' ? 'failed'
        : CERTIFICATE_FIELDS.some(({ key }) => !certificateValueIssue(result[key])) ? 'partial' : 'empty',
    } satisfies CertificateEnrichment;
  }
  return { ...result, fillStatus: '0' };
}

export const CERTIFICATE_STATUS_LABELS = {
  partial: '部分补充（非完整双公示）', empty: '未取到可用证照字段', failed: '详情补充失败（基础数据保留）',
} as const;
const REASON_LABELS: Record<MissingReason, string> = {
  'not-returned': '接口未返回字段', empty: '接口值为空或占位文本', masked: '接口值脱敏，未采用',
  'invalid-type': '接口类型未验证，未采用', unavailable: '详情未成功读取或身份核验失败',
};
export function certificateEvidenceText(evidence: CertificateFieldEvidence): string {
  if (evidence.state === 'detail') return `WfGetRunningData → ${evidence.path}；仅去首尾空白`;
  if (evidence.state === 'local') return '保留本地已有值；本次未覆盖，不表示本次接口核验';
  if (evidence.state === 'existing') return '保留传入记录的已有值；本次未覆盖';
  return REASON_LABELS[evidence.reason ?? 'unavailable'] ?? '来源待核验';
}
