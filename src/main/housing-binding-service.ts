import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { DatabaseDriver } from '../core/storage/database';
import type { TaskContext, TaskEngine, RuntimeTask } from '../core/tasks/engine';
import { AppError } from '../core/errors/app-error';
import { parseHousingWorkbook } from '../core/housing-binding/workbook';
import { HOUSING_SYSTEM_ID, HOUSING_MATTER_ID, type HousingBindingCreate, type HousingBindingDetail, type HousingBindingJob, type HousingBindingRow, type HousingBindingState, type HousingImportPreview, type HousingJobPhase, type HousingRowStatus } from '../core/housing-binding/types';
import type { HousingBindingClient, HousingBindingTarget } from '../plugins/shenzhen-housing-rental/types';

interface JobRow { id: string; task_id: string | null; acceptance_number: string; certificate_number: string; file_name: string; phase: HousingJobPhase; created_at: number; updated_at: number; error: string | null; parent_job_id: string | null; target_json: string | null; total: number; succeeded: number; skipped: number; failed: number; pending: number }
interface Row { row_number: number; code: string; status: HousingRowStatus; message: string; updated_at: number }
interface Options {
  database: DatabaseDriver; tasks: TaskEngine; client: HousingBindingClient;
  authorize(): Promise<unknown>; session(): Promise<{ status: string }>;
}
const active = ['queued', 'running', 'waiting-login'];
const authError = (error: unknown) => error instanceof AppError && ['SESSION_EXPIRED', 'SYSTEM_LOGIN_REQUIRED'].includes(error.code);
const message = (error: unknown) => error instanceof AppError ? error.message.slice(0, 200) : '处理失败，请检查原系统后重试';
const identity = (input: unknown, label: string) => {
  if (typeof input !== 'string' || !input.trim() || input.trim().length > 128 || /[\x00-\x1f]/.test(input)) throw new Error(`${label}格式无效`);
  return input.trim();
};
const pageNumber = (input: number) => { if (!Number.isSafeInteger(input) || input < 1 || input > 100000) throw new Error('页码无效'); return input; };
const jobSelect = `SELECT j.*,COUNT(r.code) total,
 COALESCE(SUM(r.status='succeeded'),0) succeeded,COALESCE(SUM(r.status='already-bound'),0) skipped,
 COALESCE(SUM(r.status IN ('failed','unknown')),0) failed,COALESCE(SUM(r.status IN ('pending','binding')),0) pending
 FROM housing_binding_jobs j LEFT JOIN housing_binding_rows r ON r.job_id=j.id`;
const jobDto = (row: JobRow): HousingBindingJob => ({ id: row.id, taskId: row.task_id, acceptanceNumber: row.acceptance_number,
  certificateNumber: row.certificate_number, fileName: row.file_name, phase: row.phase, total: row.total, succeeded: row.succeeded,
  skipped: row.skipped, failed: row.failed, pending: row.pending, createdAt: row.created_at, updatedAt: row.updated_at, error: row.error, parentJobId: row.parent_job_id });
const rowDto = (row: Row): HousingBindingRow => ({ rowNumber: row.row_number, code: row.code, status: row.status, message: row.message, updatedAt: row.updated_at });

/** Native-owned upload snapshots and durable row outcomes. No imported row can invoke an arbitrary source method. */
export class HousingBindingService {
  private imports = new Map<string, { preview: HousingImportPreview; expires: number }>();
  private completions = new Map<string, Promise<RuntimeTask>>();
  private creationTail: Promise<unknown> = Promise.resolve();
  private authenticated = false;
  private loginWaiters = new Set<() => void>();
  private stopped = false;
  constructor(private readonly options: Options) {}

  async initialize(): Promise<void> {
    await this.options.database.exec(`CREATE TABLE IF NOT EXISTS housing_binding_jobs(
      id TEXT PRIMARY KEY,task_id TEXT,acceptance_number TEXT NOT NULL,certificate_number TEXT NOT NULL,
      file_name TEXT NOT NULL,phase TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      error TEXT,parent_job_id TEXT,target_json TEXT);
      CREATE TABLE IF NOT EXISTS housing_binding_rows(job_id TEXT NOT NULL,row_number INTEGER NOT NULL,code TEXT NOT NULL,
      status TEXT NOT NULL,message TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(job_id,row_number),UNIQUE(job_id,code),
      FOREIGN KEY(job_id) REFERENCES housing_binding_jobs(id));
      CREATE UNIQUE INDEX IF NOT EXISTS housing_binding_active_target ON housing_binding_jobs(acceptance_number,certificate_number)
      WHERE phase IN ('queued','running','waiting-login');`);
    await this.options.database.transaction(async () => {
      await this.options.database.run("UPDATE housing_binding_rows SET status='unknown',message='上次提交被中断，继续时先核对原系统关联' WHERE status='binding'");
      await this.options.database.run("UPDATE housing_binding_jobs SET phase='interrupted',error='上次任务被中断，可重试未完成项',updated_at=? WHERE phase IN ('queued','running','waiting-login')", [Date.now()]);
    });
  }

