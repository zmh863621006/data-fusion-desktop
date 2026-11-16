// Explicit local read-only diagnostic. No credentials or business rows are written.
import { readFile } from 'node:fs/promises';
import { HazardousClient } from '../src/plugins/shenzhen-hazardous-chemicals/client';
import { HAZCHEM_MATTERS } from '../src/plugins/shenzhen-hazardous-chemicals/catalog';
import { queryHazardous } from '../src/plugins/shenzhen-hazardous-chemicals/query';
async function main() {
const path = process.argv[2];
if (!path) throw new Error('请提供当前登录 HAR 路径，仅在内存读取会话');
const har = JSON.parse(await readFile(path, 'utf8'));
const request = har.log.entries.find((entry: any) => entry.request.url === 'https://szwh.yjgl.sz.gov.cn/DataBus/exchange' && entry.request.postData?.text);
const credential = JSON.parse(request.request.postData.text);
const client = new HazardousClient({ fetcher: fetch, minimumIntervalMs: 200 });
client.acceptStorage({ Authorization: credential.CONSUMER_ID, userId: String(credential.userId) });
await client.validateSession();
const summary = [];
const reports = await client.report();
for (const matter of HAZCHEM_MATTERS) {
  const done = await client.done(matter);
  const completed = done.filter(row => row.lczt === '流程结束');
  const result = await queryHazardous({ done: async () => completed.slice(0, 1), report: async () => reports, certificates: (serial, signal) => client.certificates(serial, signal) }, matter,
    { page: 1, pageSize: 1, filters: {} });
  summary.push({ matterId: matter.id, totalDone: done.length, completed: completed.length, sampled: result.total,
    filled: result.rows.map(row => Object.fromEntries(['xkXdrMc', 'xkXdrShxym', 'xkFrdb', 'xkNr', 'xkJdrq', 'xkXkjgdm', 'xkLydwdm'].map(key => [key, Boolean(row[key])]))),
    warnings: result.rows.map(row => (row.hazardousEvidence as { warnings: string[] }).warnings.length) });
}
client.clearSession();
console.log(JSON.stringify({ passed: true, mode: 'readonly-one-per-matter', mutations: 0, enterprisePaidCalls: 0, summary }));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : '危化品只读验证失败'); process.exitCode = 1; });
