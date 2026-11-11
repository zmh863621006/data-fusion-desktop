import { createHash, randomUUID } from 'node:crypto';
import { validCreditCode } from './enterprises.mjs';

export const LEGACY_ENTERPRISE_SOURCE = 'legacy-collection';
const clean = value => typeof value === 'string' ? value.trim() : '';
const normalized = value => clean(value).replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyOf = row => JSON.stringify([row.name, row.credit_code ?? row.creditCode]);
const order = rows => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));

/** Read-only planning. Canonical data and manual/review decisions always outrank an import. */
export function planLegacyEnterpriseImport(db, input, options = {}) {
  const importSource = options.source ?? LEGACY_ENTERPRISE_SOURCE;
  if (!Array.isArray(input) || input.length > 100000) throw new Error('企业导入数据必须是最多100000条的数组');
  const entities = db.prepare('SELECT * FROM enterprises ORDER BY credit_code').all();
  const requests = db.prepare('SELECT * FROM enterprise_requests ORDER BY id').all();
  const receipts = db.prepare('SELECT request_id,after_json FROM enterprise_history WHERE source=? ORDER BY id').all(importSource);
  const targetFingerprint = hash({ entities, requests, receipts });
  const entityByCode = new Map(entities.map(row => [row.credit_code, row]));
  const requestByKey = new Map(requests.map(row => [keyOf(row), row]));
  const priorReceipts = new Set();
  for (const row of receipts) {
    try { const value = JSON.parse(row.after_json).legacyImport; if (value?.fingerprint) priorReceipts.add(`${row.request_id}:${value.fingerprint}`); } catch { /* Preserve old non-import history. */ }
  }
  const groups = new Map(), rejected = [];
  let sourceOccurrences = 0;
  for (const [index, source] of input.entries()) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('企业导入记录格式无效');
    const row = { sourceId: clean(String(source.sourceId ?? index)), sourceTable: clean(source.sourceTable),
      sourceSavedAt: clean(source.sourceSavedAt), sourceQuery: clean(source.sourceQuery),
      sourceObservedAt: clean(source.sourceObservedAt), occurrences: Number(source.occurrences ?? 1),
      name: clean(source.name), creditCode: clean(source.creditCode).toUpperCase(), legalPerson: clean(source.legalPerson) };
    if (!Number.isSafeInteger(row.occurrences) || row.occurrences < 1 || row.sourceId.length > 128 || row.sourceTable.length > 128 || row.sourceSavedAt.length > 100 || row.sourceQuery.length > 200 || row.sourceObservedAt.length > 100) throw new Error('企业来源依据格式无效');
    sourceOccurrences += row.occurrences;
    let reason = '';
    if (!row.name || row.name.length > 200) reason = '企业名称缺失或过长';
    else if (/^\d{17}[\dX]$/.test(row.creditCode) && !/^9[123]/.test(row.creditCode) || !validCreditCode(row.creditCode)) reason = '统一信用代码无效，不导入身份证或旧注册号';
    else if (row.legalPerson.length > 100) reason = '法人姓名过长';
    if (reason) { rejected.push({ sourceId: row.sourceId, sourceTable: row.sourceTable, reason }); continue; }
    if (/^(?:无|暂无|未知|null|none|undefined|[-—]+)$/i.test(row.legalPerson)) row.legalPerson = '';
    const group = groups.get(row.creditCode) ?? []; group.push(row); groups.set(row.creditCode, group);
  }
  const nameCodes = new Map();
  for (const [code, rows] of groups) for (const row of rows) {
    const codes = nameCodes.get(normalized(row.name)) ?? new Set(); codes.add(code); nameCodes.set(normalized(row.name), codes);
  }
  const summary = { sourceRows: input.length, sourceOccurrences, rejectedRows: rejected.length,
    uniqueCodes: groups.size, newEnterprises: 0, filledEnterprises: 0, reusedEnterprises: 0,
    conflictedCodes: 0, newRequests: 0, changedRequests: 0, reviewRequests: 0, unchangedRequests: 0, histories: 0 };
  const changes = [];
  for (const [code, unsorted] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const rows = order(unsorted);
    const names = new Set(rows.map(row => normalized(row.name)));
    const legalNames = new Set(rows.map(row => normalized(row.legalPerson)).filter(Boolean));
    const existing = entityByCode.get(code);
    let reason = '';
    if (names.size > 1 || legalNames.size > 1) reason = '旧归集系统同一信用代码存在不同名称或法人，请核对';
    else if (rows.some(row => nameCodes.get(normalized(row.name)).size > 1)) reason = '旧归集系统同一企业名称对应多个信用代码，请核对';
    else if (rows.some(row => entities.some(entity => normalized(entity.name) === normalized(row.name) && entity.credit_code !== code))) reason = '旧归集名称与后台其他信用代码的企业重名，请核对';
    const latest = [...rows].sort((a, b) => b.sourceSavedAt.localeCompare(a.sourceSavedAt) || a.sourceId.localeCompare(b.sourceId, 'en'))[0];
    const legalPerson = rows.find(row => row.legalPerson)?.legalPerson ?? '';
    if (!reason && existing?.legal_person && legalPerson && normalized(existing.legal_person) !== normalized(legalPerson)) reason = '旧归集法人信息与后台已维护资料不同，保留后台资料';
    let entityAction = 'reuse';
    if (reason) summary.conflictedCodes++;
    else if (!existing) { entityAction = 'create'; summary.newEnterprises++; }
    else if (!existing.legal_person && legalPerson && existing.source !== 'manual') { entityAction = 'fill'; summary.filledEnterprises++; }
    else summary.reusedEnterprises++;
    const finalLegalPerson = reason ? existing?.legal_person ?? '' : existing?.source === 'manual' ? existing.legal_person : existing?.legal_person || legalPerson;
    const candidates = new Map();
    for (const row of rows) candidates.set(keyOf(row), { name: row.name, creditCode: code });
    if (!reason && existing && entityAction === 'fill') {
      for (const row of requests) if (row.enterprise_id === existing.id && row.status === 'partial') candidates.set(keyOf(row), { name: row.name, creditCode: row.credit_code });
    }
    // Observing the same cache again is not a business-data change. Keep the original
    // query as evidence only; it does not automatically become a trusted name alias.
    const fingerprint = hash({ source: importSource, rows: rows.map(({ sourceObservedAt, ...value }) => value) });
    const plannedRequests = [];
    for (const candidate of [...candidates.values()].sort((a,b) => keyOf(a).localeCompare(keyOf(b), 'en'))) {
      const previous = requestByKey.get(keyOf(candidate));
      const protectedRequest = previous && (previous.status === 'review' || previous.enterprise_id && previous.enterprise_id !== existing?.id
        || reason && previous.enterprise_id && ['success','partial'].includes(previous.status));
      const status = protectedRequest ? previous.status : reason ? 'review' : finalLegalPerson ? 'success' : 'partial';
      const requestReason = protectedRequest ? previous.reason : reason;
      const linked = protectedRequest ? previous.enterprise_id : reason ? previous?.enterprise_id ?? null : existing?.id ?? null;
      const changed = !previous || previous.status !== status || previous.reason !== requestReason || (!reason && !protectedRequest && previous.enterprise_id !== existing?.id);
      const recordHistory = changed || entityAction !== 'reuse' || !priorReceipts.has(`${previous?.id}:${fingerprint}`);
      if (!previous) summary.newRequests++;
      else if (changed) summary.changedRequests++;
      else summary.unchangedRequests++;
      if (status === 'review') summary.reviewRequests++;
      if (recordHistory) summary.histories++;
      plannedRequests.push({ ...candidate, previous: previous ?? null, status, reason: requestReason, linked, protected: Boolean(protectedRequest), changed, recordHistory });
    }
    changes.push({ creditCode: code, name: existing?.name ?? latest.name, legalPerson: finalLegalPerson,
      existing: existing ?? null, entityAction, reason, fingerprint, provenance: rows, requests: plannedRequests });
  }
  const sourceFingerprint = hash({ input });
  return { version: 1, sourceFingerprint, targetFingerprint, summary, rejected, changes,
    digest: hash({ sourceFingerprint, targetFingerprint, summary, changes }) };
}

