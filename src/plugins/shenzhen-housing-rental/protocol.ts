import { AppError } from '../../core/errors/app-error';
import { decryptEcsResponse, encryptEcs14Request, encryptEcsRequest } from '../government-info/codec';
import { HOUSING_HOME_URL, HOUSING_ORIGIN } from './catalog';

export type HousingRow = Record<string, unknown>;
export interface HousingSearchParameter { name: string; value: string | number; flag: number }
export const housingFailure = (message: string) => new AppError('REMOTE_REQUEST_FAILED', message, { retryable: false });
export const housingExpired = () => new AppError('SESSION_EXPIRED', '房屋租赁会话已失效，请在原系统重新登录');
export const housingText = (value: unknown) => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
export const housingObject = (value: unknown): value is HousingRow => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function housingIdentifier(value: unknown): string {
  const text = housingText(value);
  if (!/^[a-z\d][a-z\d._/-]{0,127}$/i.test(text)) throw housingFailure('原系统关联编号格式无法识别');
  return text;
}

export function housingInput(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) throw new AppError('QUERY_INVALID', `请填写有效的${label}`);
  return text;
}

export function housingArea(value: unknown): string {
  const text = housingText(value);
  if (!/^\d{18}$/.test(text)) throw housingFailure('原系统管理机构范围无法识别');
  return text;
}

/** Match the original manager's city/district/street scope, without widening it to find a house. */
export function housingAreaPrefix(area: string): string {
  housingArea(area);
  return area.slice(4, 6) === '00' ? area.slice(0, 4) : area.slice(6, 9) === '000' ? area.slice(0, 6) : area.slice(0, 9);
}

export function housingSearch(name: string, parameters: HousingSearchParameter[], pageSize = 2) {
  return { name, parameters, pageNum: 1, pageSize };
}

export function housingRpcRequest(sid: string, method: string, parameters: string[], type: '14' | '16' = '16'): RequestInit {
  return {
    method: 'POST', credentials: 'include', redirect: 'manual',
    headers: {
      Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded', 'Data-Type': type,
      'LSYS-AREA': '4403', 'LSYS-NAME': 'ZIB', 'Post-Type': '1', RESPTYPE: '1', lrqvt: '3',
      Origin: HOUSING_ORIGIN, Referer: HOUSING_HOME_URL,
      QS: `method=${method}&sid=${sid}&parlen=${parameters.length}`,
    },
    body: (type === '14' ? encryptEcs14Request : encryptEcsRequest)(JSON.stringify(parameters)),
  };
}

export function parseHousingRpc(text: string, allowEmpty: boolean): unknown {
  if (!text.trim()) {
    if (allowEmpty) return null;
    throw housingFailure('房屋租赁系统未返回可确认的处理结果');
  }
  if (/^\s*(?:<!doctype|<html|<script|<form|<input)/i.test(text)) throw housingExpired();
  let value: unknown;
  try { value = JSON.parse(decryptEcsResponse(text)); }
  catch { throw housingFailure('房屋租赁系统响应无法解析'); }
  if (housingObject(value) && (value.error || value._error || value.exception || value.fault)) {
    const error = String(value.error ?? value._error ?? value.exception ?? value.fault);
    if (/登录|会话|session|login|sid.*(?:invalid|expired)/i.test(error)) throw housingExpired();
    throw housingFailure('房屋租赁系统返回业务错误');
  }
  return value;
}

export function housingRows(value: unknown): { rows: HousingRow[]; total: number } {
  if (value === null) return { rows: [], total: 0 };
  if (!housingObject(value) || !Array.isArray(value.result) || !Number.isSafeInteger(value.count)
    || Number(value.count) < value.result.length || Number(value.count) < 0) throw housingFailure('房屋租赁查询结果结构不完整');
  const metadata = value.metaData;
  const names = Array.isArray(metadata) && metadata.every(field => housingObject(field) && typeof field.name === 'string')
    ? metadata.map(field => String((field as HousingRow).name)) : undefined;
  if (names && new Set(names).size !== names.length) throw housingFailure('房屋租赁查询字段重复');
  const rows = value.result.map(row => {
    if (housingObject(row)) return row;
    if (!Array.isArray(row) || !names || row.length !== names.length) throw housingFailure('房屋租赁查询字段无法对应');
    return Object.fromEntries(names.map((name, index) => [name, row[index]]));
  });
  if (!rows.length && Number(value.count) > 0) throw housingFailure('房屋租赁查询未返回完整数据');
  return { rows, total: Number(value.count) };
}
