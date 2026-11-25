import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createReturnBatches, RETURN_MAX_ROWS, RETURN_MAX_CHUNK_ROWS, RETURN_MAX_BATCH_BYTES } from '../return-batches.mjs';

const deviceId = 'a'.repeat(64), otherDevice = 'b'.repeat(64);
const now = Date.parse('2026-11-26T01:00:00+08:00');
const baseOwner = { customerId: 'fixture-customer', licenseId: 'fixture-license', deviceId };
const auth = { proof: { algorithm: 'RSA-SHA256', payload: 'fixture-payload', signature: 'fixture-proof-not-for-persistence' }, deviceId };
const query = values => new URLSearchParams(Object.entries(values ?? {}).map(([key, value]) => [key, String(value)]));
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const row = (recordKey, data = { name: '虚构回流记录' }) => ({ recordKey, data, firstSeenAt: now - 2000, updatedAt: now - 1000 });
const metadata = (rowCount = 1, extra = {}) => ({ ...auth, schema: 1, clientBatchId: randomUUID(), systemId: 'government-info',
  matterId: 'fixture-matter', startedAt: now - 5000, finishedAt: now - 1000, rowCount, ...extra });
const errorStatus = status => error => error.status === status;

function schema(database) {
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS licenses(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS systems(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS system_matters(system_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(system_id,id));
    INSERT OR IGNORE INTO customers VALUES('fixture-customer','惠州虚构测试单位');
    INSERT OR IGNORE INTO customers VALUES('second-customer','第二虚构单位');
    INSERT OR IGNORE INTO licenses VALUES('fixture-license','fixture-customer');
    INSERT OR IGNORE INTO licenses VALUES('second-license','second-customer');
    INSERT OR IGNORE INTO systems VALUES('government-info','虚构政务业务');
    INSERT OR IGNORE INTO systems VALUES('guangdong-hrss','虚构人社业务');
    INSERT OR IGNORE INTO system_matters VALUES('government-info','fixture-matter','虚构测试事项');
    INSERT OR IGNORE INTO system_matters VALUES('guangdong-hrss','fixture-matter','人社测试事项');`);
}

function fixture(t, path = ':memory:', options = {}) {
  let database, manager, identity = { ...baseOwner }, allowed = true, auditHook, tick = now;
  const scopes = [];
  function open() {
    database = new DatabaseSync(path); schema(database);
    manager = createReturnBatches(database, {
      now: () => tick,
      authorize: async (body, scope) => {
        scopes.push(scope);
        assert.equal(body.proof?.signature, auth.proof.signature);
        if (!allowed) throw Object.assign(new Error('fixture permission revoked'), { status: 403 });
        return { ...identity };
      },
      audit: (...args) => auditHook?.(...args),
      ...options,
    });
  }
  open();
  t.after(() => database.close());
  return { get database() { return database; }, get manager() { return manager; }, scopes,
    reopen() { database.close(); open(); }, owner(value) { identity = { ...value }; },
    revoke(value = true) { allowed = !value; }, audit(value) { auditHook = value; }, time(value) { tick = value; },
    begin: body => manager.handle('/api/returns/batches', body),
    chunk: (id, index, rows, extra = {}) => manager.handle(`/api/returns/batches/${id}/chunks`, { ...auth, index, rows, ...extra }),
    complete: (id, chunks, extra = {}) => manager.handle(`/api/returns/batches/${id}/complete`, { ...auth, chunks, ...extra }),
  };
}

test('synchronous revalidation inside the write transaction rejects permission revoked during async authorization', async t => {
  let active = true;
  const f = fixture(t, ':memory:', {
    authorize: async () => { const result = { ...baseOwner }; await Promise.resolve(); active = false; return result; },
    revalidate: () => { if (!active) throw Object.assign(Error('revoked before commit'), { status: 403 }); return { ...baseOwner }; },
  });
  await assert.rejects(f.begin(metadata(0)), errorStatus(403));
  assert.equal(f.manager.list(query()).total, 0);
});

test('ordered export survives interrupted, out-of-order chunks and a process restart; completion is immutable and idempotent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-returns-store-'));
  const f = fixture(t, join(directory, 'admin.sqlite')), request = metadata(3), batch = await f.begin(request);
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert(directory.startsWith(join(tmpdir(), 'fusion-returns-store-')));
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(batch, { id: batch.id, state: 'uploading', rowCount: 3, receivedRows: 0 });
  const later = [row('late', { name: '保留原始值', nested: { valid: true, missing: null, values: [1, '中文'] } })];
  const last = await f.chunk(batch.id, 1, later);
  assert.equal(last.sha256, digest(later));
  assert.equal(last.receivedRows, 1);
  await assert.rejects(f.complete(batch.id, [last.sha256]), errorStatus(409));
  f.reopen();
  assert.equal((await f.begin(request)).id, batch.id);
  assert.equal((await f.chunk(batch.id, 1, later)).receivedRows, 1);
  const earlier = [row('first'), row('second')], first = await f.chunk(batch.id, 0, earlier);
  await assert.rejects(f.complete(batch.id, [last.sha256, first.sha256]), errorStatus(409));
  const result = await f.complete(batch.id, [first.sha256, last.sha256]);
  assert.deepEqual(result, { id: batch.id, state: 'completed', rowCount: 3, receivedRows: 3 });
  assert.deepEqual(await f.complete(batch.id, [first.sha256, last.sha256]), result);
  assert.equal((await f.chunk(batch.id, 0, earlier)).state, 'completed');
  await assert.rejects(f.complete(batch.id, []), errorStatus(409));
  await assert.rejects(f.chunk(batch.id, 0, [row('first', { modified: true })]), errorStatus(409));
  await assert.rejects(f.chunk(batch.id, 2, [row('new')]), errorStatus(409));
  const output = f.manager.export(batch.id);
  assert.equal(output.batch.customerName, '惠州虚构测试单位');
  assert.equal(output.batch.systemName, '虚构政务业务');
  assert.equal(output.batch.matterName, '虚构测试事项');
  assert.deepEqual([...output.rows].map(value => [value.rowNo, value.recordKey]), [[1, 'first'], [2, 'second'], [3, 'late']]);
  const detail = f.manager.detail(batch.id, query({ page: 2, pageSize: 2 }));
  assert.equal(detail.total, 3); assert.equal(detail.rows[0].rowNo, 3); assert.deepEqual(detail.rows[0].data, later[0].data);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM return_batches').get().n, 1);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM return_batch_events WHERE action=?').get('return_batch.completed').n, 1);
  assert(f.scopes.every(scope => scope.systemId === request.systemId && scope.matterId === request.matterId));
});

test('failed receipt transaction rolls back all rows, chunk identity, counters, and audit; exact retry succeeds once', async t => {
  const f = fixture(t), batch = await f.begin(metadata(2)), rows = [row('a'), row('b')];
  f.audit((_owner, action) => { if (action === 'return_batch.chunk_received') throw new Error('synthetic interrupted transaction'); });
  await assert.rejects(f.chunk(batch.id, 0, rows), /synthetic interrupted transaction/);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM return_batch_rows').get().n, 0);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM return_batch_chunks').get().n, 0);
  assert.equal(f.database.prepare('SELECT received_rows FROM return_batches WHERE id=?').get(batch.id).received_rows, 0);
  f.audit();
  const chunk = await f.chunk(batch.id, 0, rows);
  assert.equal(chunk.receivedRows, 2);
  assert.deepEqual(await f.chunk(batch.id, 0, rows), chunk);
  f.audit((_owner, action) => { if (action === 'return_batch.completed') throw new Error('synthetic completion rollback'); });
  await assert.rejects(f.complete(batch.id, [chunk.sha256]), /synthetic completion rollback/);
  assert.equal(f.manager.detail(batch.id).batch.state, 'uploading');
  f.audit();
  assert.equal((await f.complete(batch.id, [chunk.sha256])).state, 'completed');
});

test('each ingestion operation reauthorizes its matter and isolates device, license, customer and idempotency identities', async t => {
  const f = fixture(t), request = metadata(), batch = await f.begin(request);
  f.revoke();
  await assert.rejects(f.begin(request), errorStatus(403));
  await assert.rejects(f.chunk(batch.id, 0, [row('a')]), errorStatus(403));
  await assert.rejects(f.complete(batch.id, []), errorStatus(403));
  f.revoke(false);
  f.owner({ ...baseOwner, deviceId: otherDevice });
  await assert.rejects(f.chunk(batch.id, 0, [row('a')], { deviceId: otherDevice }), errorStatus(404));
  await assert.rejects(f.complete(batch.id, [], { deviceId: otherDevice }), errorStatus(404));
  const otherBatch = await f.begin({ ...request, deviceId: otherDevice });
  assert.notEqual(otherBatch.id, batch.id);
  f.owner({ ...baseOwner, customerId: 'second-customer', licenseId: 'second-license' });
  await assert.rejects(f.chunk(batch.id, 0, [row('a')]), errorStatus(404));
  const otherLicenseBatch = await f.begin(request);
  assert.notEqual(otherLicenseBatch.id, batch.id);
  f.owner({ ...baseOwner, customerId: 'second-customer' });
  await assert.rejects(f.begin(request), errorStatus(409));
  f.owner(baseOwner);
  await assert.rejects(f.begin({ ...request, systemId: 'guangdong-hrss' }), errorStatus(409));
  await assert.rejects(f.begin({ ...request, rowCount: 2 }), errorStatus(409));
  await assert.rejects(f.begin({ ...request, finishedAt: request.finishedAt + 1 }), errorStatus(409));
  assert.equal((await f.begin(request)).id, batch.id);
  assert.equal(f.manager.detail(batch.id).total, 0);
});

test('empty batches complete explicitly while duplicate, missing and over-declared rows never become completed data', async t => {
  const f = fixture(t), empty = await f.begin(metadata(0));
  assert.throws(() => f.manager.export(empty.id), errorStatus(409));
  await assert.rejects(f.chunk(empty.id, 0, [row('a')]), errorStatus(409));
  assert.equal((await f.complete(empty.id, [])).state, 'completed');
  assert.deepEqual([...f.manager.export(empty.id).rows], []);
  const batch = await f.begin(metadata(3));
  await assert.rejects(f.chunk(batch.id, 0, [row('a'), row('a')]), errorStatus(409));
  const first = await f.chunk(batch.id, 0, [row('a')]);
  await assert.rejects(f.chunk(batch.id, 1, [row('b'), row('a')]), errorStatus(409));
  assert.equal(f.manager.detail(batch.id).total, 1);
  await assert.rejects(f.chunk(batch.id, 1, [row('b'), row('c'), row('d')]), errorStatus(409));
  const last = await f.chunk(batch.id, 2, [row('b'), row('c')]);
  await assert.rejects(f.complete(batch.id, [first.sha256, last.sha256]), errorStatus(409));
  assert.equal(f.manager.detail(batch.id).batch.state, 'uploading');
  await assert.rejects(f.chunk(batch.id, 3, [row('d')]), errorStatus(409));
});

test('invalid protocol bodies, unsafe identifiers and excessive data are rejected before any write', async t => {
  const f = fixture(t), good = metadata();
  for (const extra of [ { rowCount: RETURN_MAX_ROWS + 1 }, { rowCount: -1 }, { rowCount: 1.5 }, { clientBatchId: '../business' },
    { startedAt: good.finishedAt + 1 }, { finishedAt: Infinity }, { schema: 2 }, { systemId: 123 }, { matterId: 'bad/matter' },
    { customerId: 'attacker' }, { deviceId: 'invalid' } ]) {
    await assert.rejects(f.begin({ ...good, ...extra }), error => [400, 403].includes(error.status));
  }
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM return_batches').get().n, 0);
  const batch = await f.begin(metadata(100));
  await assert.rejects(f.chunk(batch.id, 0, Array.from({ length: RETURN_MAX_CHUNK_ROWS + 1 }, (_, i) => row(String(i)))), errorStatus(400));
  await assert.rejects(f.chunk(batch.id, -1, [row('a')]), errorStatus(400));
  await assert.rejects(f.chunk(batch.id, 0, []), errorStatus(400));
  await assert.rejects(f.chunk(batch.id, 0, [row('a')], { storagePath: '../private' }), errorStatus(400));
  await assert.rejects(f.chunk(batch.id, 0, [{ ...row('a'), systemId: 'other' }]), errorStatus(400));
  await assert.rejects(f.chunk(batch.id, 0, [row('a', { tooBig: 'x'.repeat(128 * 1024) })]), errorStatus(413));
  await assert.rejects(f.chunk(batch.id, 0, Array.from({ length: 9 }, (_, i) => row(String(i), { large: 'x'.repeat(120 * 1024) }))), errorStatus(413));
  await assert.rejects(f.chunk(batch.id, 0, [row('a', { invalid: Number.NaN })]), errorStatus(400));
  await assert.rejects(f.chunk(batch.id, 0, [{ ...row('a'), updatedAt: -1 }]), errorStatus(400));
  let nested = { value: true }; for (let i = 0; i < 40; i++) nested = { nested };
  await assert.rejects(f.chunk(batch.id, 0, [row('a', nested)]), errorStatus(413));
  f.database.prepare('UPDATE return_batches SET received_bytes=? WHERE id=?').run(RETURN_MAX_BATCH_BYTES, batch.id);
  await assert.rejects(f.chunk(batch.id, 0, [row('a')]), errorStatus(413));
  await assert.rejects(f.complete(batch.id, ['invalid-sha']), errorStatus(400));
  await assert.rejects(f.complete(batch.id, [], { url: 'https://fixture.invalid' }), errorStatus(400));
  await assert.rejects(f.manager.handle('/api/returns/batches/../complete', auth), errorStatus(404));
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM return_batch_rows').get().n, 0);
});

test('admin pages count the whole result and filter literal business text without SQL or LIKE expansion', async t => {
  const f = fixture(t);
  for (let index = 0; index < 43; index++) {
    f.time(now + index);
    const request = metadata(index === 0 ? 1 : 0), batch = await f.begin(request);
    const rows = index === 0 ? [row('literal%_key', { note: "literal%_needle' OR 1=1 --", amount: 32.5 })] : [];
    const chunks = rows.length ? [(await f.chunk(batch.id, 0, rows)).sha256] : [];
    if (index !== 42) await f.complete(batch.id, chunks);
  }
  const page = f.manager.list(query({ page: 3, pageSize: 20 }));
  assert.equal(page.total, 43); assert.equal(page.rows.length, 3);
  assert.equal(f.manager.list(query({ state: 'completed' })).total, 42);
  assert.equal(f.manager.list(query({ state: 'uploading' })).total, 1);
  assert.equal(f.manager.list(query({ customerId: 'fixture-customer', deviceId, systemId: 'government-info', matterId: 'fixture-matter' })).total, 43);
  assert.equal(f.manager.list(query({ from: now + 10, to: now + 20 })).total, 11);
  assert.equal(f.manager.list(query({ keyword: '惠州虚构' })).total, 43);
  const searched = f.manager.list(query({ keyword: "%_needle' OR 1=1 --" }));
  assert.equal(searched.total, 1);
  assert.equal(f.manager.list(query({ keyword: '%' })).total, 1);
  assert.equal(f.manager.list(query({ customerId: "' OR 1=1 --" })).total, 0);
  const detail = f.manager.detail(searched.rows[0].id, query({ keyword: '%_' }));
  assert.equal(detail.total, 1); assert.equal(detail.rows[0].rowNo, 1);
  assert.equal(f.manager.detail(searched.rows[0].id, query({ keyword: 'absent' })).total, 0);
  for (const values of [{ pageSize: 101 }, { page: -1 }, { page: '1.5' }, { state: 'all' }, { from: now + 1, to: now }, { from: 'yesterday' }, { rawSql: 'SELECT *' }]) {
    assert.throws(() => f.manager.list(query(values)), errorStatus(400));
  }
  assert.throws(() => f.manager.list(new URLSearchParams('page=1&page=2')), errorStatus(400));
  assert.throws(() => f.manager.detail(searched.rows[0].id, query({ pageSize: 101 })), errorStatus(400));
  assert.throws(() => f.manager.detail(randomUUID()), errorStatus(404));
  assert.throws(() => f.manager.export('../anything'), errorStatus(400));
  const events = JSON.stringify(f.database.prepare('SELECT * FROM return_batch_events').all());
  assert(!events.includes(auth.proof.signature));
  assert(!events.includes('literal%_needle'));
  assert(!JSON.stringify(f.database.prepare('SELECT * FROM return_batches').all()).includes(auth.proof.signature));
});
