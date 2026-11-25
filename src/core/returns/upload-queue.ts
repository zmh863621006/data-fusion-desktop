import { createHash } from 'node:crypto';
import type { DatabaseDriver } from '../storage/database';
import type { SignedLicenseEnvelope } from '../license/signed-license';

type Authorization = { proof: SignedLicenseEnvelope; deviceId: string };
type Owner = { licenseId: string; deviceId: string; customerId: string };
export interface ReturnUploadRow { recordKey: string; data: Record<string, unknown>; firstSeenAt: number; updatedAt: number }
export interface ReturnUploadBatch {
  clientBatchId: string; systemId: string; matterId: string; startedAt: number; finishedAt: number; rows: ReturnUploadRow[];
}
interface BatchRow {
  id: string; system_id: string; matter_id: string; started_at: number; finished_at: number; row_count: number;
  license_id: string; device_id: string; customer_id: string; state: string; attempts: number;
}
export interface ReturnUploadState {
  enabled: boolean; pending: number; completed: number; blocked: number; sending: boolean; lastError?: string;
}
class UploadError extends Error {
  constructor(message: string, readonly retryable = true) { super(message); }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ROW_BYTES = 128 * 1024, CHUNK_BYTES = 768 * 1024, MAX_ROWS = 50_000;
const identity = (authorization: Authorization): Owner => {
  const grant = JSON.parse(Buffer.from(authorization.proof.payload, 'base64url').toString('utf8'));
  if (typeof grant.licenseId !== 'string' || !grant.licenseId || typeof grant.customerId !== 'string'
    || grant.deviceId !== authorization.deviceId || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) {
    throw new UploadError('请刷新当前设备授权后重试', false);
  }
  return { licenseId: grant.licenseId, customerId: grant.customerId, deviceId: authorization.deviceId };
};

/** Main-process durable outbox. Proofs and source-system sessions never enter SQLite or the renderer. */
export class ReturnUploadQueue {
  private readonly origin: string;
  private timer?: ReturnType<typeof setInterval>;
  private operation?: Promise<void>;
  private stopped = false;
  private readonly controller = new AbortController();
  private error?: string;
  constructor(private readonly database: DatabaseDriver, endpoint: string,
    private readonly authorization: () => Promise<Authorization | null>,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    const url = new URL(endpoint);
    if (url.origin !== endpoint || url.username || url.password || url.protocol !== 'https:'
      && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('回流后台地址无效');
    this.origin = url.origin;
  }
  async initialize(): Promise<void> {
    await this.database.exec(`CREATE TABLE IF NOT EXISTS return_upload_outbox (
      id TEXT PRIMARY KEY, origin TEXT NOT NULL, license_id TEXT NOT NULL, customer_id TEXT NOT NULL, device_id TEXT NOT NULL,
      system_id TEXT NOT NULL, matter_id TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
      row_count INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, completed_at INTEGER);
      CREATE TABLE IF NOT EXISTS return_upload_outbox_rows (
      batch_id TEXT NOT NULL, row_no INTEGER NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY(batch_id,row_no));
      CREATE INDEX IF NOT EXISTS return_upload_outbox_pending ON return_upload_outbox(origin,license_id,device_id,state,next_attempt_at);`);
  }
  async capture(batch: ReturnUploadBatch): Promise<void> {
    if (!uuid.test(batch.clientBatchId)) throw new Error('回流批次标识无效');
    const auth = await this.authorization();
    if (!auth) throw new UploadError('请刷新当前设备授权后重试', false);
    const owner = identity(auth);
    await this.database.transaction(async () => {
      const previous = await this.database.get<{ origin: string; license_id: string; device_id: string }>('SELECT origin,license_id,device_id FROM return_upload_outbox WHERE id=?', [batch.clientBatchId]);
      if (previous) {
        if (previous.origin !== this.origin || previous.license_id !== owner.licenseId || previous.device_id !== owner.deviceId) throw new UploadError('该批次属于其他授权或后台，未转移数据', false);
        return;
      }
      const encoded = batch.rows.map(row => JSON.stringify(row));
      const oversized = encoded.some(row => Buffer.byteLength(row) > ROW_BYTES) || batch.rows.length > MAX_ROWS
        || encoded.reduce((sum, row) => sum + Buffer.byteLength(row), 0) > 256 * 1024 * 1024;
      await this.database.run(`INSERT INTO return_upload_outbox(id,origin,license_id,customer_id,device_id,system_id,matter_id,started_at,finished_at,row_count,state,last_error)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [batch.clientBatchId, this.origin, owner.licenseId, owner.customerId, owner.deviceId, batch.systemId,
        batch.matterId, batch.startedAt, batch.finishedAt, batch.rows.length, oversized ? 'blocked' : 'pending', oversized ? '批次超过上传限制，本地数据已保留' : undefined]);
      // Oversized batches stay local and visible as blocked, without duplicating an unbounded payload.
      if (!oversized) for (let index = 0; index < encoded.length; index++) {
        await this.database.run('INSERT INTO return_upload_outbox_rows(batch_id,row_no,row_json) VALUES(?,?,?)', [batch.clientBatchId, index, encoded[index]]);
      }
    });
  }
  async hasCaptured(clientBatchId: string): Promise<boolean> {
    // Include foreign owners: historical data already attributed elsewhere must never be relabelled.
    return Boolean(await this.database.get('SELECT 1 AS present FROM return_upload_outbox WHERE id=?', [clientBatchId]));
  }
  async batchState(clientBatchId: string): Promise<{ state: 'pending' | 'completed' | 'blocked'; lastError?: string; completedAt?: number }> {
    const auth = await this.authorization(); if (!auth) return { state: 'blocked', lastError: '请刷新授权后同步' };
    const owner = identity(auth);
    const row = await this.database.get<{ state: 'pending' | 'completed' | 'blocked'; last_error: string | null; completed_at: number | null }>(
      'SELECT state,last_error,completed_at FROM return_upload_outbox WHERE id=? AND origin=? AND license_id=? AND device_id=?',
      [clientBatchId, this.origin, owner.licenseId, owner.deviceId]);
    return row ? { state: row.state, ...(row.last_error ? { lastError: row.last_error } : {}), ...(row.completed_at ? { completedAt: row.completed_at } : {}) }
      : { state: 'blocked', lastError: '此批次尚未加入当前授权的数据同步队列，可核对后补传历史批次' };
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.flush(); }, 30_000); this.timer.unref?.();
    void this.flush();
  }
  async snapshot(): Promise<ReturnUploadState> {
    const auth = await this.authorization().catch(() => null);
    let owner: Owner | undefined;
    try { if (auth) owner = identity(auth); } catch { /* No data from another license is shown. */ }
    if (!owner) return { enabled: true, pending: 0, completed: 0, blocked: 0, sending: Boolean(this.operation), lastError: '请激活或刷新授权后同步' };
    const rows = await this.database.all<{ state: string; count: number }>(`SELECT state,COUNT(*) AS count FROM return_upload_outbox
      WHERE origin=? AND license_id=? AND device_id=? GROUP BY state`, [this.origin, owner.licenseId, owner.deviceId]);
    const counts = Object.fromEntries(rows.map(row => [row.state, row.count]));
    const latest = await this.database.get<{ last_error: string }>(`SELECT last_error FROM return_upload_outbox
      WHERE origin=? AND license_id=? AND device_id=? AND state!='completed' AND last_error IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
    [this.origin, owner.licenseId, owner.deviceId]);
    return { enabled: true, pending: counts.pending ?? 0, completed: counts.completed ?? 0, blocked: counts.blocked ?? 0,
      sending: Boolean(this.operation), lastError: latest?.last_error ?? this.error };
  }
  async retry(): Promise<ReturnUploadState> {
    const auth = await this.authorization(); if (!auth) throw new Error('请激活或刷新授权后同步');
    const owner = identity(auth);
    await this.database.run(`UPDATE return_upload_outbox SET state='pending',next_attempt_at=0,last_error=NULL
      WHERE origin=? AND license_id=? AND device_id=? AND state!='completed'
      AND row_count=(SELECT COUNT(*) FROM return_upload_outbox_rows WHERE batch_id=return_upload_outbox.id)`,
    [this.origin, owner.licenseId, owner.deviceId]);
    await this.flush(); return this.snapshot();
  }
  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.operation) return this.operation;
    this.operation = this.perform().catch(() => { this.error = '后台同步暂不可用，本地数据已保留'; }).finally(() => { this.operation = undefined; });
    return this.operation;
  }
  private async request(path: string, body?: Record<string, unknown>, owner?: Owner): Promise<Record<string, any>> {
    if (this.stopped) throw new UploadError('同步已中断，本地数据已保留');
    let auth: Authorization | null = null;
    if (body) {
      auth = await this.authorization();
      const current = auth && identity(auth);
      if (!current || !owner || current.licenseId !== owner.licenseId || current.deviceId !== owner.deviceId || current.customerId !== owner.customerId) throw new UploadError('授权已变更，原批次留在本机等待核对', false);
    }
    const abort = new AbortController(), onStop = () => abort.abort();
    this.controller.signal.addEventListener('abort', onStop, { once: true });
    const timer = setTimeout(() => abort.abort(), 20_000);
    try {
      const response = await this.fetcher(this.origin + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: abort.signal,
        headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify({ ...body, ...auth }) : undefined });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new UploadError([401, 403].includes(response.status) ? '设备或事项授权已变更，请刷新授权后重试'
          : response.status === 409 ? '批次校验不一致，请联系管理员核对，本地数据已保留'
            : '后台同步暂不可用，本地数据已保留', [408, 429].includes(response.status) || response.status >= 500);
      }
      const reader = response.body?.getReader(); if (!reader) throw new UploadError('后台未返回有效同步结果');
      let size = 0; const parts: Buffer[] = [];
      try {
        for (;;) { const part = await reader.read(); if (part.done) break;
          size += part.value.length; if (size > 64 * 1024) throw new UploadError('后台同步结果超过限制'); parts.push(Buffer.from(part.value)); }
      } finally { await reader.cancel().catch(() => {}); }
      const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UploadError('后台同步结果无效');
      return value;
    } catch (error) {
      if (error instanceof UploadError) throw error;
      throw new UploadError('后台同步连接中断，本地数据已保留');
    } finally { clearTimeout(timer); this.controller.signal.removeEventListener('abort', onStop); }
  }
  private async perform(): Promise<void> {
    const auth = await this.authorization(); if (!auth) return;
    const owner = identity(auth);
    const capabilities = await this.request('/api/returns/capabilities');
    if (capabilities.schema !== 1 || capabilities.enabled !== true) { this.error = '后台尚未启用数据接收，本地数据已保留'; return; }
    this.error = undefined;
    const batches = await this.database.all<BatchRow>(`SELECT * FROM return_upload_outbox WHERE origin=? AND license_id=? AND device_id=?
      AND state='pending' AND next_attempt_at<=? ORDER BY finished_at,id LIMIT 10`, [this.origin, owner.licenseId, owner.deviceId, this.now()]);
    for (const batch of batches) {
      if (this.stopped) return;
      try {
        await this.send(batch, owner);
        await this.database.transaction(async () => {
          await this.database.run("UPDATE return_upload_outbox SET state='completed',completed_at=?,last_error=NULL WHERE id=?", [this.now(), batch.id]);
          await this.database.run('DELETE FROM return_upload_outbox_rows WHERE batch_id=?', [batch.id]);
        });
      } catch (error) {
        if (this.stopped) return;
        const e = error instanceof UploadError ? error : new UploadError('后台同步暂不可用，本地数据已保留');
        await this.database.run('UPDATE return_upload_outbox SET state=?,attempts=attempts+1,next_attempt_at=?,last_error=? WHERE id=?',
          [e.retryable ? 'pending' : 'blocked', this.now() + Math.min(300_000, 10_000 * 2 ** Math.min(batch.attempts, 5)), e.message, batch.id]);
      }
    }
  }
  private async send(batch: BatchRow, owner: Owner): Promise<void> {
    const begin = await this.request('/api/returns/batches', { clientBatchId: batch.id, systemId: batch.system_id,
      matterId: batch.matter_id, startedAt: batch.started_at, finishedAt: batch.finished_at, rowCount: batch.row_count }, owner);
    const validReceipt = (receipt: Record<string, any>, id: string) => receipt.id === id && receipt.rowCount === batch.row_count
      && Number.isSafeInteger(receipt.receivedRows) && receipt.receivedRows >= 0 && receipt.receivedRows <= batch.row_count;
    if (!uuid.test(begin.id) || !validReceipt(begin, begin.id) || !['uploading', 'completed'].includes(begin.state)) throw new UploadError('后台批次信息不一致', false);
    if (begin.state === 'completed') {
      if (begin.receivedRows !== batch.row_count) throw new UploadError('后台确认的记录数不一致', false);
      return;
    }
    const manifests: string[] = []; let offset = 0, sent = 0;
    let chunk: ReturnUploadRow[] = [], bytes = 2;
    const sendChunk = async () => {
      if (!chunk.length) return;
      const sha256 = digest(JSON.stringify(chunk)), index = manifests.length;
      const receipt = await this.request(`/api/returns/batches/${begin.id}/chunks`, { index, rows: chunk }, owner);
      if (receipt.id !== begin.id || receipt.index !== index || receipt.sha256 !== sha256 || receipt.state !== 'uploading'
        || !Number.isSafeInteger(receipt.receivedRows) || receipt.receivedRows < sent + chunk.length || receipt.receivedRows > batch.row_count) throw new UploadError('后台分块校验结果不一致', false);
      sent += chunk.length; manifests.push(sha256); chunk = []; bytes = 2;
    };
    for (;;) {
      const rows = await this.database.all<{ row_json: string }>('SELECT row_json FROM return_upload_outbox_rows WHERE batch_id=? AND row_no>=? ORDER BY row_no LIMIT 100', [batch.id, offset]);
      if (!rows.length) break;
      for (const row of rows) {
        const size = Buffer.byteLength(row.row_json) + 1;
        if (chunk.length >= 100 || bytes + size > CHUNK_BYTES) await sendChunk();
        chunk.push(JSON.parse(row.row_json)); bytes += size; offset++;
      }
    }
    await sendChunk();
    if (sent !== batch.row_count) throw new UploadError('本地批次快照不完整，请保留台账并联系管理员', false);
    const completed = await this.request(`/api/returns/batches/${begin.id}/complete`, { chunks: manifests }, owner);
    if (!validReceipt(completed, begin.id) || completed.state !== 'completed' || completed.receivedRows !== batch.row_count) throw new UploadError('后台尚未确认完整接收');
  }
  async stop(): Promise<void> {
    this.stopped = true; clearInterval(this.timer); this.controller.abort(); await this.operation;
  }
}
