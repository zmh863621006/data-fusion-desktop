import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseDriver } from '../core/storage/database';
import type { SqlitePlatformStore } from '../core/storage/platform-store';
import type { DefaultLocalSyncEngine } from '../core/sync/engine';
import type { RuntimeTask, TaskContext, TaskEngine } from '../core/tasks/engine';
import type { BusinessSystemPlugin } from '../core/plugins/types';
import { DEFAULT_ONE_WINDOW_SCHEDULE, nextScheduleTime, parseOneWindowSchedule } from '../core/one-window/scheduler';
import { createOneWindowWorkbook, oneWindowWorkbookFilename } from '../core/one-window/workbook';
import type { OneWindowBatch, OneWindowFilters, OneWindowPlan, OneWindowState } from '../core/one-window/types';
import { validateFilters } from '../core/query/validation';

interface ScheduleRow {
  matter_id: string; schedule_json: string; filters_json: string;
  next_run_at: number | null; last_run_at: number | null;
}
interface BatchRow {
  task_id: string; matter_id: string; created_at: number; total: number; partial_count: number;
  file_name: string; file_path: string; sha256: string | null; upload_status: OneWindowBatch['uploadStatus'];
  upload_error: string | null; uploaded_at: number | null; receipt_json: string | null; attempted_at: number | null;
}
interface UploadReceipt { uploadId: string }
interface ServiceOptions {
  database: DatabaseDriver;
  platformStore: SqlitePlatformStore;
  syncEngine: DefaultLocalSyncEngine;
  plugin: BusinessSystemPlugin;
  tasks: TaskEngine;
  exportDirectory: string;
  authorize(matterId: string, automatic?: boolean, requireExport?: boolean): Promise<void>;
  upload(input: { taskId: string; matterId: string; fileName: string; bytes: Buffer }, signal?: AbortSignal): Promise<UploadReceipt>;
  businessOperation<T>(operation: () => Promise<T>): Promise<T>;
  now?: () => number;
}

const defaultFilters = (): OneWindowFilters => ({ dateType: 'all', startDate: '', endDate: '', state: '' });
const batchFromRow = (row: BatchRow): OneWindowBatch => ({
  taskId: row.task_id, matterId: row.matter_id, createdAt: row.created_at, total: row.total,
  partialCount: row.partial_count, fileName: row.file_name, filePath: row.file_path,
  uploadStatus: row.upload_status, uploadError: row.upload_error, uploadedAt: row.uploaded_at,
  objectKey: row.receipt_json ? JSON.parse(row.receipt_json).objectKey ?? null : null,
});

