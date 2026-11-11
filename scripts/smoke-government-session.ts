import { createInterface } from 'node:readline';
import { downloadApprovalWorkbook, requestApprovalExportPath, GOVERNMENT_INFO_BASE_URL, type GovernmentInfoCredentials, type GovernmentInfoFetch } from '../src/plugins/government-info/approval-export';
import { parseApprovalWorkbook } from '../src/plugins/government-info/query';
import { decryptEcsResponse } from '../src/plugins/government-info/codec';
import { searchApprovalEntry, getRunningApprovalData, searchApprovalByPrimaryKey } from '../src/plugins/government-info/approval-detail';

// Credentials are supplied as one JSON line on stdin, never as CLI arguments or files.
// Uses the same RPC encoding/decoding and workbook parser as the app. No local data writes.
async function run() {
  const lines = createInterface({ input: process.stdin });
  const line = await new Promise<string>(resolve => { lines.once('line', resolve); });
  lines.close();
  const input = JSON.parse(line) as GovernmentInfoCredentials & { startDate?: string; endDate?: string; detailSample?: boolean };
  const credentials = { sid: input.sid?.trim(), lid: input.lid?.trim() };
  if (!credentials.sid || !credentials.lid) throw new Error('Missing session credentials');
  const startDate = input.startDate ?? new Date().toLocaleDateString('en-CA');
  const endDate = input.endDate ?? startDate;
  if (![startDate, endDate].every(value => /^\d{4}-\d{2}-\d{2}$/.test(value)) || startDate > endDate) throw new Error('Invalid date');
  const fetcher: GovernmentInfoFetch = async (url, init) => {
    if (new URL(url).origin !== GOVERNMENT_INFO_BASE_URL) throw new Error('Unexpected origin');
    const headers = new Headers(init.headers);
    headers.set('Cookie', `LSID=${credentials.sid}`);
    const started = Date.now();
    const method = new URLSearchParams(headers.get('QS') ?? '').get('method');
    const response = await fetch(url, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(45000) });
    const detail: Record<string, unknown> = { method: method ?? 'download', status: response.status, elapsedMs: Date.now() - started, contentType: response.headers.get('content-type') };
    if (method) {
      const raw = await response.clone().text();
      detail.responseLength = raw.length;
      try { decryptEcsResponse(raw); detail.decoded = true; } catch { detail.decoded = false; }
    }
    console.log(JSON.stringify(detail));
    return response;
  };
  console.log(JSON.stringify({ phase: 'start', startDate, endDate, dateField: 'bj_bjsj', scope: 'export-read-only' }));
  const path = await requestApprovalExportPath(fetcher, credentials, startDate, endDate);
  const workbook = await downloadApprovalWorkbook(fetcher, credentials, path);
  const records = await parseApprovalWorkbook(workbook);
  const departments: Record<string, number> = {};
  for (const record of records) { const name = String(record.departmentName ?? '其他'); departments[name] = (departments[name] ?? 0) + 1; }
  console.log(JSON.stringify({ phase: 'complete', workbookBytes: workbook.length, matchedMatterRows: records.length, departments }));
  if (input.detailSample) {
    const sample = records.find(record => String(record.sxmc).includes('污水排入排水管网'))
      ?? records.find(record => ['1', '13'].includes(String(record.sxType)));
    if (!sample) { console.log(JSON.stringify({ phase: 'detail-skipped', reason: 'no-water-or-urban-sample' })); return; }
    const entry = await searchApprovalEntry(fetcher, credentials, String(sample.cityLsh));
    const results = entry.result as Array<{ wf_entry_id?: string }> | undefined;
    if (!results?.[0]?.wf_entry_id) throw new Error('Detail sample has no workflow ID');
    const running = await getRunningApprovalData(fetcher, credentials, results[0].wf_entry_id);
    const record = running.recordBean as { primaryBean?: unknown } | undefined;
    if (!record?.primaryBean) throw new Error('Detail sample has no primary record');
    const extra = running.exRecords as Array<{ recordid?: string }> | undefined;
    let primaryKeyChecked = false;
    if (String(sample.sxmc).includes('污水排入排水管网') && extra?.[0]?.recordid) {
      const pk = await searchApprovalByPrimaryKey(fetcher, credentials, extra[0].recordid);
      if (!Array.isArray(pk.result) || !pk.result.length) throw new Error('Detail primary key result is empty');
      primaryKeyChecked = true;
    }
    console.log(JSON.stringify({ phase: 'detail-complete', workflowChecked: true, primaryRecordChecked: true, primaryKeyChecked }));
  }
}
void run().catch(error => {
  // Do not echo input, cookies, raw response bodies, export paths, or business records.
  console.error(JSON.stringify({ phase: 'failed', errorType: error?.name ?? 'Error', errorCode: error?.code ?? 'REQUEST_FAILED' }));
  process.exitCode = 1;
});
