import { AppError } from '../../core/errors/app-error';
import type { QueryContext, QueryPage } from '../../core/query/types';
import { normalizeCreditCode } from '../../core/enterprise/credit-code';
import { HAZCHEM_AUTHORITY, HAZCHEM_AUTHORITY_CODE, type HazardousMatter } from './catalog';
import type { HazardousTransport } from './client';

type Row = Record<string, unknown>;
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const failure = (message: string) => new AppError('REMOTE_REQUEST_FAILED', message, { retryable: false });
const cancelled = (context: QueryContext) => { if (context.signal?.aborted) throw new AppError('TASK_CANCELLED', '回流任务已取消'); };
function date(value: unknown): string {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/.exec(text(value));
  if (!m) return '';
  const result = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(result + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === result ? result : '';
}
function certificateFields(certificate?: Row): Row {
  if (!certificate || typeof certificate.dataFields !== 'string') return {};
  try { const value: unknown = JSON.parse(certificate.dataFields); return object(value) && object(value.data_fields) ? value.data_fields : {}; } catch { return {}; }
}
function equivalent(rows: Row[]): Row | undefined {
  const key = (row: Row) => JSON.stringify(Object.keys(row).filter(k => k !== 'number').sort().map(k => [k, row[k]]));
  const unique = new Map(rows.map(row => [key(row), row]));
  if (unique.size > 1) throw failure('同一流水号存在多份内容不一致的制证导出数据，请在原系统核对后重试');
  return unique.values().next().value;
}

/** Select explicit report fields; operator identities, tokens and PDF URLs never enter the local ledger. */
export function mapHazardousRecord(matter: HazardousMatter, done: Row, report: Row | undefined, certificates: Row[]): Row {
  const serial = text(done.sblshShort);
  const warnings: string[] = [];
  const candidates = certificates.filter(row => text(row.bizNum) === serial
    && (!report || !text(row.companyName) || text(row.companyName) === text(report.administrativeName)));
  let certificate: Row | undefined;
  if (candidates.length === 1) certificate = candidates[0];
  else if (candidates.length > 1) {
    const structures = new Set(candidates.map(row => JSON.stringify(certificateFields(row))));
    if (structures.size === 1) certificate = candidates[0];
    else warnings.push('同流水号关联多份照面，未选用不一致的照面补充字段');
  }
  const fields = certificateFields(certificate);
  const source = report ?? {};
  const cancellation = matter.id === 'hazchem-business-cancel';
  const filing = matter.id === 'hazchem-precursor-filing';
  const sourceCode = text(source.unifiedSocialCreditCode) || text(certificate?.socialCredit) || text(fields.CYRSFZJHM);
  const credit = normalizeCreditCode(sourceCode);
  const companyName = text(source.administrativeName) || text(certificate?.companyName) || text(done.zzjgmc);
  const certificateName = text(source.licenseName) || text(fields.ZZMC);
  if (!report) warnings.push('流程已结束，但尚未关联到制证数据导出记录，缺失字段需核对');
  if (sourceCode && !credit) warnings.push('原始企业代码不是有效的18位统一社会信用代码，需企业库补充或人工核对');
  if (cancellation) warnings.push('注销事项的许可内容、处理结果及当前状态待核对，未套用普通许可结果');
  if (filing) warnings.push('备案事项的许可类别及处理结果待核对，未套用普通许可结果');
  const legalPerson = text(source.legalRepresentative);
  const legalNumber = legalPerson ? text(source.legalRepresentativeNumber) : '';
  const notification = /通知书|决定书/.test(certificateName);
  return {
    sourceSerial: serial, sourceMatterCode: text(done.sxbmShort) || matter.sourceCode,
    xzxkmc: matter.name, xkXdrMc: companyName, xkXdrLb: '法人及非法人组织',
    xkXdrShxym: credit, xkXdrGszc: '', xkXdrZzjg: '', xkXdrSwdj: '', xkXdrSydw: '', xkXdrShzz: '',
    xkFrdb: legalPerson, xkFrZjlx: legalNumber ? text(source.legalRepresentativeType) : '', xkFrZjhm: legalNumber,
    xkXdrZjlx: '', xkXdrZjhm: '', ajmc: text(source.caseName),
    xkXkws: notification ? certificateName : '', xkWsh: notification ? text(source.licenseNumber) || text(fields.ZZHM) : '',
    xkXklb: cancellation || filing ? '' : '普通', xkXkzs: certificateName,
    xkXkbh: notification ? '' : text(source.licenseNumber) || text(fields.ZZHM),
    xkNr: text(source.licenseContent) || (!cancellation && !filing ? text(fields.XKFW) : ''),
    xkJdrq: date(source.permissionDecisionDate), xkYxqz: date(source.startTime), xkYxqzi: date(source.endTime),
    xkXkjg: HAZCHEM_AUTHORITY, xkXkjgdm: HAZCHEM_AUTHORITY_CODE,
    xkLydw: HAZCHEM_AUTHORITY, xkLydwdm: HAZCHEM_AUTHORITY_CODE,
    xkZqly: '依职权', xkCljg: cancellation || filing ? '' : text(source.result), xkZt: cancellation || filing ? '' : '1',
    bz: warnings.join('；'),
    hazardousEvidence: {
      sourceStatus: text(done.lczt), sourceSubmittedAt: text(done.time), sourceReceivedAt: text(done.sjsj),
      reportMatched: !!report, certificateMatches: candidates.length, certificateIssuedDate: text(fields.FZRQ),
      originalCreditCode: sourceCode, originalResult: text(source.result), warnings,
    },
  };
}

export async function queryHazardous(transport: HazardousTransport, matter: HazardousMatter, context: QueryContext): Promise<QueryPage<Row>> {
  const requestedStart = text(context.filters.startDate), requestedEnd = text(context.filters.endDate);
  const start = date(requestedStart), end = date(requestedEnd);
  if ((requestedStart || requestedEnd) && (!start || !end || start > end)) throw new AppError('QUERY_INVALID', '请填写完整有效的许可决定日期范围，开始日期不能晚于结束日期');
  cancelled(context);
  const done = await transport.done(matter, context.signal);
  const completed = new Map<string, Row>();
  for (const row of done) {
    if (text(row.lczt) !== '流程结束') continue;
    if (text(row.sxbmShort) !== matter.sourceCode && text(row.sxmc) !== matter.name) continue;
    const serial = text(row.sblshShort);
    if (!serial) throw failure('流程结束记录缺少流水号，未保存本次数据');
    completed.set(serial, row);
  }
  if (!completed.size) return { rows: [], page: 1, pageSize: 1, total: 0 };
  const reports = await transport.report(context.signal);
  const bySerial = new Map<string, Row[]>();
  for (const report of reports) {
    const serial = text(report.sblshShort);
    if (!completed.has(serial)) continue;
    if (text(report.serviceItemName) && text(report.serviceItemName) !== matter.name && text(report.serviceItemCode) !== matter.sourceCode) continue;
    const group = bySerial.get(serial) ?? []; group.push(report); bySerial.set(serial, group);
  }
  const output: Row[] = [];
  let undatedExcludedCount = 0;
  for (const [serial, row] of completed) {
    cancelled(context);
    const group = bySerial.get(serial) ?? [], report = equivalent(group);
    const decision = date(report?.permissionDecisionDate);
    if (start) {
      if (!decision) { undatedExcludedCount++; continue; }
      if (decision < start || decision > end) continue;
    }
    context.onProgress?.({ current: output.length, total: completed.size, message: '正在按流水号关联危化品制证数据' });
    const certificates = await transport.certificates(serial, context.signal);
    output.push(mapHazardousRecord(matter, row, report, certificates));
  }
  cancelled(context);
  return { rows: output, page: 1, pageSize: Math.max(1, output.length), total: output.length,
    ...(undatedExcludedCount > 0 ? { undatedExcludedCount } : {}) };
}
