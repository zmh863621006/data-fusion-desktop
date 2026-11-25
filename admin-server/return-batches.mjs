import { createHash, randomUUID } from 'node:crypto';

export const RETURN_MAX_ROWS = 50_000;
export const RETURN_MAX_CHUNK_ROWS = 100;
export const RETURN_MAX_ROW_BYTES = 128 * 1024;
export const RETURN_MAX_REQUEST_BYTES = 1024 * 1024;
export const RETURN_MAX_BATCH_BYTES = 256 * 1024 * 1024;
export const RETURN_MAX_CHUNKS = 10_000;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const hash = value => createHash('sha256').update(value).digest('hex');

function keys(value, allowed, message = '回流请求包含未知字段') {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(message);
}

function jsonValue(value, depth = 0, ancestors = new Set()) {
  if (depth > 32) fail('回流数据嵌套超过限制', 413);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if ((!Array.isArray(value) && !object(value)) || ancestors.has(value)) fail('回流数据必须是有效的 JSON');
  ancestors.add(value);
  for (const item of Object.values(value)) jsonValue(item, depth + 1, ancestors);
  ancestors.delete(value);
}

function checkedBody(body, allowed) {
  keys(body, ['proof', 'deviceId', ...allowed]);
  jsonValue(body);
  if (Buffer.byteLength(JSON.stringify(body)) > RETURN_MAX_REQUEST_BYTES) fail('回流请求超过1MiB', 413);
  if (typeof body.deviceId !== 'string' || !/^[a-f0-9]{64}$/.test(body.deviceId)) fail('回流需要有效设备授权', 403);
}

function checkedMetadata(body) {
  checkedBody(body, ['schema', 'clientBatchId', 'systemId', 'matterId', 'startedAt', 'finishedAt', 'rowCount']);
  if (body.schema !== undefined && body.schema !== 1) fail('回流协议版本无效');
  if (typeof body.clientBatchId !== 'string' || !UUID.test(body.clientBatchId)
    || typeof body.systemId !== 'string' || !ID.test(body.systemId) || typeof body.matterId !== 'string' || !ID.test(body.matterId)
    || !time(body.startedAt) || !time(body.finishedAt) || body.finishedAt < body.startedAt
    || !Number.isSafeInteger(body.rowCount) || body.rowCount < 0 || body.rowCount > RETURN_MAX_ROWS) fail('回流批次信息无效');
  return { clientBatchId: body.clientBatchId, systemId: body.systemId, matterId: body.matterId,
    startedAt: body.startedAt, finishedAt: body.finishedAt, rowCount: body.rowCount };
}

function checkedRows(body) {
  checkedBody(body, ['index', 'rows']);
  if (!Number.isSafeInteger(body.index) || body.index < 0 || body.index >= RETURN_MAX_CHUNKS
    || !Array.isArray(body.rows) || !body.rows.length || body.rows.length > RETURN_MAX_CHUNK_ROWS) fail('回流数据分块信息无效');
  const recordKeys = new Set();
  for (const row of body.rows) {
    keys(row, ['recordKey', 'data', 'firstSeenAt', 'updatedAt'], '回流记录包含未知字段');
    if (typeof row.recordKey !== 'string' || !row.recordKey || row.recordKey.length > 512 || /[\x00-\x1f\x7f]/.test(row.recordKey)
      || !object(row.data) || !time(row.firstSeenAt) || !time(row.updatedAt) || row.updatedAt < row.firstSeenAt) fail('回流记录格式无效');
    if (recordKeys.has(row.recordKey)) fail('同一回流批次不允许重复记录编号', 409);
    recordKeys.add(row.recordKey);
    if (Buffer.byteLength(JSON.stringify(row)) > RETURN_MAX_ROW_BYTES) fail('单条回流记录超过128KiB', 413);
  }
  const encoded = JSON.stringify(body.rows);
  return { index: body.index, rows: body.rows.map(row => ({ ...row, data: JSON.parse(JSON.stringify(row.data)) })),
    encoded, sha256: hash(encoded), bytes: Buffer.byteLength(encoded) };
}

