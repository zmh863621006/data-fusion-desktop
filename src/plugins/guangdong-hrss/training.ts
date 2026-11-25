import { createCipheriv } from 'node:crypto';
import { load } from 'cheerio';
import { AppError } from '../../core/errors/app-error';
import { validateHrssDateFilters } from '../../core/hrss/date-filters';
import type { HrssHandlingRecord } from '../../core/hrss/handling-records';
import type { HrssListSource } from './catalog';

export { HRSS_TRAINING_PROFILE } from './training-catalog';

export interface HrssTrainingSession { organizationId: string; whereKey: string; csrfToken: string }
export interface HrssTrainingClient {
  requestTrainingList(params: Record<string, unknown>, signal?: AbortSignal): Promise<{ rows: Record<string, unknown>[]; total: number }>;
}
const LIST_CONFIGS: Readonly<Record<string, string>> = {
  'training-progress': 'jycyzjgl_cypxbt_cxjd_bljdcxjglb',
  'training-completed': 'jycyzjgl_cypxbt_cxjd_bjywcxjglb',
};
export const HRSS_TRAINING_HANDLING_CONFIG = 'jycyzjgl_cypxbt_cxjd_jbjlgshwzjzhd';
const PAGE_SIZE = 200;
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new AppError('TASK_CANCELLED', '回流任务已取消'); };
const invalid = (message: string) => new AppError('QUERY_INVALID', message);
const failed = (message: string) => new AppError('REMOTE_REQUEST_FAILED', `${message}，未保存本次结果`, { retryable: false });
const scalar = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
function text(value: unknown): string {
  const valueText = scalar(value);
  if (!/[<&]/.test(valueText)) return valueText;
  const document = load(valueText, null, false);
  document('script,style').remove();
  return document.root().text().trim();
}
function sourceConfig(source: HrssListSource): string {
  const config = LIST_CONFIGS[source.id];
  if (!config || source.path !== '/ZXZJ/gltPage.do' || source.method !== 'POST') throw invalid('创业培训列表来源无效');
  return config;
}

/** Compatible with source stringToHex(encrypt(WHEREKEY, condition)); never evaluates source code. */
export function encodeTrainingCondition(whereKey: string, condition: string): string {
  if (!/^[\x21-\x7e]{1,128}$/.test(whereKey)) throw invalid('创业培训查询会话缺少有效的条件密钥');
  if (!condition) return '';
  // The original key schedule appends "hnisi", then selects one or three 8-byte keys.
  const sourceKey = Buffer.from(`${whereKey}hnisi`, 'latin1');
  const key = Buffer.alloc(24);
  if (sourceKey.length >= 24) sourceKey.copy(key, 0, 0, 24);
  else {
    const single = Buffer.alloc(8); sourceKey.copy(single, 0, 0, 8);
    for (let i = 0; i < 3; i++) single.copy(key, i * 8);
  }
  // Source packs four JavaScript UTF-16 code units per DES block and NUL-pads the tail.
  const input = Buffer.alloc(Math.ceil(condition.length / 4) * 8);
  for (let i = 0; i < condition.length; i++) input.writeUInt16BE(condition.charCodeAt(i), i * 2);
  const cipher = createCipheriv('des-ede3', key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  // stringToHex serializes decimal character codes separated by ':', then hex-encodes that ASCII.
  return Buffer.from([...encrypted].join(':'), 'ascii').toString('hex');
}

export function buildTrainingCondition(source: HrssListSource, start: string, end: string, context: HrssTrainingSession): string {
  sourceConfig(source);
  validateHrssDateFilters({ startDate: start, endDate: end });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(context.organizationId)) throw invalid('创业培训会话缺少有效的经办机构');
  const organization = context.organizationId;
  // Exact source fngetFzxWhere('t.BAE001', BAE001), preserving original scope and active-case guard.
  const scope = ` exists(Select 1 From FW_SYSORG b where b.BAE001 = t.BAE001 and instr(b.ORGPARENT,',${organization},')>0)`;
  const base = source.id === 'training-progress'
    ? `1=1 and t.BZE382 = 'BT_CYPXBT'and ((t.BHEA81='BT_SL' and (instr(t.BZD411,',${organization},')>0  or t.BZD411 is null)) or (t.BHEA81 in ('BT_SP','BT_SH') and ${scope} )) and (cdb043 <> '04' or cdb043 is null)`
    : ` CDD006=11 and ${scope} and (cdb043 <> '04' or cdb043 is null)`;
  return `${base} and BCE089 >= '${start}' and BCE089 <= '${end}'`;
}