  setAuthenticated(value: boolean): void {
    this.authenticated = value;
    if (value) for (const resume of [...this.loginWaiters]) resume();
  }

  async importWorkbook(bytes: Buffer, fileName: string): Promise<HousingImportPreview> {
    await this.options.authorize();
    if (!/\.xlsx$/i.test(fileName)) throw new Error('请上传.xlsx工作簿，可先下载房屋编码模板');
    const parsed = await parseHousingWorkbook(bytes);
    const preview = { ...parsed, validCount: parsed.codes.length, importId: randomUUID(), fileName: basename(fileName) };
    for (const [id, value] of this.imports) if (value.expires < Date.now()) this.imports.delete(id);
    if (this.imports.size >= 8) this.imports.delete(this.imports.keys().next().value!);
    this.imports.set(preview.importId, { preview, expires: Date.now() + 30 * 60_000 });
    return structuredClone(preview);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.creationTail.then(work); this.creationTail = result.catch(() => undefined); return result;
  }
  create(input: HousingBindingCreate): Promise<HousingBindingJob> {
    return this.serial(async () => {
      await this.options.authorize();
      if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['acceptanceNumber', 'certificateNumber', 'importId'].includes(key))) throw new Error('绑定任务参数无效');
      const imported = this.imports.get(input.importId);
      if (!imported || imported.expires < Date.now()) throw new Error('上传清单已过期，请重新上传');
      if (imported.preview.issues.length || !imported.preview.codes.length) throw new Error('请先修正工作簿中的错误行，再创建任务');
      const result = await this.enqueue(input, imported.preview.fileName, imported.preview.codes);
      this.imports.delete(input.importId); return result;
    });
  }

  private async enqueue(input: Pick<HousingBindingCreate, 'acceptanceNumber' | 'certificateNumber'>, fileName: string,
    codes: Array<{ rowNumber: number; code: string; status?: HousingRowStatus }>, parentJobId?: string): Promise<HousingBindingJob> {
    if (this.stopped) throw new Error('应用正在退出');
    const acceptance = identity(input.acceptanceNumber, '受理编号'), certificate = identity(input.certificateNumber, '产权证号');
    if ((await this.options.session()).status !== 'authenticated') throw new Error('请先登录房屋租赁系统');
    this.setAuthenticated(true);
    const existing = await this.options.database.get('SELECT id FROM housing_binding_jobs WHERE acceptance_number=? AND certificate_number=? AND phase IN (\'queued\',\'running\',\'waiting-login\')', [acceptance, certificate]);
    if (existing) throw new Error('该办件与产权证已有未完成的绑定任务');
    const id = randomUUID(), now = Date.now();
    await this.options.database.transaction(async () => {
      await this.options.database.run("INSERT INTO housing_binding_jobs(id,acceptance_number,certificate_number,file_name,phase,created_at,updated_at,parent_job_id) VALUES(?,?,?,?,'queued',?,?,?)", [id, acceptance, certificate, fileName, now, now, parentJobId]);
      for (const row of codes) await this.options.database.run('INSERT INTO housing_binding_rows(job_id,row_number,code,status,message,updated_at) VALUES(?,?,?,?,?,?)', [id, row.rowNumber, row.code, row.status === 'unknown' || row.status === 'binding' ? 'unknown' : 'pending', '', now]);
    });
    try {
      const [entry] = await this.options.tasks.enqueueBatch([{ name: '房屋编码自动绑定', metadata: {
        type: 'housing-binding', systemId: HOUSING_SYSTEM_ID, matterId: HOUSING_MATTER_ID, details: { housingJobId: id } },
        executor: context => this.execute(id, context) }]);
      await this.options.database.run('UPDATE housing_binding_jobs SET task_id=? WHERE id=?', [entry.task.id, id]);
      const completion = entry.completion.then(async task => {
        if (task.status === 'cancelled') await this.phase(id, 'cancelled');
        else if (task.status === 'failed') {
          const job = await this.rawJob(id);
          if (active.includes(job.phase)) await this.phase(id, 'failed', '任务未完成，请重试未完成项');
        }
        return task;
      });
      this.completions.set(id, completion);
      void completion.catch(() => undefined).finally(() => this.completions.delete(id));
      return jobDto(await this.rawJob(id));
    } catch (error) { await this.phase(id, 'failed', '任务未能加入队列，请重试未完成项'); throw error; }
  }

  private async rawJob(id: string): Promise<JobRow> {
    const row = await this.options.database.get<JobRow>(jobSelect + ' WHERE j.id=? GROUP BY j.id', [id]);
    if (!row) throw new Error('绑定任务不存在'); return row;
  }
  async state(page = 1): Promise<HousingBindingState> {
    await this.options.authorize(); pageNumber(page);
    const rows = await this.options.database.all<JobRow>(jobSelect + ' GROUP BY j.id ORDER BY j.created_at DESC,j.id DESC LIMIT 20 OFFSET ?', [(page - 1) * 20]);
    const count = await this.options.database.get<{ n: number }>('SELECT COUNT(*) n FROM housing_binding_jobs');
    return { jobs: rows.map(jobDto), total: count?.n ?? 0 };
  }
  async detail(id: string, page = 1): Promise<HousingBindingDetail> {
    await this.options.authorize(); pageNumber(page);
    const job = await this.rawJob(id);
    const rows = await this.options.database.all<Row>('SELECT * FROM housing_binding_rows WHERE job_id=? ORDER BY row_number LIMIT 50 OFFSET ?', [id, (page - 1) * 50]);
    return { job: jobDto(job), rows: rows.map(rowDto), total: job.total };
  }
  async cancel(id: string): Promise<HousingBindingJob> {
    await this.options.authorize(); await this.creationTail;
    const job = await this.rawJob(id);
    if (active.includes(job.phase) && job.task_id) {
      this.options.tasks.cancel(job.task_id); await this.completions.get(id)?.catch(() => undefined);
      await this.phase(id, 'cancelled');
    }
    return jobDto(await this.rawJob(id));
  }
  retry(id: string): Promise<HousingBindingJob> {
    return this.serial(async () => {
      await this.options.authorize(); const job = await this.rawJob(id);
      if (active.includes(job.phase)) throw new Error('请等待任务完成后重试');
      const rows = await this.options.database.all<Row>("SELECT * FROM housing_binding_rows WHERE job_id=? AND status NOT IN ('succeeded','already-bound') ORDER BY row_number", [id]);
      if (!rows.length) throw new Error('没有需要重试的房屋');
      return this.enqueue({ acceptanceNumber: job.acceptance_number, certificateNumber: job.certificate_number }, job.file_name,
        rows.map(row => ({ rowNumber: row.row_number, code: row.code, status: row.status })), id);
    });
  }
  private phase(id: string, phase: HousingJobPhase, error: string | null = null) {
    return this.options.database.run('UPDATE housing_binding_jobs SET phase=?,error=?,updated_at=? WHERE id=?', [phase, error, Date.now(), id]);
  }
  private row(id: string, number: number, status: HousingRowStatus, text: string) {
    return this.options.database.run('UPDATE housing_binding_rows SET status=?,message=?,updated_at=? WHERE job_id=? AND row_number=?', [status, text, Date.now(), id, number]);
  }
  private async waitForLogin(id: string, context: TaskContext): Promise<void> {
    this.authenticated = false; await this.phase(id, 'waiting-login');
    const job = await this.rawJob(id);
    context.report({ current: job.succeeded + job.skipped + job.failed, total: job.total, message: '登录已失效，任务暂停；重新登录后继续' });
    await new Promise<void>((done, reject) => {
      const cleanup = () => { this.loginWaiters.delete(resume); context.signal.removeEventListener('abort', abort); };
      const resume = () => { cleanup(); done(); };
      const abort = () => { cleanup(); reject(new AppError('TASK_CANCELLED', '任务已取消')); };
      this.loginWaiters.add(resume); context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) abort(); else if (this.authenticated) resume();
    });
    await this.options.authorize(); await this.phase(id, 'running');
  }
  private async resolve(id: string, context: TaskContext): Promise<HousingBindingTarget> {
    while (true) {
      context.signal.throwIfAborted(); await this.options.authorize(); const job = await this.rawJob(id);
      try {
        const target = await this.options.client.resolveTarget(job.acceptance_number, job.certificate_number, context.signal);
        if (job.target_json) {
          const previous = JSON.parse(job.target_json) as HousingBindingTarget;
          if (target.acceptanceId !== previous.acceptanceId || target.propertyId !== previous.propertyId) throw new AppError('QUERY_INVALID', '办件产权关联已变化，请核对原系统后重新创建任务');
        } else await this.options.database.run('UPDATE housing_binding_jobs SET target_json=? WHERE id=?', [JSON.stringify(target), id]);
        return target;
      } catch (error) { if (!authError(error)) throw error; await this.waitForLogin(id, context); }
    }
  }
  private async execute(id: string, context: TaskContext) {
    try {
      await this.phase(id, 'running'); let target = await this.resolve(id, context);
      const rows = await this.options.database.all<Row>('SELECT * FROM housing_binding_rows WHERE job_id=? ORDER BY row_number', [id]);
      for (const row of rows) {
        let submitted = row.status === 'unknown';
        while (true) {
          context.signal.throwIfAborted(); await this.options.authorize();
          try {
            const house = await this.options.client.findHouse(row.code, target, context.signal);
            if (!house) { await this.row(id, row.row_number, 'failed', '未找到完整匹配且在权限范围内的有效房屋'); break; }
            if (await this.options.client.isBound(target, house, context.signal)) {
              await this.row(id, row.row_number, submitted ? 'succeeded' : 'already-bound', submitted ? '已回读确认关联' : '已绑定，跳过'); break;
            }
            await this.options.authorize(); context.signal.throwIfAborted();
            await this.row(id, row.row_number, 'binding', '正在提交挂接'); submitted = true;
            try { await this.options.client.bindHouse(target, house, context.signal); }
            catch (error) {
              if (context.signal.aborted || authError(error)) throw error;
              if (await this.options.client.isBound(target, house, context.signal)) {
                await this.row(id, row.row_number, 'succeeded', '提交后已回读确认关联'); break;
              }
              await this.row(id, row.row_number, 'unknown', '提交结果未确认；重试时先核对关联，不自动重复提交'); break;
            }
            if (await this.options.client.isBound(target, house, context.signal)) await this.row(id, row.row_number, 'succeeded', '挂接成功，已回读确认');
            else await this.row(id, row.row_number, 'unknown', '原系统未返回关联，请核对后重试');
            break;
          } catch (error) {
            if (submitted) await this.row(id, row.row_number, 'unknown', '提交或核对被中断，继续时先查询已有关系');
            if (context.signal.aborted) throw error;
            if (authError(error)) { await this.waitForLogin(id, context); target = await this.resolve(id, context); continue; }
            if (!submitted) await this.row(id, row.row_number, 'failed', message(error));
            break;
          }
        }
        const progress = await this.rawJob(id);
        context.report({ current: progress.succeeded + progress.skipped + progress.failed, total: progress.total,
          message: `成功 ${progress.succeeded} · 已绑定 ${progress.skipped} · 未完成 ${progress.failed}` });
        await this.options.database.run('UPDATE housing_binding_jobs SET updated_at=? WHERE id=?', [Date.now(), id]);
      }
      const job = await this.rawJob(id);
      await this.phase(id, job.failed || job.pending ? 'failed' : 'completed', job.failed || job.pending ? '部分房屋未完成，可重试未完成项' : null);
      if (job.failed || job.pending) throw new AppError('REMOTE_REQUEST_FAILED', '部分房屋未完成，可重试未完成项');
      return jobDto(await this.rawJob(id));
    } catch (error) {
      await this.phase(id, context.signal.aborted ? 'cancelled' : 'failed', context.signal.aborted ? '任务已取消，已完成的关联保留' : message(error));
      throw error instanceof AppError ? error : new Error('绑定任务未完成，请检查原系统后重试');
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; await this.creationTail;
    for (const [id] of this.completions) { const job = await this.rawJob(id); if (job.task_id) this.options.tasks.cancel(job.task_id); }
    await Promise.allSettled([...this.completions.values()]); this.imports.clear();
  }
}