function parameters(value = new URLSearchParams()) {
  if (!(value instanceof URLSearchParams)) fail('查询参数无效');
  for (const key of new Set(value.keys())) if (value.getAll(key).length !== 1) fail('查询参数不能重复');
  return value;
}

function positive(value, fallback, maximum, label) {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) fail(`${label}无效`);
  return Number(value);
}

function pageFor(query) {
  const page = positive(query.get('page'), 1, 1_000_000, '页码');
  const pageSize = positive(query.get('pageSize'), 20, 100, '每页数量');
  return { page, pageSize, offset: (page - 1) * pageSize };
}

const like = value => '%' + value.replace(/[\\%_]/g, '\\$&') + '%';

/** Signed device authorization is supplied by app.mjs; no proof is stored here. */
export function createReturnBatches(database, { transaction, audit = () => {}, authorize, revalidate, now = Date.now } = {}) {
  if (!database || typeof authorize !== 'function') throw new Error('回流服务缺少数据库或设备授权校验');
  const transact = transaction ?? (work => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = work(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  });
  database.exec(`
    CREATE TABLE IF NOT EXISTS return_batches(
      id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,license_id TEXT NOT NULL,device_id TEXT NOT NULL,
      client_batch_id TEXT NOT NULL,system_id TEXT NOT NULL,matter_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,finished_at INTEGER NOT NULL,row_count INTEGER NOT NULL,
      received_rows INTEGER NOT NULL DEFAULT 0,received_bytes INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','completed')),
      created_at INTEGER NOT NULL,completed_at INTEGER,manifest_json TEXT,
      UNIQUE(license_id,device_id,client_batch_id),
      FOREIGN KEY(customer_id) REFERENCES customers(id),FOREIGN KEY(license_id) REFERENCES licenses(id),
      FOREIGN KEY(system_id,matter_id) REFERENCES system_matters(system_id,id));
    CREATE INDEX IF NOT EXISTS return_batch_created ON return_batches(created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS return_batch_owner ON return_batches(customer_id,device_id,system_id,matter_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS return_batch_chunks(
      batch_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,sha256 TEXT NOT NULL,row_count INTEGER NOT NULL,
      bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(batch_id,chunk_index),
      FOREIGN KEY(batch_id) REFERENCES return_batches(id));
    CREATE TABLE IF NOT EXISTS return_batch_rows(
      batch_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,row_index INTEGER NOT NULL,record_key TEXT NOT NULL,
      data_json TEXT NOT NULL,first_seen_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      PRIMARY KEY(batch_id,chunk_index,row_index),UNIQUE(batch_id,record_key),
      FOREIGN KEY(batch_id,chunk_index) REFERENCES return_batch_chunks(batch_id,chunk_index));
    CREATE TABLE IF NOT EXISTS return_batch_events(
      id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,customer_id TEXT NOT NULL,license_id TEXT NOT NULL,
      device_id TEXT NOT NULL,action TEXT NOT NULL,metadata_json TEXT NOT NULL,created_at INTEGER NOT NULL,
      FOREIGN KEY(batch_id) REFERENCES return_batches(id));
  `);
  const lookup = id => database.prepare('SELECT * FROM return_batches WHERE id=?').get(id);
  const joined = `SELECT b.*,c.name AS customer_name,s.name AS system_name,m.name AS matter_name
    FROM return_batches b LEFT JOIN customers c ON c.id=b.customer_id
    LEFT JOIN systems s ON s.id=b.system_id LEFT JOIN system_matters m ON m.system_id=b.system_id AND m.id=b.matter_id`;
  const describe = row => ({ id: row.id, clientBatchId: row.client_batch_id, customerId: row.customer_id,
    customerName: row.customer_name ?? row.customer_id, licenseId: row.license_id, deviceId: row.device_id,
    systemId: row.system_id, systemName: row.system_name ?? row.system_id, matterId: row.matter_id,
    matterName: row.matter_name ?? row.matter_id, startedAt: row.started_at, finishedAt: row.finished_at,
    rowCount: row.row_count, receivedRows: row.received_rows, receivedBytes: row.received_bytes, state: row.state,
    createdAt: row.created_at, completedAt: row.completed_at ?? null });
  const receipt = row => ({ id: row.id, state: row.state, rowCount: row.row_count, receivedRows: row.received_rows });
  const rowData = row => ({ rowNo: row.row_no, recordKey: row.record_key, data: JSON.parse(row.data_json),
    firstSeenAt: row.first_seen_at, updatedAt: row.updated_at });
  const event = (owner, action, id, metadata) => {
    database.prepare(`INSERT INTO return_batch_events(id,batch_id,customer_id,license_id,device_id,action,metadata_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), id, owner.customerId, owner.licenseId, owner.deviceId, action, JSON.stringify(metadata), now());
    audit(owner, action, 'return_batch', id, metadata);
  };
  async function owner(body, scope) {
    const result = await authorize(body, scope);
    if (!result || ['customerId', 'licenseId', 'deviceId'].some(key => typeof result[key] !== 'string' || !result[key] || result[key].length > 200)
      || result.deviceId !== body.deviceId) fail('回流需要有效设备授权', 403);
    return { customerId: result.customerId, licenseId: result.licenseId, deviceId: result.deviceId };
  }
  async function authorized(id, body) {
    const row = lookup(id);
    if (!row) fail('回流批次不存在', 404);
    const identity = await owner(body, { systemId: row.system_id, matterId: row.matter_id });
    if (row.customer_id !== identity.customerId || row.license_id !== identity.licenseId || row.device_id !== identity.deviceId) fail('回流批次不存在', 404);
    return { identity, row };
  }
  function recheck(body, scope, identity) {
    if (!revalidate) return;
    // A synchronous live license check inside BEGIN IMMEDIATE closes the await/revocation window.
    const current = revalidate(body, scope);
    if (!current || typeof current.then === 'function'
      || ['customerId', 'licenseId', 'deviceId'].some(key => current[key] !== identity[key])) fail('当前设备授权已变更', 403);
  }
  const requiredBatch = id => {
    if (!UUID.test(id ?? '')) fail('回流批次编号无效');
    const row = database.prepare(joined + ' WHERE b.id=?').get(id);
    if (!row) fail('回流批次不存在', 404);
    return row;
  };

  return {
    async handle(path, body) {
      if (path === '/api/returns/batches') {
        const metadata = checkedMetadata(body), identity = await owner(body, { systemId: metadata.systemId, matterId: metadata.matterId });
        return transact(() => {
          recheck(body, { systemId: metadata.systemId, matterId: metadata.matterId }, identity);
          let row = database.prepare('SELECT * FROM return_batches WHERE license_id=? AND device_id=? AND client_batch_id=?')
            .get(identity.licenseId, identity.deviceId, metadata.clientBatchId);
          if (row) {
            if (row.customer_id !== identity.customerId || row.system_id !== metadata.systemId || row.matter_id !== metadata.matterId
              || row.started_at !== metadata.startedAt || row.finished_at !== metadata.finishedAt || row.row_count !== metadata.rowCount)
              fail('这个回流批次已绑定不同内容，请保留原批次重试', 409);
          } else {
            const id = randomUUID();
            database.prepare(`INSERT INTO return_batches(id,customer_id,license_id,device_id,client_batch_id,system_id,matter_id,started_at,finished_at,row_count,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, identity.customerId, identity.licenseId, identity.deviceId, metadata.clientBatchId,
              metadata.systemId, metadata.matterId, metadata.startedAt, metadata.finishedAt, metadata.rowCount, now());
            event(identity, 'return_batch.started', id, { systemId: metadata.systemId, matterId: metadata.matterId, rowCount: metadata.rowCount });
            row = lookup(id);
          }
          return receipt(row);
        });
      }
      const match = /^\/api\/returns\/batches\/([a-f0-9-]{36})\/(chunks|complete)$/.exec(path);
      if (!match || !UUID.test(match[1])) fail('回流接口不存在', 404);
      const id = match[1];
      if (match[2] === 'chunks') {
        const chunk = checkedRows(body), { identity, row: authorizedRow } = await authorized(id, body);
        return transact(() => {
          recheck(body, { systemId: authorizedRow.system_id, matterId: authorizedRow.matter_id }, identity);
          const row = lookup(id), previous = database.prepare('SELECT * FROM return_batch_chunks WHERE batch_id=? AND chunk_index=?').get(id, chunk.index);
          if (previous) {
            if (previous.sha256 !== chunk.sha256 || previous.row_count !== chunk.rows.length || previous.bytes !== chunk.bytes) fail('这个回流分块已绑定不同内容', 409);
          } else {
            if (row.state === 'completed') fail('已完成的回流批次不能更改', 409);
            if (chunk.index >= row.row_count || row.received_rows + chunk.rows.length > row.row_count) fail('回流记录数超过批次声明', 409);
            if (row.received_bytes + chunk.bytes > RETURN_MAX_BATCH_BYTES) fail('回流批次超过256MiB', 413);
            const duplicate = database.prepare('SELECT 1 FROM return_batch_rows WHERE batch_id=? AND record_key=?');
            if (chunk.rows.some(value => duplicate.get(id, value.recordKey))) fail('同一回流批次不允许重复记录编号', 409);
            database.prepare(`INSERT INTO return_batch_chunks(batch_id,chunk_index,sha256,row_count,bytes,created_at) VALUES(?,?,?,?,?,?)`)
              .run(id, chunk.index, chunk.sha256, chunk.rows.length, chunk.bytes, now());
            const insert = database.prepare(`INSERT INTO return_batch_rows(batch_id,chunk_index,row_index,record_key,data_json,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?)`);
            for (const [index, value] of chunk.rows.entries()) insert.run(id, chunk.index, index, value.recordKey, JSON.stringify(value.data), value.firstSeenAt, value.updatedAt);
            database.prepare('UPDATE return_batches SET received_rows=received_rows+?,received_bytes=received_bytes+? WHERE id=?').run(chunk.rows.length, chunk.bytes, id);
            event(identity, 'return_batch.chunk_received', id, { index: chunk.index, rows: chunk.rows.length, sha256: chunk.sha256 });
          }
          return { ...receipt(lookup(id)), index: chunk.index, sha256: chunk.sha256 };
        });
      }
      checkedBody(body, ['chunks']);
      if (!Array.isArray(body.chunks) || body.chunks.length > RETURN_MAX_CHUNKS || body.chunks.some(value => typeof value !== 'string' || !SHA256.test(value))) fail('回流批次完整性清单无效');
      const manifest = JSON.stringify(body.chunks), { identity, row: authorizedRow } = await authorized(id, body);
      return transact(() => {
        recheck(body, { systemId: authorizedRow.system_id, matterId: authorizedRow.matter_id }, identity);
        const row = lookup(id);
        if (row.state === 'completed') {
          if (row.manifest_json !== manifest) fail('已完成的回流批次不能更改', 409);
          return receipt(row);
        }
        const chunks = database.prepare('SELECT * FROM return_batch_chunks WHERE batch_id=? ORDER BY chunk_index').all(id);
        if (row.received_rows !== row.row_count || chunks.length !== body.chunks.length
          || chunks.some((chunk, index) => chunk.chunk_index !== index || chunk.sha256 !== body.chunks[index])
          || chunks.reduce((total, chunk) => total + chunk.row_count, 0) !== row.row_count) fail('回流批次尚未完整接收或摘要不一致', 409);
        database.prepare("UPDATE return_batches SET state='completed',completed_at=?,manifest_json=? WHERE id=? AND state='uploading'").run(now(), manifest, id);
        event(identity, 'return_batch.completed', id, { rows: row.row_count, chunks: chunks.length });
        return receipt(lookup(id));
      });
    },
    list(input) {
      const query = parameters(input), { pageSize, offset } = pageFor(query), where = [], values = [];
      const columns = { customerId: 'b.customer_id', deviceId: 'b.device_id', systemId: 'b.system_id', matterId: 'b.matter_id', state: 'b.state' };
      for (const key of query.keys()) if (!['page', 'pageSize', 'from', 'to', 'keyword', ...Object.keys(columns)].includes(key)) fail('回流列表查询参数无效');
      for (const [key, column] of Object.entries(columns)) {
        const value = query.get(key);
        if (value === null || value === '') continue;
        if (value.length > 200 || key === 'state' && !['uploading', 'completed'].includes(value)) fail('回流列表筛选条件无效');
        where.push(`${column}=?`); values.push(value);
      }
      const dates = {};
      for (const [key, operator] of [['from', '>='], ['to', '<=']]) {
        const value = query.get(key);
        if (value === null || value === '') continue;
        if (!/^\d+$/.test(value) || !time(Number(value))) fail('回流时间筛选无效');
        dates[key] = Number(value); where.push(`b.created_at${operator}?`); values.push(dates[key]);
      }
      if (dates.from !== undefined && dates.to !== undefined && dates.from > dates.to) fail('回流时间范围无效');
      const keyword = query.get('keyword');
      if (keyword) {
        if (keyword.length > 200) fail('回流搜索文字超过限制');
        where.push(`(c.name LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR m.name LIKE ? ESCAPE '\\'
          OR b.device_id LIKE ? ESCAPE '\\' OR b.client_batch_id LIKE ? ESCAPE '\\'
          OR EXISTS(SELECT 1 FROM return_batch_rows r WHERE r.batch_id=b.id AND (r.record_key LIKE ? ESCAPE '\\' OR r.data_json LIKE ? ESCAPE '\\')))`);
        values.push(...Array(7).fill(like(keyword)));
      }
      const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
      const source = joined.slice(joined.indexOf('FROM'));
      const total = database.prepare('SELECT COUNT(*) AS n ' + source + clause).get(...values).n;
      const rows = database.prepare(joined + clause + ' ORDER BY b.created_at DESC,b.id DESC LIMIT ? OFFSET ?').all(...values, pageSize, offset);
      return { rows: rows.map(describe), total };
    },
    detail(id, input) {
      const batch = requiredBatch(id), query = parameters(input), { pageSize, offset } = pageFor(query);
      for (const key of query.keys()) if (!['page', 'pageSize', 'keyword'].includes(key)) fail('回流明细查询参数无效');
      const keyword = query.get('keyword');
      if (keyword && keyword.length > 200) fail('回流搜索文字超过限制');
      const filter = keyword ? " WHERE record_key LIKE ? ESCAPE '\\' OR data_json LIKE ? ESCAPE '\\'" : '';
      const source = '(SELECT r.*,ROW_NUMBER() OVER(ORDER BY chunk_index,row_index) AS row_no FROM return_batch_rows r WHERE batch_id=?)';
      const values = [id, ...(keyword ? [like(keyword), like(keyword)] : [])];
      const total = database.prepare('SELECT COUNT(*) AS n FROM ' + source + filter).get(...values).n;
      const rows = database.prepare('SELECT * FROM ' + source + filter + ' ORDER BY row_no LIMIT ? OFFSET ?').all(...values, pageSize, offset);
      return { batch: describe(batch), rows: rows.map(rowData), total };
    },
    export(id) {
      const batch = requiredBatch(id);
      if (batch.state !== 'completed') fail('回流批次尚未完整接收，不能下载', 409);
      const rows = database.prepare(`SELECT *,ROW_NUMBER() OVER(ORDER BY chunk_index,row_index) AS row_no
        FROM return_batch_rows WHERE batch_id=? ORDER BY chunk_index,row_index`).iterate(id);
      return { batch: describe(batch), rows: (function* () { for (const row of rows) yield rowData(row); })() };
    },
  };
}