/** One short SQLite write transaction; no source DB connection and no paid provider calls. */
export function applyLegacyEnterpriseImport(db, rows, expectedDigest, options = {}) {
  const importSource = options.source ?? LEGACY_ENTERPRISE_SOURCE;
  if (!/^[a-f0-9]{64}$/.test(expectedDigest ?? '')) throw new Error('正式导入必须提供预检摘要');
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; BEGIN IMMEDIATE;');
  try {
    const plan = planLegacyEnterpriseImport(db, rows, options);
    if (plan.digest !== expectedDigest) throw new Error('来源或后台资料已变化，请重新预检，未覆盖新数据');
    const now = Date.now();
    for (const change of plan.changes) {
      let entityId = change.existing?.id ?? null;
      if (change.entityAction === 'create') {
        entityId = randomUUID();
        db.prepare('INSERT INTO enterprises(id,name,credit_code,legal_person,source,updated_at) VALUES(?,?,?,?,?,?)')
          .run(entityId, change.name, change.creditCode, change.legalPerson, importSource, now);
      } else if (change.entityAction === 'fill') {
        db.prepare('UPDATE enterprises SET legal_person=?,source=?,updated_at=? WHERE id=? AND legal_person=\'\' AND source<>\'manual\'')
          .run(change.legalPerson, importSource, now, entityId);
      }
      for (const item of change.requests) {
        const id = item.previous?.id ?? randomUUID();
        const linkId = item.protected || change.reason ? item.linked : entityId;
        if (!item.previous) {
          db.prepare('INSERT INTO enterprise_requests(id,name,credit_code,status,enterprise_id,source_system,reason,created_at) VALUES(?,?,?,?,?,?,?,?)')
            .run(id, item.name, item.creditCode, item.status, linkId, importSource, item.reason, now);
        } else if (item.changed) {
          db.prepare('UPDATE enterprise_requests SET status=?,enterprise_id=?,reason=? WHERE id=?').run(item.status, linkId, item.reason, id);
        }
        if (item.recordHistory) {
          const after = { request: db.prepare('SELECT * FROM enterprise_requests WHERE id=?').get(id),
            enterprise: entityId ? db.prepare('SELECT * FROM enterprises WHERE id=?').get(entityId) : null,
            legacyImport: { fingerprint: change.fingerprint, reason: change.reason, provenance: change.provenance } };
          db.prepare('INSERT INTO enterprise_history(id,request_id,actor,source,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)')
            .run(randomUUID(), id, options.actor ?? 'migration:collection-system', importSource, JSON.stringify({ request: item.previous, enterprise: change.existing }), JSON.stringify(after), now);
        }
      }
    }
    db.exec('COMMIT');
    return plan;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
