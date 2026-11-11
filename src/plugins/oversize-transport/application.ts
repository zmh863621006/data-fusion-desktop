import { AppError } from '../../core/errors/app-error';
import { normalizeCreditCode } from '../../core/enterprise/credit-code';
import { OVERSIZE_APPLICATION_PATH, type OversizeApplication } from './client';

export interface OversizeApplicationSource {
  fetchApplicationRecords(reqNo: string, signal?: AbortSignal): Promise<OversizeApplication[]>;
}
export interface OversizeApplicationEvidence {
  status: 'matched' | 'missing' | 'invalid' | 'conflict' | 'error';
  reason: string; reqNo: string; path: string; checkedAt: number;
  applicationId?: string; transportName?: string; creditCode?: string;
  field?: 'transportCreditCode';
}
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const nameKey = (value: unknown) => text(value).replace(/\s/g, '').replace(/（/g, '(').replace(/）/g, ')');
export function readOversizeApplicationEvidence(value: unknown): OversizeApplicationEvidence | undefined {
  if (!value || typeof value !== 'object') return;
  const entry = value as OversizeApplicationEvidence;
  if (['matched','missing','invalid','conflict','error'].includes(entry.status) && typeof entry.reason === 'string'
    && typeof entry.reqNo === 'string' && typeof entry.path === 'string' && typeof entry.checkedAt === 'number') return entry;
}

/** Query only an already-selected certificate. Never use the first fuzzy search result as its identity. */
export async function supplementOversizeApplication(source: OversizeApplicationSource, row: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const reqNo = text(row.xkWsh);
  if (signal?.aborted) throw new AppError('TASK_CANCELLED', '任务已取消');
  const base = { reqNo, path: OVERSIZE_APPLICATION_PATH, checkedAt: Date.now() };
  const finish = (status: OversizeApplicationEvidence['status'], reason: string, extra: Partial<OversizeApplicationEvidence> = {}, fields: Record<string, unknown> = {}) => ({
    ...row, ...fields, oversizeApplicationEnrichment: { ...base, ...extra, status, reason } satisfies OversizeApplicationEvidence,
  });
  let records: OversizeApplication[];
  try { records = await source.fetchApplicationRecords(reqNo, signal); }
  catch (error) {
    if (signal?.aborted) throw new AppError('TASK_CANCELLED', '任务已取消');
    if (error instanceof AppError && (['SESSION_EXPIRED','SYSTEM_LOGIN_REQUIRED','TASK_CANCELLED'].includes(error.code) || error.details?.sessionChanged)) throw error;
    if (error instanceof AppError && error.details?.identityConflict) return finish('conflict', '办件标识缺失或重复，已暂停自动企业补全，请人工核对');
    // No upstream error text, response, token or personal information is retained.
    return finish('error', '办件查询暂不可用，保留证件字段；缺少有效代码时按名称补全');
  }
  if (signal?.aborted) throw new AppError('TASK_CANCELLED', '任务已取消');
  const exact = records.filter(item => item.reqNo === reqNo);
  if (!exact.length) return finish('missing', '没有找到申请编号完全一致的办件，未使用其他编号的数据');
  if (exact.length !== 1) return finish('conflict', '同一申请编号匹配到多个办件，已暂停自动企业补全，请人工核对');
  const application = exact[0];
  const evidence = { applicationId: application.id, transportName: application.transportName };
  if (text(row.xkXdrMc) && application.transportName && nameKey(row.xkXdrMc) !== nameKey(application.transportName)) {
    return finish('conflict', '证件企业名称与办件企业名称不一致，已暂停自动企业补全，请人工核对', evidence);
  }
  const sourceCode = normalizeCreditCode(application.transportCreditCode), existingCode = normalizeCreditCode(row.xkXdrShxym);
  if (sourceCode && existingCode && sourceCode !== existingCode) {
    return finish('conflict', '证件/已有信用代码与办件信用代码冲突，保留原值并暂停自动企业补全', { ...evidence, creditCode: sourceCode, field: 'transportCreditCode' });
  }
  if (!sourceCode) return finish(application.transportCreditCode ? 'invalid' : 'missing', application.transportCreditCode
    ? '办件信用代码未通过格式及校验位检查，未回填该代码' : '该办件未提供统一社会信用代码', evidence);
  const fields: Record<string, unknown> = { xkXdrShxym: existingCode || sourceCode, xkXdrLb: sourceCode.startsWith('92') ? '个体工商户' : '法人及非法人组织' };
  if (!text(row.xkXdrMc) && application.transportName) fields.xkXdrMc = application.transportName;
  return finish('matched', '申请编号完全匹配，信用代码取自原系统办件 transportCreditCode；法人另由企业库补充',
    { ...evidence, creditCode: sourceCode, field: 'transportCreditCode' }, fields);
}
