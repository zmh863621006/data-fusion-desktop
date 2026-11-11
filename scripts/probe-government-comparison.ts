// Read-only diagnostic helpers. Credentials and raw records remain in caller memory.
import { buildRpcHeaders, GOVERNMENT_INFO_BASE_URL, GOVERNMENT_INFO_RPC_URL, normalizeDownloadPath, downloadApprovalWorkbook, type GovernmentInfoCredentials, type GovernmentInfoFetch } from '../src/plugins/government-info/approval-export';
import { buildExportParameters } from '../src/plugins/government-info/export-request';
import { encryptEcsRequest, decryptEcsResponse } from '../src/plugins/government-info/codec';
import { getRunningApprovalData } from '../src/plugins/government-info/approval-detail';
export { GOVERNMENT_MATTERS } from '../src/plugins/government-info/matter-catalog';
export function createProbe(credentials: GovernmentInfoCredentials, rpcUrl = GOVERNMENT_INFO_RPC_URL, sessionFetch?: GovernmentInfoFetch) {
  const requests: { method: string; status: number; elapsedMs: number }[] = [];
  const fetcher: GovernmentInfoFetch = async (url, init) => {
    if (new URL(url).origin !== GOVERNMENT_INFO_BASE_URL) throw new Error('Unexpected origin');
    const headers = new Headers(init.headers);
    if (!sessionFetch) headers.set('Cookie', `LSID=${credentials.sid}`);
    const started = Date.now();
    const response = await (sessionFetch ?? fetch)(url, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
    requests.push({ method: new URLSearchParams(headers.get('QS') ?? '').get('method') ?? 'download', status: response.status, elapsedMs: Date.now() - started });
    return response;
  };
  async function rpc(method: string, args: string[]) {
    if (!['ecs_searchAll', 'laam_exportApprovalData'].includes(method)) throw new Error('Diagnostic RPC not allowed');
    const response = await fetcher(rpcUrl, { method: 'POST', headers: buildRpcHeaders(credentials, method, args.length, '16'), body: encryptEcsRequest(JSON.stringify(args)) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return decryptEcsResponse(await response.text());
  }
  function buildQuery(matter: string, startDate = '2026-01-01', pageSize = 2) {
    const query = JSON.parse(JSON.parse(buildExportParameters(startDate))[0]);
    delete query.fields;
    delete query.toCount;
    query.parameters.push({ name: 'sxmc', value: matter, flag: 12 });
    query.pageSize = pageSize;
    query.pageModule = 'ecs_queryAll';
    query.codetypes = [{ name: 'ismptg', code: 'laam_mp' }, { name: 'slzt', code: 'laamslztcode' }, { name: 'lqfs', code: 'laam_lqfs' }];
    return query;
  }
  return {
    requests, buildQuery,
    search: async (query: unknown) => JSON.parse(await rpc('ecs_searchAll', [JSON.stringify(query)])),
    running: (wfEntryId: string) => getRunningApprovalData(fetcher, credentials, wfEntryId),
    export: async (query: Record<string, unknown>) => {
      const args: string[] = JSON.parse(buildExportParameters('2026-01-01'));
      const original = JSON.parse(args[0]);
      args[0] = JSON.stringify({ ...query, fields: original.fields, pageNum: 1, pageSize: -9999, toCount: false });
      const path = normalizeDownloadPath(await rpc('laam_exportApprovalData', args));
      return downloadApprovalWorkbook(fetcher, credentials, path);
    },
  };
}