function gridParameters(config: string, page: number, condition: string, session: HrssTrainingSession): Record<string, unknown> {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) throw invalid('创业培训分页参数无效');
  return { confid: config, dynDictWhereCls: 'null', dsId: '', rowstart: (page - 1) * PAGE_SIZE + 1, pageSize: PAGE_SIZE,
    dataService: '', whereCls: encodeTrainingCondition(session.whereKey, condition), whereJsonSTR: '""', whereJson: '', queryService: '' };
}

export function buildTrainingListParameters(source: HrssListSource, page: number, start: string, end: string, context: HrssTrainingSession): Record<string, unknown> {
  return gridParameters(sourceConfig(source), page, buildTrainingCondition(source, start, end, context), context);
}

interface TrainingIdentity { caseId: string; stage: string; pending: boolean }
function trainingIdentity(source: HrssListSource, raw: Record<string, unknown>): TrainingIdentity {
  sourceConfig(source);
  const ids = new Set<string>();
  const directId = scalar(raw.CDB041);
  if (directId) ids.add(directId);
  let stage = '', checkboxStage = '';
  // The progress grid declares lower-case xz; the completed grid returns upper-case XZ.
  const inputDoc = load(scalar(raw.XZ)||scalar(raw.xz), null, false), inputs = inputDoc('input');
  if (inputs.length > 1) throw failed('创业培训列表包含无法识别的选择字段');
  if (inputs.length === 1) {
    const value = inputs.first().attr('value') ?? '';
    const match = value.match(/^([A-Za-z0-9_-]{1,128})\|([A-Za-z0-9_-]{1,64})$/);
    if (!match) throw failed('创业培训列表缺少可用的业务关联编号');
    ids.add(match[1]); checkboxStage = match[2];
  }
  const unitDoc = load(scalar(raw.AAB004), null, false);
  const link = unitDoc('a[onclick]').first();
  if (link.length) {
    // Only recognize the fixed source handler. No eval, navigation or form submission.
    const match = (link.attr('onclick') ?? '').match(/^\s*(?:return\s+)?dw_view\(\s*(['"])([A-Za-z0-9_-]{1,128})\1\s*,\s*(['"])(10|20)\3\s*,\s*(['"])([A-Za-z0-9_-]{0,32})\5\s*\)\s*;?\s*$/);
    if (!match || match[4] !== (source.id === 'training-progress' ? '10' : '20')) throw failed('创业培训单位链接不符合原列表格式');
    ids.add(match[2]);
  }
  if (ids.size !== 1) throw failed('创业培训列表的业务关联编号缺失或不一致');
  const caseId = [...ids][0];
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(caseId)) throw failed('创业培训列表缺少可用的业务关联编号');
  if (source.id === 'training-progress') {
    const directStage = scalar(raw.BHEA81);
    const codes:Record<string,string>={BT_SL:'BT_SL','待受理':'BT_SL',BT_SH:'BT_SH','待审核':'BT_SH','审核':'BT_SH',BT_SP:'BT_SP','待审批':'BT_SP','审批':'BT_SP'};
    const checkboxCode=codes[checkboxStage],directCode=codes[directStage];
    if(checkboxCode && directCode && checkboxCode!==directCode)throw failed('创业培训列表的办理状态不一致');
    if((checkboxStage&&!checkboxCode)||(directStage.startsWith('BT_')&&!directCode))throw failed('创业培训列表包含无法核验的办理状态');
    stage = checkboxCode || directCode || '';
    // Source progress scope contains SL/SH/SP only; its receipt branch permits SH/SP as accepted.
    if (stage === 'BT_SL' || stage === '待受理') return { caseId, stage: '待受理', pending: true };
    if (stage === 'BT_SH' || stage === '待审核' || stage === '审核') stage = '待审核';
    else if (stage === 'BT_SP' || stage === '待审批' || stage === '审批') stage = '待审批';
    else throw failed('创业培训列表包含无法核验的办理状态');
  } else stage = '已办结';
  return { caseId, stage, pending: false };
}

