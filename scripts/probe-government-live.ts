/** Temporary developer-only, stdin-controlled, read-only diagnostic harness.
 * Never imported by production code. No listening port, raw records or credential output.
 * Launch instead of the normal Electron main after closing the existing instance.
 */
import { app, session, safeStorage } from 'electron';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { createProbe, GOVERNMENT_MATTERS } from './probe-government-comparison';
import { selectEcsSid } from '../src/plugins/government-info/session-credentials';
import { parseApprovalWorkbook } from '../src/plugins/government-info/query';

const project = resolve(__dirname, '..');
const profile = join(app.getPath('appData'), 'data-fusion-desktop');
app.setName('data-fusion-desktop');
app.setPath('userData', profile);
// Load the actual built application; do not replace its session/authorization behavior.
require(join(project, 'out/main/index.js'));
const samples = new Map<string, Record<string, any>[]>();
const details = new Map<string, Record<string, any>[]>();
const reportPath = join(project, '.tmp/government-probe-results.jsonl');
const emit = (value: unknown) => {
  const line = JSON.stringify(value);
  process.stdout.write(`PROBE ${line}\n`);
  void appendFile(reportPath, `${line}\n`, 'utf8');
};
const present = (value: unknown) => value !== null && value !== undefined && String(value).trim() !== '';

async function probe() {
  await app.whenReady();
  const browserSession = session.fromPartition('persist:government-info');
  const stored = JSON.parse(await readFile(join(profile, 'sessions.secure.json'), 'utf8'));
  const encoded = stored.values?.['government-info.lid'];
  if (!encoded || !safeStorage.isEncryptionAvailable()) throw new Error('SESSION_UNAVAILABLE');
  const lid = safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  const cookies = await browserSession.cookies.get({ name: 'LSID', domain: '10.200.96.11' });
  const sid = selectEcsSid(cookies.map(cookie => cookie.value));
  if (!lid || !sid) throw new Error('SESSION_UNAVAILABLE');
  return createProbe({ lid, sid }, undefined, (url, init) => browserSession.fetch(url, init));
}

const mapping: Record<string, string> = {
  cityLsh: 'sblsh_short', sblsh: 'sblsh', sxmc: 'sxmc', applyer: 'sqrmc', cardNumber: 'sqrzjhm',
  receiveType: 'lqfs', applyDate: 'sbsj', creater: 'creator', processResult: 'slzt', area: 'sys_areaid',
  department: 'zgbm', currentLink: 'stepname', approveDate: 'bj_bjsj', fdApproveDate: 'fdbjsj',
};

async function command(input: { action: string; matterId?: string; startDate?: string; page?: number }) {
  const api = await probe();
  const matter = GOVERNMENT_MATTERS.find(item => item.id === (input.matterId ?? 'drainage-permit-new'));
  if (!matter) throw new Error('UNKNOWN_MATTER');
  const start = input.startDate ?? '2026-01-01';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('INVALID_DATE');
  const query = api.buildQuery(matter.name, start, 3);
  if (input.action === 'search') {
    query.pageNum = Math.min(5, Math.max(1, Number(input.page) || 1));
    const result = await api.search(query);
    const rows: Record<string, any>[] = Array.isArray(result.result) ? result.result : [];
    samples.set(matter.id, rows);
    emit({ action: 'search', matter: matter.name, topKeys: Object.keys(result), total: result.total ?? result.totalCount ?? result.recordCount,
      rows: rows.length, fieldNames: Object.keys(rows[0] ?? {}), dates: rows.map(row => ({ apply: row.sbsj, approved: row.bj_bjsj })),
      allExactMatter: rows.every(row => row.sxmc === matter.name), requests: api.requests });
  } else if (input.action === 'compare') {
    const row = samples.get(matter.id)?.[0];
    if (!row?.id) throw new Error('SEARCH_FIRST');
    query.parameters.push({ name: 'id', value: row.id, flag: 11 });
    const direct = await api.search(query);
    const selected = direct.result?.find((item: Record<string, any>) => item.id === row.id);
    if (!selected) throw new Error('SAMPLE_NOT_FOUND');
    const bytes = await api.export(query);
    const records = await parseApprovalWorkbook(bytes);
    const exported = records.find(item => item.cityLsh === row.sblsh_short && item.sblsh === row.sblsh);
    if (!exported) throw new Error('EXPORTED_SAMPLE_NOT_FOUND');
    emit({ action: 'compare', matter: matter.name, exportedRows: records.length,
      fields: Object.entries(mapping).map(([column, field]) => ({ column, field, exists: field in selected,
        queryFilled: present(selected[field]), exportFilled: present(exported[column]),
        exactEqual: String(selected[field] ?? '') === String(exported[column] ?? ''),
        queryType: typeof selected[field], exportType: typeof exported[column],
        queryMasked: /\*/.test(String(selected[field] ?? '')), exportMasked: /\*/.test(String(exported[column] ?? '')),
      })), queryFieldCount: Object.keys(selected).length, requests: api.requests });
  } else if (input.action === 'details') {
    const rows = samples.get(matter.id);
    if (!rows?.length) throw new Error('SEARCH_FIRST');
    const inspected: Record<string, any>[] = [];
    for (const row of rows.slice(0, 2)) {
      if (!row.wf_entry_id) continue;
      const result = await api.running(row.wf_entry_id);
      inspected.push(result);
    }
    details.set(matter.id, inspected);
    emit({ action: 'details', matter: matter.name, samples: inspected.map(result => {
      const primary = result.recordBean?.primaryBean ?? {};
      return { topKeys: Object.keys(result), primaryFieldNames: Object.keys(primary),
        primaryNonemptyFields: Object.keys(primary).filter(key => present(primary[key])),
        extraForms: (result.exRecords ?? []).map((form: Record<string, any>) => Object.fromEntries(
          Object.entries(form).filter(([key]) => /^(name|tablename|modulename|module|formname|pagename|caption|title|cnname)$/.test(key)))),
        extraFormKeys: Object.keys(result.exRecords?.[0] ?? {}), opinionGroups: result.opinions?.length ?? 0,
      };
    }), requests: api.requests });
  } else throw new Error('UNKNOWN_ACTION');
}

let queued = Promise.resolve();
const enqueue = (line: string) => {
  queued = queued.then(() => command(JSON.parse(line))).catch(error => {
    emit({ action: 'failed', errorType: error?.name ?? 'Error', code: error?.code ?? 'PROBE_FAILED',
      reason: /^(SESSION_UNAVAILABLE|UNKNOWN_MATTER|INVALID_DATE|SEARCH_FIRST|SAMPLE_NOT_FOUND|EXPORTED_SAMPLE_NOT_FOUND|UNKNOWN_ACTION)$/.test(error?.message ?? '') ? error.message : undefined });
  });
};
const input = createInterface({ input: process.stdin });
input.on('line', enqueue);
// Windows GUI processes do not consistently receive inherited stdin. This local,
// temporary control file accepts only the same bounded read-only commands.
let lastControl = '';
const poll = setInterval(() => {
  void readFile(join(project, '.tmp/government-probe-control.json'), 'utf8').then(line => {
    if (line === lastControl) return;
    lastControl = line;
    enqueue(line);
  }).catch(() => {});
}, 750);
app.on('before-quit', () => clearInterval(poll));
void app.whenReady().then(() => emit({ action: 'ready', mode: 'read-only', businessWrites: false }));
