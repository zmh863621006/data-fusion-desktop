import { AppError } from '../../core/errors/app-error';
import { decryptEcsResponse, encryptEcsRequest } from './codec';
import { buildExportParameters } from './export-request';

export const GOVERNMENT_INFO_BASE_URL = 'http://10.200.96.11';
export const GOVERNMENT_INFO_INDEX_URL = `${GOVERNMENT_INFO_BASE_URL}/ECS/LEAP/Login/440305/ECS2/Index.html`;
export const GOVERNMENT_INFO_RPC_URL = `${GOVERNMENT_INFO_BASE_URL}/ECS/LEAP/Service/RPC/RPC.DO`;

export interface GovernmentInfoCredentials {
  sid: string;
  lid: string;
}

export type GovernmentInfoFetch = (url: string, init: RequestInit) => Promise<Response>;

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function throwHttpError(response: Response, operation: string): Promise<never> {
  const details = { status: response.status, retryable: retryableStatus(response.status) };
  if (response.status === 401 || response.status === 403) {
    throw new AppError('SESSION_EXPIRED', `政务综合信息平台会话已失效（${response.status}）`, details);
  }
  throw new AppError('REMOTE_REQUEST_FAILED', `政务综合信息平台${operation}失败（${response.status}）`, details);
}

export function buildRpcHeaders(
  credentials: GovernmentInfoCredentials,
  method: string,
  parameterCount: number,
  dataType: '14' | '16',
): Record<string, string> {
  return {
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Data-Type': dataType,
    LID: credentials.lid,
    QS: `method=${method}&sid=${credentials.sid}&parlen=${parameterCount}`,
    'Post-Type': '1',
    Pragma: 'no-cache',
    RESPTYPE: '1',
    lrqvt: '1',
    Origin: GOVERNMENT_INFO_BASE_URL,
    Referer: `${GOVERNMENT_INFO_BASE_URL}/ECS/LEAP/Resource/JavaScript/Base/networker.js`,
  };
}

export function normalizeDownloadPath(response: string): string {
  let value: unknown = response.trim();
  try {
    value = JSON.parse(String(value));
  } catch {
    // The export service normally returns the path as plain text.
  }
  if (value && typeof value === 'object' && 'result' in value) {
    value = (value as { result?: unknown }).result;
  }
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== 'string') {
    throw new AppError('REMOTE_REQUEST_FAILED', '政务综合信息平台未返回导出文件地址', { retryable: false });
  }
  const path = value.trim().replace(/^['"]|['"]$/g, '').replace(/^\/+/, '');
  if (!path || path.includes('..') || path.includes('\\') || !/\.xlsx(?:$|\?)/i.test(path)) {
    throw new AppError('REMOTE_REQUEST_FAILED', '政务综合信息平台返回了不安全的导出文件地址', { retryable: false });
  }
  return path;
}

export async function requestApprovalExportPath(
  fetcher: GovernmentInfoFetch,
  credentials: GovernmentInfoCredentials,
  startDate: string,
  endDate?: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetcher(GOVERNMENT_INFO_RPC_URL, {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: buildRpcHeaders(credentials, 'laam_exportApprovalData', 4, '16'),
    body: encryptEcsRequest(buildExportParameters(startDate, endDate)),
  });
  if (!response.ok) await throwHttpError(response, '导出请求');
  const payload = await response.text();
  if (!payload.trim()) throw new AppError('REMOTE_REQUEST_FAILED', '政务综合信息平台导出接口返回空响应，请检查查询条件及原系统状态', {
    status: response.status, reason: 'EMPTY_EXPORT_RESPONSE', retryable: false,
  });
  let decoded: string;
  try { decoded = decryptEcsResponse(payload); }
  catch {
    throw new AppError('REMOTE_REQUEST_FAILED', '政务综合信息平台导出响应格式无效', {
      status: response.status, reason: 'INVALID_EXPORT_RESPONSE', retryable: false,
    });
  }
  return normalizeDownloadPath(decoded);
}

export async function downloadApprovalWorkbook(
  fetcher: GovernmentInfoFetch,
  credentials: GovernmentInfoCredentials,
  exportPath: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const url = new URL(`/ECS/LEAP/Download/excelReport/${exportPath}`, GOVERNMENT_INFO_BASE_URL);
  const response = await fetcher(url.toString(), {
    method: 'GET',
    credentials: 'include',
    signal,
    headers: {
      Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Cache-Control': 'no-cache',
      Origin: GOVERNMENT_INFO_BASE_URL,
      Pragma: 'no-cache',
      Referer: `${GOVERNMENT_INFO_INDEX_URL}?lid=${encodeURIComponent(credentials.lid)}`,
    },
  });
  if (!response.ok) await throwHttpError(response, '文件下载');
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length < 4 || data.subarray(0, 2).toString('hex') !== '504b') {
    throw new AppError(
      'REMOTE_REQUEST_FAILED',
      '政务综合信息平台返回的文件不是有效的 XLSX 文件',
      { retryable: false },
    );
  }
  return data;
}