/** Converts only verified visible list fields; embedded checkboxes/handlers never enter storage. */
export function projectTrainingListRecord(source: HrssListSource, raw: Record<string, unknown>): Record<string, unknown> {
  const identity = trainingIdentity(source, raw);
  return {
    caseId: identity.caseId, unitName: text(raw.AAB004), applyBh: text(raw.CCD002), applyDate: text(raw.BCE089),
    applyAddress: text(raw.XZQH), currentLink: identity.stage, completedDate: text(raw.BJRQ), completedResult: text(raw.BJJG),
    payDate: text(raw.BCEA8W), payStatus: text(raw.BCEA8K), recoveryStatus: text(raw.BCCA4S),
  };
}

export async function enrichTrainingRecord(client: HrssTrainingClient, source: HrssListSource, raw: Record<string, unknown>, session: HrssTrainingSession, signal?: AbortSignal): Promise<{ handlingRecordCount: number; handlingRecordStatus: 'collected' | 'skipped-pending'; handlingRecords: HrssHandlingRecord[] }> {
  cancelled(signal);
  const identity = trainingIdentity(source, raw);
  if (identity.pending) return { handlingRecordCount: 0, handlingRecordStatus: 'skipped-pending', handlingRecords: [] };
  // Original query-page detail config uses BZE453='1' for its handling-record list.
  const condition = ` CDB041 = '${identity.caseId}' and BZE453='1' `;
  const records: HrssHandlingRecord[] = [], keys = new Set<string>();
  let expected: number | undefined;
  const maxRecords = 10_000;
  for (let page = 1; page <= maxRecords / PAGE_SIZE; page++) {
    cancelled(signal);
    const response = await client.requestTrainingList(gridParameters(HRSS_TRAINING_HANDLING_CONFIG, page, condition, session), signal);
    cancelled(signal);
    if (!Number.isSafeInteger(response.total) || response.total < 0 || response.total > maxRecords || !Array.isArray(response.rows)) throw failed('创业培训办理记录总数无效或超出保护限制');
    expected ??= response.total;
    if (response.total !== expected) throw failed('回流期间创业培训办理记录总数发生变化');
    if (response.rows.length !== Math.min(PAGE_SIZE, expected - records.length)) throw failed('创业培训办理记录分页条数与总数不一致');
    for (const row of response.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw failed('创业培训办理记录包含无法识别的数据');
      const rowNumber = scalar(row.RN) || scalar(row.ROWNUM_);
      if (!/^[1-9]\d*$/.test(rowNumber)) throw failed('创业培训办理记录缺少可核验的行号');
      if (keys.has(rowNumber)) throw failed('创业培训办理记录包含重复分页或重复行号');
      keys.add(rowNumber);
      records.push({ step: text(row._DIC_CDB042), result: text(row.BFE086), opinion: text(row.CFE006), operator: text(row.JBR),
        handledAt: text(row.JBRQ), organization: text(row.JBJG), action: '' });
    }
    if (records.length === expected) return { handlingRecordCount: records.length, handlingRecordStatus: 'collected', handlingRecords: records };
  }
  throw failed('创业培训办理记录尚未获取完整');
}
