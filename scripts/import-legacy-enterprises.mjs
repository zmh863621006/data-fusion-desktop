import { DatabaseSync, backup } from 'node:sqlite';
import { readFile, mkdir, writeFile, chmod, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { planLegacyEnterpriseImport, applyLegacyEnterpriseImport } from '../admin-server/enterprise-import.mjs';

async function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, db: { type: 'string' }, report: { type: 'string' },
    apply: { type: 'boolean', default: false }, backup: { type: 'string' }, 'expect-digest': { type: 'string' } } });
  if (!values.input || !values.db || !values.report) throw new Error('必须指定 --input、--db、--report；默认仅预检，不写企业库');
  const source = resolve(values.input), databasePath = resolve(values.db), reportPath = resolve(values.report);
  if (new Set([source, databasePath, reportPath]).size !== 3) throw new Error('输入、数据库与报告路径必须不同');
  try { await stat(reportPath); throw new Error('报告路径已存在，请更换路径'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sourceStat = await stat(source); if (sourceStat.size > 64 * 1024 * 1024) throw new Error('输入超过64MiB限制');
  const document = JSON.parse(await readFile(source, 'utf8'));
  if (document.version !== 1 || !Array.isArray(document.rows)) throw new Error('来源快照格式无效');
  const db = new DatabaseSync(databasePath, { readOnly: !values.apply, allowExtension: false });
  try {
    let plan = planLegacyEnterpriseImport(db, document.rows);
    if (values.apply) {
      if (!values.backup || !values['expect-digest']) throw new Error('正式导入必须指定新的 --backup 及预检 --expect-digest');
      if (plan.digest !== values['expect-digest']) throw new Error('预检摘要已变化，请重新预检');
      const backupPath = resolve(values.backup);
      if ([source, databasePath, reportPath].includes(backupPath)) throw new Error('备份路径不能与输入、数据库或报告相同');
      try { await stat(backupPath); throw new Error('备份路径已存在，请更换路径'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
      await backup(db, backupPath); await chmod(backupPath, 0o600);
      const check = new DatabaseSync(backupPath, { readOnly: true });
      try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('备份完整性校验失败，已停止导入'); } finally { check.close(); }
      plan = applyLegacyEnterpriseImport(db, document.rows, values['expect-digest']);
    }
    await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
    await writeFile(reportPath, JSON.stringify({ mode: values.apply ? 'applied' : 'dry-run', source: document.source,
      ...plan }, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ mode: values.apply ? 'applied' : 'dry-run', digest: plan.digest, summary: plan.summary }));
  } finally { db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '企业导入失败'); process.exitCode = 1; });
