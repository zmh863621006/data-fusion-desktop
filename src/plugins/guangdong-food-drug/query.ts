import { AppError } from '../../core/errors/app-error';
import { HUIZHOU_MARKET_AUTHORITY, huizhouMarketAuthority } from '../../core/double-publicity/huizhou-market-authority';
import type { QueryContext, QueryPage } from '../../core/query/types';
import type { FoodDrugLicense } from './catalog';
import { foodDrugFailure, foodDrugText, type FoodDrugClient, type FoodDrugRow } from './client';

const PAGE_SIZE = 50;
const MAX_ROWS = 50_000;

function asDate(value: unknown): string {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/.exec(foodDrugText(value));
  if (!match) return '';
  const date = match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
  const time = Date.parse(date);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? date : '';
}

function permitRow(matter: FoodDrugLicense, id: string, list: FoodDrugRow, acceptance: FoodDrugRow, certificate: FoodDrugRow) {
  const authority = HUIZHOU_MARKET_AUTHORITY;
  const source = huizhouMarketAuthority(foodDrugText(acceptance.SLQJ_DETAIL)) ?? authority;
  const businessName = foodDrugText(list.BUSINESS_NAME);
  return {
    sourceRecordId: id,
    xzxkmc: businessName, xkNr: businessName,
    xkXdrLb: '法人及非法人组织', xkXklb: '普通', xkZt: '1',
    xkXdrMc: foodDrugText(acceptance.QYMC), xkXdrShxym: foodDrugText(acceptance.SHXYDM),
    xkFrdb: foodDrugText(acceptance.FDDBR), xkFrZjlx: foodDrugText(acceptance.ZJLX_DETAIL), xkFrZjhm: foodDrugText(acceptance.ZJHM),
    xkXkws: foodDrugText(acceptance.BUSINESS_NAME), xkWsh: foodDrugText(acceptance.SLH),
    xkXkzs: foodDrugText(acceptance.ITEM_NAME), xkXkbh: foodDrugText(certificate.XKZBH),
    xkJdrq: asDate(list.LCJSSJ), xkYxqz: asDate(certificate.FZRQ), xkYxqzi: asDate(certificate[matter.expiry]),
    xkXkjg: authority.name, xkXkjgdm: authority.code, xkLydw: source.name, xkLydwdm: source.code,
  };
}

export async function queryFoodDrug(client: Pick<FoodDrugClient, 'list' | 'acceptance' | 'certificate'>,
  matter: FoodDrugLicense, context: QueryContext): Promise<QueryPage> {
  const { filters, signal, onProgress } = context;
  const start = asDate(filters.startDate), end = asDate(filters.endDate);
  if (!start || !end || start !== filters.startDate || end !== filters.endDate || start > end) {
    throw new AppError('QUERY_INVALID', '请选择有效的办结日期范围');
  }

  let expected: number | undefined;
  const applications = new Map<string, FoodDrugRow>();
  for (let page = 1; ; page++) {
    signal?.throwIfAborted();
    const result = await client.list(matter, start, end, page, PAGE_SIZE, signal);
    if (result.total > MAX_ROWS) throw foodDrugFailure('食药监办件超过 50000 条，请缩小办结日期范围');
    if (expected !== undefined && expected !== result.total) throw foodDrugFailure('食药监办件总数发生变化，请重新回流');
    expected = result.total;
    for (const entry of result.rows) {
      const id = foodDrugText(entry.ID);
      if (!id || id.length > 160 || applications.has(id)) throw foodDrugFailure('食药监办件缺少唯一标识或分页重复，请在原系统核对');
      applications.set(id, entry);
    }
    const count = applications.size;
    onProgress?.({ current: 0, total: expected, message: `已查询 ${count} 条办件` });
    if (count === expected) break;
    if (count > expected || !result.rows.length) throw foodDrugFailure('食药监办件分页数量不一致，请重新回流');
  }

  const rows = [];
  let processed = 0, undatedExcludedCount = 0;
  for (const [id, entry] of applications) {
    signal?.throwIfAborted();
    const completed = asDate(entry.LCJSSJ);
    if (!completed) undatedExcludedCount++;
    else if (completed >= start && completed <= end) {
      const acceptance = await client.acceptance(matter, id, signal);
      const certificate = await client.certificate(matter, id, signal);
      rows.push(permitRow(matter, id, entry, acceptance, certificate));
    }
    onProgress?.({ current: ++processed, total: expected, message: `已回流 ${rows.length} 条办件` });
  }
  return { rows, total: rows.length, page: 1, pageSize: context.pageSize, undatedExcludedCount };
}
