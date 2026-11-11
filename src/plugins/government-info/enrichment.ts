import type { ParsedApprovalDocument, GovernmentReturnRecord, RunningPrimaryBean } from './field-rules';
import { GOVERNMENT_MATTER_BY_NAME } from './matter-catalog';
import { supplementCertificateFields } from './certificate-fields';
import {
  applyFixedDrainagePermitContent, calculateFillStatus, enrichConstructionWaste, enrichDrainagePermit, enrichGreenSpaceOccupation,
  enrichSoilWaterConservation, enrichTreeFellingRelocation, enrichWaterTableDocument,
} from './field-rules';

export interface GovernmentDetailTransport {
  searchEntry(cityLsh: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  getRunningData(wfEntryId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  searchByPrimaryKey(recordId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  getDocument(primary: Record<string, unknown>, signal?: AbortSignal): Promise<ParsedApprovalDocument>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`详情响应缺少 ${label}`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`详情响应缺少 ${label}`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`详情响应缺少 ${label}`);
  return value;
}

function primaryFromRunning(running: Record<string, unknown>): Record<string, unknown> {
  return object(object(running.recordBean, 'recordBean').primaryBean, 'primaryBean');
}

function runningDates(primary: Record<string, unknown>): RunningPrimaryBean {
  return {
    zjbh: typeof primary.zjbh === 'string' ? primary.zjbh : undefined,
    zzsj: typeof primary.zzsj === 'string' ? primary.zzsj : undefined,
    zjyxqstart: typeof primary.zjyxqstart === 'string' ? primary.zjyxqstart : undefined,
    zjyxqend: typeof primary.zjyxqend === 'string' ? primary.zjyxqend : undefined,
  };
}

function secondOpinion(running: Record<string, unknown>): string {
  const groups = array(running.opinions, 'opinions').map((group) => object(group, 'opinion group'));
  groups.sort((left, right) => opinionTime(left) - opinionTime(right));
  const selected = object(array(groups[1]?.opinions, 'opinions[1].opinions')[0], 'opinion');
  return string(selected.opinioncontent, 'opinioncontent');
}

function opinionTime(group: Record<string, unknown>): number {
  const opinion = object(array(group.opinions, 'group.opinions')[0], 'opinion');
  const time = object(opinion.opiniontime, 'opiniontime').time;
  return typeof time === 'number' ? time : Number(time) || 0;
}

const DRAINAGE = new Set([
  '污水排入排水管网许可证核发（新办）',
  '污水排入排水管网许可证核发（变更或延续）',
]);
const WATER_TABLE = new Set([
  '河道管理范围内建设项目工程建设方案审批',
  '迁移、移动城镇排水与污水处理设施方案审核',
]);
const SOIL = new Set([
  '生产建设项目水土保持方案审批（企业投资类）',
  '生产建设项目水土保持方案审批（政府投资、非盈利组织投资和个人投资类）',
]);

function matchesApproval(candidate: Record<string, unknown>, record: GovernmentReturnRecord): boolean {
  return candidate.sblsh_short === record.cityLsh && candidate.sxmc === record.sxmc
    && (!record.sblsh || candidate.sblsh === record.sblsh);
}

async function enrichCertificateRecord(
  transport: GovernmentDetailTransport, record: GovernmentReturnRecord, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const entry = await transport.searchEntry(record.cityLsh, signal);
  const matches = array(entry.result, 'result').filter((candidate) => candidate
    && typeof candidate === 'object' && !Array.isArray(candidate)
    && matchesApproval(candidate as Record<string, unknown>, record)) as Record<string, unknown>[];
  // ecs_searchAll uses LIKE and can return several similar numbers. Never select its first row blindly.
  if (matches.length !== 1) throw new Error('证照详情查询未唯一匹配双流水号及事项');
  const wfEntryId = string(matches[0].wf_entry_id, 'wf_entry_id');
  const primary = primaryFromRunning(await transport.getRunningData(wfEntryId, signal));
  if (!matchesApproval(primary, record) || primary.wf_entry_id !== wfEntryId) {
    throw new Error('证照详情主表与当前记录身份不一致');
  }
  return supplementCertificateFields(record, primary);
}

export async function enrichGovernmentRecord(
  transport: GovernmentDetailTransport,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const record = input as GovernmentReturnRecord;
  const matter = GOVERNMENT_MATTER_BY_NAME.get(record.sxmc);
  if (matter?.supportsCertificateEnrichment && matter.sxType === String(record.sxType)) {
    return [await enrichCertificateRecord(transport, record, signal)];
  }
  if (!['1', '13'].includes(String(record.sxType ?? ''))) return [{ ...record, fillStatus: calculateFillStatus(record) }];
  const entry = await transport.searchEntry(record.cityLsh, signal);
  const wfEntryId = string(object(array(entry.result, 'result')[0], 'result[0]').wf_entry_id, 'wf_entry_id');
  const running = await transport.getRunningData(wfEntryId, signal);
  const primary = primaryFromRunning(running);
  const dates = runningDates(primary);
  let enriched: GovernmentReturnRecord[];
  if (DRAINAGE.has(record.sxmc)) {
    const recordId = string(object(array(running.exRecords, 'exRecords')[0], 'exRecords[0]').recordid, 'recordid');
    const pk = await transport.searchByPrimaryKey(recordId, signal);
    const enterpriseName = string(array(array(pk.result, 'result')[0], 'result[0]')[5], 'SearchByPK result[0][5]');
    enriched = [enrichDrainagePermit(record, dates, enterpriseName)];
  } else if (record.sxmc === '城市建筑垃圾处置（排放）核准') {
    enriched = [enrichConstructionWaste(record, dates, await transport.getDocument(primary, signal))];
  } else if (WATER_TABLE.has(record.sxmc)) {
    enriched = [enrichWaterTableDocument(record, dates, await transport.getDocument(primary, signal))];
  } else if (SOIL.has(record.sxmc)) {
    enriched = [enrichSoilWaterConservation(record, dates, await transport.getDocument(primary, signal))];
  } else if (record.sxmc === '因工程建设确需改装、拆除或者迁移城市公共供水设施审批') {
    enriched = [enrichWaterTableDocument(record, dates, await transport.getDocument(primary, signal), true)];
  } else if (record.sxmc === '占用城市绿地审批') {
    enriched = [enrichGreenSpaceOccupation(record, dates, secondOpinion(running))];
  } else if (record.sxmc === '砍伐、迁移城市树木') {
    enriched = enrichTreeFellingRelocation(record, dates, secondOpinion(running));
  } else enriched = [record];
  return enriched.map((item) => ({ ...item, fillStatus: calculateFillStatus(item) }));
}

export function toDoublePublicityRecord(input: Record<string, unknown>): Record<string, unknown> {
  const record = applyFixedDrainagePermitContent(input);
  const sxType = String(record.sxType ?? '');
  if (sxType !== '1' && sxType !== '13') return record;
  const water = sxType === '1';
  let documentName = water ? '深圳市南山区水务局行政许可决定书' : '深圳市(区)城市管理和综合执法局行政许可决定书';
  if (record.sxmc === '污水排入排水管网许可证核发（新办）') documentName = '城镇污水排入排水管网许可证';
  if (record.sxmc === '城市建筑垃圾处置（排放）核准') documentName = '深圳市建筑废弃物排放核准证';
  const authority = water ? '深圳市南山区水务局' : '深圳市南山区城市管理和综合执法局';
  const authorityCode = water ? '11440305MB2D27962K' : '11440305K3172391X8';
  return {
    ...record,
    xzxkmc: record.sxmc, xkXdrMc: record.qymc, xkXdrLb: record.qylx,
    xkXdrShxym: record.xydm, xkFrdb: record.frdb, xkXkws: documentName,
    xkWsh: record.xkbh, xkXklb: water ? '普通' : '其他', xkXkzs: documentName,
    xkXkbh: record.xkbh, xkNr: record.xknr, xkJdrq: record.xkjdrq,
    xkYxqz: record.yxqs, xkYxqzi: record.yxqe, xkZt: '1',
    xkXkjg: authority, xkXkjgdm: authorityCode, xkLydw: authority, xkLydwdm: authorityCode,
    ajmc: record.ajmc, xkCljg: '予以许可', xkZqly: '依职权',
  };
}
