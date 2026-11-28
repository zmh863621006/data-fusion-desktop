import { AppError } from '../../core/errors/app-error';
import type { QueryContext, QueryPage } from '../../core/query/types';
import { normalizeCreditCode } from '../../core/enterprise/credit-code';

const AUTHORITY_NAME = '惠州市交通运输局';
const AUTHORITY_CODE = '114413000071877877';
const text = (row: Record<string, unknown>, key: string): string => String(row[key] ?? '').trim();

export function mapOnlineCarPermit(row: Record<string, unknown>): Record<string, unknown> {
  const companyName = text(row, 'companyName');
  const companyId = text(row, 'companyId');
  const creditCode = normalizeCreditCode(companyId);
  // The source uses companyId for both an identity document and a credit code.
  // A verified credit code takes precedence over the name (centres and sole traders
  // need not contain “公司”). Retain the source value for existing named businesses.
  const personalIdentity = /^(?:\d{15}|\d{17}[\dXx])$/.test(companyId) && !creditCode;
  const organization = Boolean(creditCode) || (!personalIdentity && /(公司|企业|集团|厂|店|中心|合作社|事务所|经营部|车行)/.test(companyName));
  const category = creditCode.startsWith('92') ? '个体工商户' : organization ? '法人及非法人组织' : '自然人';
  return {
    xzxkmc: '网络预约出租汽车运输证许可', xkXdrMc: companyName,
    xkXdrLb: category,
    xkXdrShxym: organization ? creditCode || companyId : '', xkXdrGszc: '', xkXdrZzjg: '', xkXdrSwdj: '', xkXdrSydw: '', xkXdrShzz: '',
    xkFrdb: '', xkFrZjlx: '', xkFrZjhm: '',
    xkXdrZjlx: organization ? '' : (/^\d/.test(companyId) ? '身份证' : '港澳台通行证'),
    xkXdrZjhm: organization ? '' : companyId,
    xkXkws: '网络预约出租车运输证许可', xkWsh: text(row, 'certificate'), xkXklb: '普通',
    xkXkzs: '网络预约出租车运输证', xkXkbh: '', xkNr: '网络预约出租汽车运输证许可',
    xkJdrq: text(row, 'createTime'), xkYxqz: text(row, 'cardbegindate'), xkYxqzi: text(row, 'cardenddate'),
    xkXkjg: AUTHORITY_NAME, xkXkjgdm: AUTHORITY_CODE, xkZt: '1', xkLydw: AUTHORITY_NAME, xkLydwdm: AUTHORITY_CODE,
    xkSxjbbm: '', xkSxssbm: '', bz: '',
  };
}

export interface OnlineCarPermitTransport {
  fetchRecords(startDate: string, endDate: string, signal?: AbortSignal): Promise<Record<string, unknown>[]>;
}

export async function queryOnlineCarPermits(transport: OnlineCarPermitTransport, context: QueryContext): Promise<QueryPage<Record<string, unknown>>> {
  const startDate = String(context.filters.startDate ?? '').trim();
  const endDate = String(context.filters.endDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new AppError('QUERY_INVALID', '网约车车证回流需要有效的开始和结束日期');
  if (startDate > endDate) throw new AppError('QUERY_INVALID', '开始日期不能晚于结束日期');
  const rows = (await transport.fetchRecords(startDate, endDate, context.signal)).map(mapOnlineCarPermit);
  return { rows, page: 1, pageSize: Math.max(rows.length, 1), total: rows.length };
}
