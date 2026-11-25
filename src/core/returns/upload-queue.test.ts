import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { NodeSqliteDriver } from '../storage/database';
import { ReturnUploadQueue, type ReturnUploadBatch } from './upload-queue';

// Load the real receiving service through Node, including SQLite and transaction boundaries.
const { createReturnBatches } = createRequire(import.meta.url)(resolve('admin-server/return-batches.mjs'));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(intercept?: (response: Response, path: string) => Promise<Response>) {
  const root = await mkdtemp(join(tmpdir(), 'fusion-return-outbox-'));
  const remote = new DatabaseSync(':memory:');
  remote.exec(`CREATE TABLE customers(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE systems(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE licenses(id TEXT PRIMARY KEY); INSERT INTO licenses VALUES('license-a');
    CREATE TABLE system_matters(id TEXT,system_id TEXT,name TEXT,PRIMARY KEY(system_id,id)); INSERT INTO customers VALUES('customer-a','合成测试客户');
    INSERT INTO systems VALUES('fixture-system','合成系统'); INSERT INTO system_matters VALUES('fixture-matter','fixture-system','合成事项');`);
  let licenseId = 'license-a', enabled = true;
  const deviceId = 'd'.repeat(64);
  const authorization = async () => ({ deviceId, proof: { algorithm: 'RSA-SHA256' as const, signature: 'synthetic-test-only',
    payload: Buffer.from(JSON.stringify({ licenseId, deviceId, customerId: 'customer-a', expiresAt: Date.now() + 86400_000 })).toString('base64url') } });
  const receiver = createReturnBatches(remote, { authorize(body: any) {
    const grant = JSON.parse(Buffer.from(body.proof.payload, 'base64url').toString());
    if (grant.licenseId !== 'license-a') throw Object.assign(Error('forbidden'), { status: 403 });
    return { customerId: 'customer-a', licenseId: grant.licenseId, deviceId: body.deviceId };
  } });
  const requests: string[] = [], errors: string[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname; requests.push(path);
    try {
      let result;
      if (path === '/api/returns/capabilities') result = { schema: 1, enabled };
      else {
        const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
        result = await receiver.handle(path, JSON.parse(Buffer.concat(parts).toString()));
      }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error: any) { errors.push(error.stack ?? String(error)); response.writeHead(error.status ?? 500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'fixture failed' })); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const localPath = join(root, 'local.sqlite'); let local = new NodeSqliteDriver(localPath);
  const fetcher: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    return intercept ? intercept(response, new URL(String(input)).pathname) : response;
  };
  const queues: ReturnUploadQueue[] = [];
  const makeQueue = async () => { const queue = new ReturnUploadQueue(local, origin, authorization, fetcher); queues.push(queue); await queue.initialize(); return queue; };
  const queue = await makeQueue();
  cleanups.push(async () => {
    for (const q of queues) await q.stop(); await local.close();
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }); remote.close();
    expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(root.startsWith(join(tmpdir(), 'fusion-return-outbox-'))).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
  return { queue, remote, receiver, requests, errors, setLicense: (id: string) => { licenseId = id; }, setEnabled: (value: boolean) => { enabled = value; },
    reopen: async () => { await queue.stop(); await local.close(); local = new NodeSqliteDriver(localPath); return makeQueue(); },
    local: () => local };
}
const batch = (count = 205): ReturnUploadBatch => ({ clientBatchId: randomUUID(), systemId: 'fixture-system', matterId: 'fixture-matter', startedAt: 10, finishedAt: 20,
  rows: Array.from({ length: count }, (_, i) => ({ recordKey: 'record-' + i, data: { name: '合成记录' + i, nested: { status: '待受理' } }, firstSeenAt: 10, updatedAt: 20 })) });

it('persists and uploads real HTTP chunks, then reports success only after the receiver commits all rows', async () => {
  const f = await fixture(), input = batch();
  await f.queue.capture(input); await f.queue.flush();
  expect(f.errors).toEqual([]);
  expect(await f.queue.snapshot()).toMatchObject({ pending: 0, completed: 1, blocked: 0 });
  const list = f.receiver.list(new URLSearchParams()); expect(list.total).toBe(1);
  expect(list.rows[0]).toMatchObject({ state: 'completed', receivedRows: 205, rowCount: 205 });
  expect(f.receiver.detail(list.rows[0].id, new URLSearchParams('page=3&pageSize=100')).rows).toHaveLength(5);
  expect(f.requests.filter(path => path.endsWith('/chunks'))).toHaveLength(3);
  expect(await f.local().get('SELECT 1 FROM return_upload_outbox_rows LIMIT 1')).toBeUndefined();
  const stored = await f.local().get<{ metadata: string }>('SELECT sql AS metadata FROM sqlite_master WHERE name=\'return_upload_outbox\'');
  expect(stored!.metadata).not.toMatch(/proof|signature|password/);
  await f.queue.capture(input); await f.queue.retry(); expect(f.receiver.list(new URLSearchParams()).total).toBe(1);
});

