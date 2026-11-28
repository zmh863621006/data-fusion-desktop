import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createEnterpriseStore } from '../enterprises.mjs';
import { planLegacyEnterpriseImport, applyLegacyEnterpriseImport, LEGACY_ENTERPRISE_SOURCE } from '../enterprise-import.mjs';

const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY';
function credit(prefix) { return prefix + alphabet[(31 - [1,3,9,27,19,26,16,17,20,29,25,13,8,24,10,30,28].reduce((s,w,i) => s + alphabet.indexOf(prefix[i])*w, 0)%31)%31]; }
const code = credit('91440300123456789'), other = credit('91440300987654321');
const row = (patch = {}) => ({ sourceId: '12', sourceTable: 'traffic_data_fusion.t_license', sourceSavedAt: '2026-10-01 10:20:30',
  occurrences: 3, name: '测试企业有限公司', creditCode: code, legalPerson: '测试法人', ...patch });
function fixture(t) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); t.after(() => db.close());
  let providerCalls = 0;
  const store = createEnterpriseStore(db, { configured: true, provider: async () => { providerCalls++; throw new Error('must never pay for imported data'); },
    audit: () => {}, transaction: fn => { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } });
  return { db, store, calls: () => providerCalls };
}
function apply(db, rows) { return applyLegacyEnterpriseImport(db, rows, planLegacyEnterpriseImport(db, rows).digest); }
function seed(db, { name = '测试企业有限公司', legalPerson = '测试法人', source = 'manual', status = 'success', creditCode = code } = {}) {
  db.prepare('INSERT INTO enterprises(id,name,credit_code,legal_person,source,updated_at) VALUES(?,?,?,?,?,?)').run('entity', name, creditCode, legalPerson, source, 123);
  db.prepare('INSERT INTO enterprise_requests(id,name,credit_code,status,enterprise_id,source_system,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('request', name, creditCode, status, 'entity', 'manual', 123);
}

test('legacy import previews without writes, deduplicates repeated permits and immediately serves existing enterprise APIs', t => {
  const { db, store, calls } = fixture(t);
  const rows = [row(), row({ sourceId: '33', occurrences: 5 })];
  const plan = planLegacyEnterpriseImport(db, rows);
  assert.equal(plan.summary.newEnterprises, 1); assert.equal(plan.summary.sourceOccurrences, 8); assert.equal(plan.summary.newRequests, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM enterprises').get().n, 0);
  applyLegacyEnterpriseImport(db, rows, plan.digest);
  assert.equal(calls(), 0);
  const resolved = store.register({ name: row().name }, 'oversize-transport');
  assert.equal(resolved.status, 'success'); assert.equal(resolved.enterprise.creditCode, code); assert.equal(resolved.enterprise.legalPerson, '测试法人');
  assert.equal(db.prepare('SELECT count(*) n FROM enterprises').get().n, 1);
  const history = JSON.parse(db.prepare('SELECT after_json FROM enterprise_history WHERE source=? LIMIT 1').get(LEGACY_ENTERPRISE_SOURCE).after_json);
  assert.equal(history.legacyImport.provenance.length, 2); assert.equal(history.legacyImport.provenance[0].sourceTable, 'traffic_data_fusion.t_license');
});

test('repeated imports are idempotent including history and timestamps', t => {
  const { db } = fixture(t); const rows = [row()]; apply(db, rows);
  const before = db.prepare('SELECT * FROM enterprises').all(), historyCount = db.prepare('SELECT count(*) n FROM enterprise_history').get().n;
  const plan = planLegacyEnterpriseImport(db, rows);
  assert.equal(plan.summary.newEnterprises, 0); assert.equal(plan.summary.histories, 0);
  applyLegacyEnterpriseImport(db, rows, plan.digest);
  assert.deepEqual(db.prepare('SELECT * FROM enterprises').all(), before);
  assert.equal(db.prepare('SELECT count(*) n FROM enterprise_history').get().n, historyCount);
});

test('source name/legal-person conflicts enter review rather than choosing a random result', t => {
  const { db, store } = fixture(t); const rows = [row(), row({ sourceId: '34', legalPerson: '另一法人' })];
  const result = apply(db, rows);
  assert.equal(result.summary.conflictedCodes, 1); assert.equal(result.summary.newEnterprises, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM enterprises').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM enterprise_requests').get().status, 'review');
  assert.equal(store.register({ name: row().name, creditCode: code }).status, 'review');
});

test('same name with different codes remains separated and flagged', t => {
  const { db } = fixture(t); const result = apply(db, [row(), row({ sourceId: '22', creditCode: other })]);
  assert.equal(result.summary.conflictedCodes, 2); assert.equal(result.summary.reviewRequests, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM enterprises').get().n, 0);
});

test('never overwrites manual data or downgrades an already usable request on a source conflict', t => {
  const { db, store } = fixture(t); seed(db);
  const before = db.prepare('SELECT * FROM enterprises').get();
  apply(db, [row({ legalPerson: '旧法人' })]);
  assert.deepEqual(db.prepare('SELECT * FROM enterprises').get(), before);
  assert.equal(db.prepare('SELECT status FROM enterprise_requests WHERE id=\'request\'').get().status, 'success');
  assert.equal(store.result('request').enterprise.legalPerson, '测试法人');
  assert.ok(db.prepare('SELECT after_json FROM enterprise_history WHERE request_id=\'request\'').get().after_json.includes('旧法人'));
});

test('preserves intentionally blank manual legal-person values while filling nonmanual gaps and linked partial requests', t => {
  const { db } = fixture(t); seed(db, { legalPerson: '', status: 'partial' });
  apply(db, [row()]); assert.equal(db.prepare('SELECT legal_person FROM enterprises').get().legal_person, '');
  db.prepare('UPDATE enterprises SET source=?').run('aliyun-name');
  apply(db, [row()]);
  assert.equal(db.prepare('SELECT legal_person FROM enterprises').get().legal_person, '测试法人');
  assert.equal(db.prepare('SELECT status FROM enterprise_requests').get().status, 'success');
});

test('existing canonical name is protected and valid-code aliases become reusable without paid queries', t => {
  const { db, store, calls } = fixture(t); seed(db, { name: '已核实标准企业有限公司' });
  apply(db, [row()]);
  assert.equal(db.prepare('SELECT name FROM enterprises').get().name, '已核实标准企业有限公司');
  assert.equal(store.register({ name: row().name }).enterprise.name, '已核实标准企业有限公司');
  assert.equal(calls(), 0);
});

test('bad codes and natural-person identity numbers are not inserted', t => {
  const { db } = fixture(t); const result = apply(db, [row({ creditCode: '11010519491231002X' }), row({ creditCode: '123' }), row({ name: '' })]);
  assert.equal(result.summary.rejectedRows, 3); assert.equal(result.summary.newRequests, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM enterprises').get().n, 0);
});

test('a previously reviewed request stays reviewed even when the old dataset appears complete', t => {
  const { db } = fixture(t); seed(db, { status: 'review' }); apply(db, [row()]);
  assert.equal(db.prepare('SELECT status FROM enterprise_requests').get().status, 'review');
});

test('changed target data invalidates a plan, with a full transaction rollback', t => {
  const { db } = fixture(t); const rows = [row()], plan = planLegacyEnterpriseImport(db, rows);
  seed(db, { legalPerson: '刚刚人工修正的法人' });
  assert.throws(() => applyLegacyEnterpriseImport(db, rows, plan.digest), /已变化/);
  assert.equal(db.prepare('SELECT legal_person FROM enterprises').get().legal_person, '刚刚人工修正的法人');
  assert.equal(db.prepare('SELECT count(*) n FROM enterprise_history').get().n, 0);
});

test('a write failure rolls back the entire batch', t => {
  const { db } = fixture(t);
  db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON enterprise_history BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(() => apply(db, [row()]), /fixture failure/);
  assert.equal(db.prepare('SELECT count(*) n FROM enterprises').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM enterprise_requests').get().n, 0);
});

test('Redis provenance preserves the original query without confirming it as an alias; rescans are idempotent', t => {
  const { db } = fixture(t);
  const source = row({ sourceId: 'key-sha256', sourceTable: 'redis:192.168.71.43:6379/db2/qymc',
    sourceSavedAt: '', sourceObservedAt: '2026-10-18T03:00:00Z', sourceQuery: '未经核实的原查询名称' });
  apply(db, [source]);
  const history = JSON.parse(db.prepare('SELECT after_json FROM enterprise_history').get().after_json).legacyImport;
  assert.equal(history.provenance[0].sourceQuery, source.sourceQuery);
  assert.equal(history.provenance[0].sourceSavedAt, '');
  assert.equal(history.provenance[0].sourceObservedAt, source.sourceObservedAt);
  assert.equal(db.prepare('SELECT count(*) n FROM enterprise_requests WHERE name=?').get(source.sourceQuery).n, 0);
  const rescan = planLegacyEnterpriseImport(db, [{ ...source, sourceObservedAt: '2026-10-19T03:00:00Z' }]);
  assert.equal(rescan.summary.newEnterprises, 0);
  assert.equal(rescan.summary.histories, 0);
});
