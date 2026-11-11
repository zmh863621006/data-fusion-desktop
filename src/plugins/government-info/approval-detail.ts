import { AppError } from '../../core/errors/app-error';
import { buildRpcHeaders, GOVERNMENT_INFO_BASE_URL, GOVERNMENT_INFO_INDEX_URL, GOVERNMENT_INFO_RPC_URL, type GovernmentInfoCredentials, type GovernmentInfoFetch } from './approval-export';
import { decryptEcsResponse, encryptEcs14Request, encryptEcsRequest } from './codec';
import { buildExportParameters } from './export-request';

function parseRpcJson(payload: string, operation: string): Record<string, unknown> {
  if (!payload.trim()) {
    throw new AppError('REMOTE_REQUEST_FAILED', `政务综合信息平台${operation}响应为空`, { reason: 'EMPTY_RESPONSE' });
  }
  try {
    const parsed: unknown = JSON.parse(decryptEcsResponse(payload));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('unexpected result');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new AppError('REMOTE_REQUEST_FAILED', `政务综合信息平台${operation}响应无法解析`, { retryable: false, reason: 'INVALID_RPC_RESPONSE' });
  }
}

async function rpc(
  fetcher: GovernmentInfoFetch,
  credentials: GovernmentInfoCredentials,
  method: string,
  parameters: string,
  parameterCount: number,
  dataType: '14' | '16',
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const headers = buildRpcHeaders(credentials, method, parameterCount, dataType);
  if (dataType === '14') {
    headers.lrqvt = '3';
    headers['Lsys-Area'] = '440305';
    headers['Lsys-Name'] = 'ECS2';
    headers.Referer = `${GOVERNMENT_INFO_INDEX_URL}?lid=${encodeURIComponent(credentials.lid)}`;
  }
  const response = await fetcher(GOVERNMENT_INFO_RPC_URL, {
    method: 'POST', credentials: 'include', signal, headers,
    body: dataType === '14' ? encryptEcs14Request(parameters) : encryptEcsRequest(parameters),
  });
  if (!response.ok) {
    const expired = response.status === 401 || response.status === 403;
    throw new AppError(expired ? 'SESSION_EXPIRED' : 'REMOTE_REQUEST_FAILED', `政务综合信息平台${method}请求失败（${response.status}）`, {
      status: response.status, retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    });
  }
  return parseRpcJson(await response.text(), method);
}

export function buildEntrySearchParameters(cityLsh: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(cityLsh)) {
    throw new AppError('QUERY_INVALID', '市流水号格式不正确');
  }
  const query = {
    parameters: [{ name: 'sbsj', value: '2025-01-15', flag: 16 }],
    extendQuery: ` 1=1  and (((sys_areaid>='440305000000000000' and sys_areaid<='440305999999999999' and (steptype=0 or (steptype=1 and stepname='结束')) )  and ((sbversion is not null and tjfs in ('0','1','2','3')) or signaturephoto is not null or fromareaid='101')) or (sbzt=8 and creator<>'2017补数据' and length(sblsh)<30)) and (sblsh like '%${cityLsh}%' or sblsh_short like '%${cityLsh}%')`,
    order: 'sbsj desc',
    desFields: [{ field: 'sqrmc', begin: 1, size: 1 }, { field: 'sqrzjhm', begin: 4, size: 10 }],
    pageModule: 'ecs_queryAll', pageNum: 1, pageSize: 8, name: 'laam_ex_sb', getCodeValue: true,
    codetypes: [{ name: 'ismptg', code: 'laam_mp' }, { name: 'slzt', code: 'laamslztcode' }, { name: 'lqfs', code: 'laam_lqfs' }],
    isgis: false, javaClass: 'com.longrise.LEAP.BLL.Cache.SearchBuilder',
  };
  return JSON.stringify([JSON.stringify(query)]);
}

export const searchApprovalEntry = (fetcher: GovernmentInfoFetch, credentials: GovernmentInfoCredentials, cityLsh: string, signal?: AbortSignal) => (
  rpc(fetcher, credentials, 'ecs_searchAll', buildEntrySearchParameters(cityLsh), 1, '16', signal)
);

/** The live service returns an empty body for the deliberately unmatched search.
 * Use the established list query, limited to one row; never export or fetch details.
 * Business records stay in memory and are discarded by the session validator.
 */
export function buildSessionCheckParameters(): string {
  const query = JSON.parse(JSON.parse(buildExportParameters('2025-01-15'))[0]);
  // Keep the previously verified login probe independent of business date filtering.
  query.parameters = [{ name: 'sbsj', value: '2025-01-15', flag: 16 }];
  delete query.fields;
  delete query.toCount;
  query.pageModule = 'ecs_queryAll';
  query.pageNum = 1;
  query.pageSize = 1;
  return JSON.stringify([JSON.stringify(query)]);
}

export const checkGovernmentSession = (fetcher: GovernmentInfoFetch, credentials: GovernmentInfoCredentials, signal?: AbortSignal) => (
  rpc(fetcher, credentials, 'ecs_searchAll', buildSessionCheckParameters(), 1, '16', signal)
);

export const getRunningApprovalData = (fetcher: GovernmentInfoFetch, credentials: GovernmentInfoCredentials, wfEntryId: string, signal?: AbortSignal) => (
  rpc(fetcher, credentials, 'WfGetRunningData', JSON.stringify([wfEntryId, null, null, null]), 4, '14', signal)
);

export const searchApprovalByPrimaryKey = (fetcher: GovernmentInfoFetch, credentials: GovernmentInfoCredentials, recordId: string, signal?: AbortSignal) => (
  rpc(fetcher, credentials, 'SearchByPK', JSON.stringify(['ecs_hscspsxkz', recordId]), 2, '14', signal)
);

export function buildAttachmentUrl(fileInfo: { nameedPath: string; name: string }): string {
  const folderParts = fileInfo.nameedPath.split('/');
  if (!fileInfo.name || /[\\/]/.test(fileInfo.name)
    || [fileInfo.name, ...folderParts].some((part) => !part || part === '.' || part === '..' || /[\\\u0000-\u001f]/.test(part))) {
    throw new AppError('REMOTE_REQUEST_FAILED', '附件路径格式不正确', { retryable: false });
  }
  // Source Java uses name.split("\\.")[0], including names containing several dots.
  const stem = fileInfo.name.split('.')[0];
  const path = [fileInfo.nameedPath, stem, '_v3_', fileInfo.name].map((part) => encodeURIComponent(part).replace(/%2F/gi, '/')).join('/');
  return `${GOVERNMENT_INFO_BASE_URL}/ECS/LEAP/Download/${path}`;
}

export async function downloadApprovalAttachment(fetcher: GovernmentInfoFetch, url: string, signal?: AbortSignal): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.origin !== GOVERNMENT_INFO_BASE_URL || !parsed.pathname.startsWith('/ECS/LEAP/Download/')) {
    throw new AppError('REMOTE_REQUEST_FAILED', '政务综合信息平台附件地址不安全', { retryable: false });
  }
  const response = await fetcher(url, { method: 'GET', credentials: 'include', signal, redirect: 'error' });
  if (!response.ok) throw new AppError(
    response.status === 401 || response.status === 403 ? 'SESSION_EXPIRED' : 'REMOTE_REQUEST_FAILED',
    `政务综合信息平台附件下载失败（${response.status}）`,
    { status: response.status, retryable: response.status === 408 || response.status === 429 || response.status >= 500 },
  );
  return Buffer.from(await response.arrayBuffer());
}