it('recovers after a lost accepted chunk response and process restart without duplicate records', async () => {
  let lost = false;
  const f = await fixture(async (response, path) => {
    if (path.endsWith('/chunks') && !lost) { lost = true; await response.body?.cancel(); throw Error('simulated lost response'); }
    return response;
  });
  await f.queue.capture(batch()); await f.queue.flush();
  expect(await f.queue.snapshot()).toMatchObject({ pending: 1, completed: 0 });
  expect(f.receiver.list(new URLSearchParams()).rows[0]).toMatchObject({ receivedRows: 100, state: 'uploading' });
  const reopened = await f.reopen(); await reopened.retry();
  expect(await reopened.snapshot()).toMatchObject({ pending: 0, completed: 1 });
  expect(f.remote.prepare('SELECT COUNT(*) n FROM return_batch_rows').get()).toMatchObject({ n: 205 });
});

it('keeps disabled receivers local, supports empty batches, and retries after enablement', async () => {
  const f = await fixture(); f.setEnabled(false);
  await f.queue.capture(batch(0)); await f.queue.flush();
  expect(await f.queue.snapshot()).toMatchObject({ pending: 1, completed: 0 });
  expect(f.receiver.list(new URLSearchParams()).total).toBe(0);
  f.setEnabled(true); await f.queue.retry();
  expect(await f.queue.snapshot()).toMatchObject({ completed: 1, pending: 0 });
  expect(f.receiver.list(new URLSearchParams()).rows[0]).toMatchObject({ rowCount: 0, state: 'completed' });
});

it('never reattributes or sends a captured batch after the active license changes', async () => {
  let f: Awaited<ReturnType<typeof fixture>>, changed = false;
  f = await fixture(async (response, path) => {
    if (path.endsWith('/chunks') && !changed) { changed = true; f.setLicense('license-b'); }
    return response;
  });
  const input = batch(); await f.queue.capture(input); await f.queue.flush();
  expect(await f.queue.snapshot()).toMatchObject({ pending: 0, completed: 0, blocked: 0 });
  expect(f.receiver.list(new URLSearchParams()).rows[0]).toMatchObject({ receivedRows: 100, state: 'uploading' });
  await expect(f.queue.capture(input)).rejects.toThrow('其他授权');
  expect(await f.queue.hasCaptured(input.clientBatchId)).toBe(true);
  f.setLicense('license-a'); expect(await f.queue.snapshot()).toMatchObject({ blocked: 1, completed: 0 });
  await f.queue.retry(); expect(await f.queue.snapshot()).toMatchObject({ completed: 1, blocked: 0 });
});

it('does not accept a successful HTTP status as a complete upload when the business receipt is wrong', async () => {
  const f = await fixture(async (response, path) => {
    if (!path.endsWith('/complete')) return response;
    const value = await response.json(); return Response.json({ ...value, state: 'uploading' });
  });
  await f.queue.capture(batch(1)); await f.queue.flush();
  expect(await f.queue.snapshot()).toMatchObject({ pending: 1, completed: 0 });
  expect(await f.local().get('SELECT 1 AS present FROM return_upload_outbox_rows LIMIT 1')).toMatchObject({ present: 1 });
});

it('retains oversized batches as blocked and rolls outbox capture back with the local transaction', async () => {
  const f = await fixture(), input = batch(1); input.rows[0].data = { value: 'x'.repeat(128 * 1024) };
  await f.queue.capture(input); await f.queue.flush(); expect(await f.queue.snapshot()).toMatchObject({ blocked: 1, completed: 0 });
  expect(f.receiver.list(new URLSearchParams()).total).toBe(0);
  const rolledBack = batch(1);
  await expect(f.local().transaction(async () => { await f.queue.capture(rolledBack); throw Error('rollback local data'); })).rejects.toThrow('rollback');
  expect(await f.queue.hasCaptured(rolledBack.clientBatchId)).toBe(false);
});