/** Owns the local collection/upload lifecycle, including work that outlives a renderer page. */
export class OneWindowService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopped = false;
  private authenticated = false;
  private readonly collecting = new Set<string>();
  private readonly uploading = new Map<string, AbortController>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly now: () => number;

  constructor(private readonly options: ServiceOptions) { this.now = options.now ?? Date.now; }

  async initialize(): Promise<void> {
    await this.options.database.exec(`
      CREATE TABLE IF NOT EXISTS one_window_schedules(
        matter_id TEXT PRIMARY KEY, schedule_json TEXT NOT NULL, filters_json TEXT NOT NULL,
        next_run_at INTEGER, last_run_at INTEGER);
      CREATE TABLE IF NOT EXISTS one_window_batches(
        task_id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        total INTEGER NOT NULL, partial_count INTEGER NOT NULL, file_name TEXT NOT NULL,
        file_path TEXT NOT NULL, sha256 TEXT, upload_status TEXT NOT NULL,
        upload_error TEXT, uploaded_at INTEGER, receipt_json TEXT, attempted_at INTEGER);
      CREATE INDEX IF NOT EXISTS one_window_batch_matter ON one_window_batches(matter_id,created_at DESC);
    `);
    await this.options.database.run(`UPDATE one_window_batches SET upload_status='failed',
      upload_error='上次推送被中断，将自动重试' WHERE upload_status='uploading'`);
  }

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, 10_000);
    this.timer.unref();
  }

  private matter(matterId: string) {
    const matter = this.options.plugin.matters.find(item => item.id === matterId);
    if (!matter) throw new Error('一窗平台业务事项无效');
    return matter;
  }

  private filters(matterId: string, input: unknown): OneWindowFilters {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('回流条件格式无效');
    const values = input as Record<string, unknown>;
    validateFilters(this.matter(matterId).querySchema, values);
    const filters = { ...defaultFilters(), ...values } as OneWindowFilters;
    if (!['all', 'received', 'finished'].includes(filters.dateType)) throw new Error('日期类型无效');
    for (const value of [filters.startDate, filters.endDate]) {
      if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error('回流日期无效');
    }
    if (filters.dateType !== 'all' && (!filters.startDate || !filters.endDate || filters.startDate > filters.endDate)) {
      throw new Error('请选择完整的回流日期范围，开始日期应早于结束日期');
    }
    if (filters.dateType === 'all') { filters.startDate = ''; filters.endDate = ''; }
    return filters;
  }

  async plan(matterId: string): Promise<OneWindowPlan> {
    this.matter(matterId);
    const row = await this.options.database.get<ScheduleRow>('SELECT * FROM one_window_schedules WHERE matter_id=?', [matterId]);
    return row ? { matterId, schedule: parseOneWindowSchedule(JSON.parse(row.schedule_json)),
      filters: this.filters(matterId, JSON.parse(row.filters_json)), nextRunAt: row.next_run_at, lastRunAt: row.last_run_at }
      : { matterId, schedule: { ...DEFAULT_ONE_WINDOW_SCHEDULE }, filters: defaultFilters(), nextRunAt: null, lastRunAt: null };
  }

  async savePlan(matterId: string, value: unknown): Promise<OneWindowPlan> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('定时设置格式无效');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !['schedule', 'filters'].includes(key))) throw new Error('定时设置包含未知字段');
    const schedule = parseOneWindowSchedule(input.schedule);
    await this.options.authorize(matterId, schedule.enabled || schedule.loginAutoRun, schedule.enabled || schedule.loginAutoRun);
    const filters = this.filters(matterId, input.filters);
    const next = schedule.enabled ? nextScheduleTime(schedule, this.now()) : null;
    await this.options.database.run(`INSERT INTO one_window_schedules(matter_id,schedule_json,filters_json,next_run_at)
      VALUES(?,?,?,?) ON CONFLICT(matter_id) DO UPDATE SET schedule_json=excluded.schedule_json,
      filters_json=excluded.filters_json,next_run_at=excluded.next_run_at`,
    [matterId, JSON.stringify(schedule), JSON.stringify(filters), next]);
    return this.plan(matterId);
  }

  async state(matterId: string, page = 1): Promise<OneWindowState> {
    await this.options.authorize(matterId);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new Error('批次页码无效');
    const [plan, rows, count, session] = await Promise.all([
      this.plan(matterId), this.options.database.all<BatchRow>('SELECT * FROM one_window_batches WHERE matter_id=? ORDER BY created_at DESC,task_id DESC LIMIT 20 OFFSET ?', [matterId, (page - 1) * 20]),
      this.options.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM one_window_batches WHERE matter_id=?', [matterId]),
      this.options.plugin.getSessionState(),
    ]);
    return { plan, batches: rows.map(batchFromRow), batchTotal: count?.count ?? 0,
      running: this.collecting.has(matterId), sessionStatus: session.status };
  }

  async records(matterId: string, input: { batchId?: string; keyword?: string; page?: number; pageSize?: number }) {
    await this.options.authorize(matterId);
    if (input.batchId) {
      const batch = await this.batch(input.batchId);
      if (batch.matter_id !== matterId) throw new Error('批次与当前业务不匹配');
      return this.options.platformStore.listTaskOutput(input.batchId, input.page, input.pageSize, input.keyword);
    }
    return this.options.platformStore.listRecords({ systemId: this.options.plugin.id, matterId, keyword: input.keyword, page: input.page, pageSize: input.pageSize });
  }

  run(matterId: string, filtersInput: unknown, automatic = false): Promise<RuntimeTask> {
    if (this.stopped) return Promise.reject(new Error('应用正在退出'));
    if (this.collecting.has(matterId)) return Promise.reject(new Error('当前事项正在回流，请等待完成'));
    this.collecting.add(matterId);
    const operation = this.options.businessOperation(async () => {
      await this.options.authorize(matterId, automatic, true);
      const filters = this.filters(matterId, filtersInput);
      const session = await this.options.plugin.getSessionState({ force: true });
      if (session.status !== 'authenticated') throw new Error(session.message ?? '请先在原系统标签页完成登录');
      return this.options.tasks.run(`一窗业务详情回流 · ${this.matter(matterId).name}`,
        context => this.collect(matterId, filters, context),
        { type: 'data-return', systemId: this.options.plugin.id, matterId, details: { ...filters, trigger: automatic ? 'schedule' : 'manual' } });
    }).finally(() => { this.collecting.delete(matterId); this.operations.delete(operation); });
    this.operations.add(operation);
    return operation;
  }

  private async collect(matterId: string, filters: OneWindowFilters, context: TaskContext) {
    const { plugin, platformStore, database, syncEngine } = this.options;
    const matter = this.matter(matterId);
    const result = await matter.query({ page: 1, pageSize: 100, filters: { ...filters }, signal: context.signal, onProgress: context.report });
    context.signal.throwIfAborted();
    await this.options.authorize(matterId, false, true);
    const summary = await syncEngine.preview(plugin.id, matterId, matter.uniqueKey, result.rows, matter.mergeRecord);
    const rows = summary.changes.map(change => change.current);
    const collectedAt = this.now();
    const fileName = oneWindowWorkbookFilename({ businessName: matter.name, batchId: context.taskId,
      startDate: filters.startDate, endDate: filters.endDate, collectedAt });
    const partialCount = rows.filter(row => row.detailStatus !== 'complete').length;
    await database.transaction(async () => {
      context.signal.throwIfAborted();
      await this.options.authorize(matterId, false, true);
      await syncEngine.commit(plugin.id, matterId, summary);
      await platformStore.replaceTaskOutput(context.taskId, plugin.id, matterId,
        summary.changes.map(change => ({ recordKey: change.key, data: change.current })));
      await database.run(`INSERT INTO one_window_batches(task_id,matter_id,created_at,total,partial_count,file_name,file_path,upload_status)
        VALUES(?,?,?,?,?,?,?,'pending')`, [context.taskId, matterId, collectedAt, rows.length, partialCount, fileName, '']);
      context.signal.throwIfAborted();
    });
    context.report({ current: rows.length, total: rows.length, message: '业务详情已保存，正在生成 Excel 并推送' });
    try { await this.uploadBatch(context.taskId, context.signal); }
    catch {
      // Upload errors are recorded on the immutable local batch and retried separately.
      context.signal.throwIfAborted();
    }
    const batch = await this.batch(context.taskId);
    context.report({ current: rows.length, total: rows.length,
      message: batch.upload_status === 'uploaded' ? `已回流 ${rows.length} 条，Excel 已推送至后台`
        : `已回流 ${rows.length} 条，Excel 待重新推送` });
    return { total: rows.length, partialCount, uploadStatus: batch.upload_status, taskId: context.taskId };
  }

  private async batch(taskId: string): Promise<BatchRow> {
    const row = await this.options.database.get<BatchRow>('SELECT * FROM one_window_batches WHERE task_id=?', [taskId]);
    if (!row) throw new Error('回流批次不存在');
    return row;
  }

  async retry(taskId: string): Promise<OneWindowBatch> {
    const batch = await this.batch(taskId);
    await this.options.authorize(batch.matter_id, false, true);
    const operation = this.options.businessOperation(async () => {
      await this.uploadBatch(taskId);
      return batchFromRow(await this.batch(taskId));
    }).finally(() => this.operations.delete(operation));
    this.operations.add(operation);
    return operation;
  }

  private async uploadBatch(taskId: string, parentSignal?: AbortSignal): Promise<void> {
    if (this.stopped) throw new Error('应用正在退出');
    if (this.uploading.has(taskId)) throw new Error('该批次正在推送');
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    if (parentSignal?.aborted) controller.abort();
    this.uploading.set(taskId, controller);
    const { database, platformStore } = this.options;
    try {
      const batch = await this.batch(taskId);
      if (batch.upload_status === 'uploaded') return;
      await this.options.authorize(batch.matter_id, false, true);
      await database.run("UPDATE one_window_batches SET upload_status='uploading',upload_error=NULL,attempted_at=? WHERE task_id=?", [this.now(), taskId]);
      controller.signal.throwIfAborted();
      let bytes: Buffer;
      const root = resolve(this.options.exportDirectory);
      await mkdir(root, { recursive: true });
      if ((await lstat(root)).isSymbolicLink()) throw new Error('导出目录不能是链接');
      if (batch.file_path) {
        const path = resolve(batch.file_path);
        if (dirname(path) !== root || (await lstat(path)).isSymbolicLink()) throw new Error('批次文件位置无效');
        bytes = await readFile(path);
        if (createHash('sha256').update(bytes).digest('hex') !== batch.sha256) throw new Error('本地 Excel 已修改，请保留原批次文件后推送');
      } else {
        const records = await platformStore.taskRowsForExport(taskId);
        if (records.length !== batch.total) throw new Error('本地批次数据不完整');
        bytes = await createOneWindowWorkbook(records.map(row => row.data), {
          businessName: this.matter(batch.matter_id).name, batchId: taskId, collectedAt: batch.created_at,
        });
        controller.signal.throwIfAborted();
        let path = join(root, batch.file_name);
        try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          // A crash after file creation can leave an unregistered file. Preserve it and save a fresh copy.
          path = join(root, batch.file_name.slice(0, -5) + '-' + randomUUID().slice(0, 8) + '.xlsx');
          await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
        }
        await database.run('UPDATE one_window_batches SET file_path=?,sha256=? WHERE task_id=?',
          [path, createHash('sha256').update(bytes).digest('hex'), taskId]);
      }
      controller.signal.throwIfAborted();
      await this.options.authorize(batch.matter_id, false, true);
      const receipt = await this.options.upload({ taskId, matterId: batch.matter_id, fileName: batch.file_name, bytes }, controller.signal);
      await database.run("UPDATE one_window_batches SET upload_status='uploaded',upload_error=NULL,uploaded_at=?,receipt_json=? WHERE task_id=?",
        [this.now(), JSON.stringify(receipt), taskId]);
    } catch (error) {
      const message = controller.signal.aborted ? '推送已中断，保存的批次可继续推送'
        : error instanceof Error ? error.message : 'Excel 推送失败';
      // The uploader and source adapter return fixed, credential-free error messages.
      await database.run("UPDATE one_window_batches SET upload_status='failed',upload_error=? WHERE task_id=?", [message.slice(0, 500), taskId]);
      throw error;
    } finally {
      parentSignal?.removeEventListener('abort', abort);
      this.uploading.delete(taskId);
    }
  }

  async folder(taskId: string): Promise<string> {
    const batch = await this.batch(taskId);
    await this.options.authorize(batch.matter_id, false, true);
    const root = resolve(this.options.exportDirectory);
    if (!batch.file_path || dirname(resolve(batch.file_path)) !== root) throw new Error('本批次尚未生成 Excel');
    const info = await lstat(batch.file_path);
    if (!info.isFile() || info.isSymbolicLink() || dirname(await realpath(batch.file_path)) !== await realpath(root)) throw new Error('批次文件位置无效');
    return root;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const retry = await this.options.database.get<BatchRow>(`SELECT b.* FROM one_window_batches b
        JOIN runtime_tasks t ON t.id=b.task_id WHERE b.upload_status IN ('pending','failed') AND t.status!='cancelled'
        AND (b.attempted_at IS NULL OR b.attempted_at<?) ORDER BY b.created_at LIMIT 1`, [this.now() - 5 * 60_000]);
      if (this.stopped) return;
      if (retry && !this.uploading.has(retry.task_id)) {
        await this.retry(retry.task_id).catch(() => {});
      }
      const plans = await Promise.all(this.options.plugin.matters.map(matter => this.plan(matter.id)));
      if (!plans.some(plan => plan.schedule.enabled || plan.schedule.loginAutoRun)) return;
      const session = await this.options.plugin.getSessionState();
      if (this.stopped) return;
      if (session.status === 'logged-out' || session.status === 'expired') this.authenticated = false;
      if (session.status !== 'authenticated') return;
      const loggedIn = !this.authenticated;
      this.authenticated = true;
      for (const plan of plans) {
        if (this.collecting.has(plan.matterId)) continue;
        const due = plan.schedule.enabled && (plan.nextRunAt === null || plan.nextRunAt <= this.now());
        if (!due && !(loggedIn && plan.schedule.loginAutoRun)) continue;
        try { await this.options.authorize(plan.matterId, true); }
        catch { continue; }
        // Reserve the next occurrence before queuing work so navigation cannot enqueue it twice.
        await this.options.database.run('UPDATE one_window_schedules SET next_run_at=?,last_run_at=? WHERE matter_id=?',
          [plan.schedule.enabled ? nextScheduleTime(plan.schedule, this.now()) : null, this.now(), plan.matterId]);
        const task = this.run(plan.matterId, plan.filters, true);
        void task.catch(() => {});
      }
    } catch { /* A background failure is retried on the next tick; batch failures remain visible. */ }
    finally { this.ticking = false; }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    for (const task of this.options.tasks.list()) {
      if (task.systemId === this.options.plugin.id && ['queued', 'running'].includes(task.status)) this.options.tasks.cancel(task.id);
    }
    for (const controller of this.uploading.values()) controller.abort();
    await Promise.allSettled([...this.operations]);
  }
}
