import { DEFAULT_APP_SETTINGS } from '../settings/types';

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskProgress {
  current: number;
  total?: number;
  message?: string;
  /** Requests deliberately skipped after exhausting timeout attempts; persists with task progress. */
  skippedRequests?: number;
}

export interface RuntimeTask<T = unknown> {
  id: string;
  type: string;
  name: string;
  systemId?: string;
  matterId?: string;
  status: TaskStatus;
  progress: TaskProgress;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: T;
  error?: string;
  details?: Record<string, unknown>;
}

export interface TaskContext {
  taskId: string;
  signal: AbortSignal;
  report(progress: TaskProgress): void;
}

export interface TaskMetadata {
  type: string;
  systemId?: string;
  matterId?: string;
  details?: Record<string, unknown>;
}

export interface TaskStore {
  save(task: RuntimeTask): Promise<void>;
  /** Production stores persist all initial rows in one transaction before any executor starts. */
  saveMany?(tasks: RuntimeTask[]): Promise<void>;
  listTasks(limit?: number): Promise<RuntimeTask[]>;
}

export interface TaskDefinition<T = unknown> {
  name: string;
  executor: (context: TaskContext) => Promise<T>;
  metadata: TaskMetadata;
}

export interface EnqueuedTask<T = unknown> {
  task: RuntimeTask<T>;
  completion: Promise<RuntimeTask<T>>;
}

interface ScheduledTask {
  task: RuntimeTask;
  controller: AbortController;
  executor: TaskDefinition['executor'];
  completion: Promise<RuntimeTask>;
  resolve(task: RuntimeTask): void;
  reject(error: unknown): void;
  ready: boolean;
  admitted: boolean;
  finishing: boolean;
  writes: Promise<void>;
}

const SERIAL_SYSTEMS = new Set(['guangdong-hrss', 'shenzhen-integrated-services']);
const REMOTE_TYPES = new Set(['data-return', 'remote-query']);
const remoteSystem = (task: RuntimeTask) => REMOTE_TYPES.has(task.type) ? task.systemId : undefined;
const serialSystem = (task: RuntimeTask) => {
  const systemId = remoteSystem(task);
  return systemId && SERIAL_SYSTEMS.has(systemId) ? systemId : undefined;
};
const returnIdentity = (task: RuntimeTask): string | undefined => task.type === 'data-return'
  && typeof task.details?.returnFingerprint === 'string' && task.details.returnFingerprint.length > 0
  ? JSON.stringify([task.systemId, task.matterId, task.details.returnFingerprint]) : undefined;

export class TaskEngine {
  private readonly tasks = new Map<string, RuntimeTask>();
  private readonly entries = new Map<string, ScheduledTask>();
  private readonly waiting = new Map<string, ScheduledTask>();
  private readonly activeSerialSystems = new Set<string>();
  private readonly pausedSystems = new Map<string, string>();
  private registrationTail: Promise<void> = Promise.resolve();
  private running = 0;

  list(): RuntimeTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): RuntimeTask | undefined {
    return this.tasks.get(id);
  }

  constructor(private readonly store?: TaskStore, private concurrency = DEFAULT_APP_SETTINGS.taskConcurrency) {}

  setConcurrency(limit: number): void {
    this.concurrency = limit;
    this.admitWaiting();
  }

  private admitWaiting(): void {
    for (const [id, entry] of this.waiting) {
      if (this.running >= this.concurrency) break;
      if (!entry.ready || entry.finishing) continue;
      if (entry.controller.signal.aborted) { void this.finishQueuedCancellation(entry); continue; }
      const systemId = remoteSystem(entry.task), serialId = serialSystem(entry.task);
      if (systemId && this.pausedSystems.has(systemId)) continue;
      if (serialId && this.activeSerialSystems.has(serialId)) continue;
      this.waiting.delete(id);
      entry.admitted = true;
      this.running++;
      if (serialId) this.activeSerialSystems.add(serialId);
      void this.execute(entry);
    }
  }

  pauseSystem(systemId: string, message = '等待重新登录后继续'): void {
    this.pausedSystems.set(systemId, message);
    for (const entry of this.waiting.values()) {
      if (remoteSystem(entry.task) !== systemId || entry.task.status !== 'queued') continue;
      entry.task.progress = { current: 0, message };
      if (entry.ready) void this.persist(entry).catch(() => console.warn('任务进度未能写入本地数据库'));
    }
    this.admitWaiting();
  }

  resumeSystem(systemId: string): void {
    if (!this.pausedSystems.delete(systemId)) return;
    for (const entry of this.waiting.values()) {
      if (remoteSystem(entry.task) !== systemId || entry.task.status !== 'queued') continue;
      entry.task.progress = { current: 0, message: '等待执行' };
      if (entry.ready) void this.persist(entry).catch(() => console.warn('任务进度未能写入本地数据库'));
    }
    this.admitWaiting();
  }

  async history(limit = 100): Promise<RuntimeTask[]> {
    return this.store ? this.store.listTasks(limit) : this.list().slice(0, limit);
  }

  async run<T>(name: string, executor: (context: TaskContext) => Promise<T>, metadata: TaskMetadata = { type: 'generic' }): Promise<RuntimeTask<T>> {
    const batch = this.registerBatch([{ name, executor, metadata }]);
    // Preserve the single-task API: an initial write failure is a failed result, not a running job.
    try { await batch.ready; } catch { return batch.entries[0].task as RuntimeTask<T>; }
    return batch.entries[0].completion as Promise<RuntimeTask<T>>;
  }

  async enqueueBatch(definitions: readonly TaskDefinition[]): Promise<EnqueuedTask[]> {
    const batch = this.registerBatch(definitions);
    await batch.ready;
    return batch.entries.map(({ task, completion }) => ({ task, completion }));
  }

  private registerBatch(definitions: readonly TaskDefinition[]): { entries: ScheduledTask[]; ready: Promise<void> } {
    const created = definitions.map<ScheduledTask>(({ name, executor, metadata }) => {
      const frozen = structuredClone(metadata);
      const task: RuntimeTask = {
        id: globalThis.crypto.randomUUID(), type: frozen.type, name, systemId: frozen.systemId, matterId: frozen.matterId,
        details: frozen.details, status: 'queued', progress: { current: 0 }, createdAt: Date.now(),
      };
      const paused = remoteSystem(task) && this.pausedSystems.get(remoteSystem(task)!);
      if (paused) task.progress.message = paused;
      let resolve!: ScheduledTask['resolve'], reject!: ScheduledTask['reject'];
      const completion = new Promise<RuntimeTask>((done, fail) => { resolve = done; reject = fail; });
      // Batch submission can return before an exceptionally fast executor has finished persisting.
      void completion.catch(() => undefined);
      return { task, executor, controller: new AbortController(), completion, resolve, reject,
        ready: false, admitted: false, finishing: false, writes: Promise.resolve() } satisfies ScheduledTask;
    });
    // Registration is synchronous up to this point. Both single and bulk callers share this
    // final check, so an async preflight cannot race another caller into an identical job.
    const activeReturns = new Set([...this.tasks.values()].filter(task => ['queued', 'running'].includes(task.status))
      .map(returnIdentity).filter((key): key is string => key !== undefined));
    for (const entry of created) {
      const key = returnIdentity(entry.task);
      if (!key) continue;
      if (activeReturns.has(key)) throw new Error(`${entry.task.name}：相同条件的任务已在队列中`);
      activeReturns.add(key);
    }
    for (const entry of created) {
      this.tasks.set(entry.task.id, entry.task);
      this.entries.set(entry.task.id, entry);
      this.waiting.set(entry.task.id, entry);
    }
    const ready = this.registrationTail.then(async () => {
      try {
        const initial = created.map(entry => structuredClone(entry.task));
        if (this.store?.saveMany) await this.store.saveMany(initial);
        else for (const task of initial) await this.store?.save(task);
        for (const entry of created) {
          entry.ready = true;
          const paused = remoteSystem(entry.task) && this.pausedSystems.get(remoteSystem(entry.task)!);
          if (paused) {
            entry.task.progress = { current: 0, message: paused };
            void this.persist(entry).catch(() => console.warn('任务进度未能写入本地数据库'));
          }
          if (entry.controller.signal.aborted) void this.finishQueuedCancellation(entry);
        }
        this.admitWaiting();
      } catch (error) {
        for (const entry of created) {
          entry.task.status = entry.controller.signal.aborted ? 'cancelled' : 'failed';
          entry.task.error = error instanceof Error ? error.message : String(error);
          entry.task.finishedAt = Date.now();
          this.waiting.delete(entry.task.id);
          this.entries.delete(entry.task.id);
          this.tasks.delete(entry.task.id);
          entry.resolve(entry.task);
        }
        this.admitWaiting();
        throw error;
      }
    });
    this.registrationTail = ready.catch(() => undefined);
    return { entries: created, ready };
  }

  private persist(entry: ScheduledTask): Promise<void> {
    const snapshot = structuredClone(entry.task);
    entry.writes = entry.writes.catch(() => undefined).then(() => this.store?.save(snapshot));
    return entry.writes;
  }

  private async execute(entry: ScheduledTask): Promise<void> {
    const { task, controller, executor } = entry;
    try {
      try {
        if (controller.signal.aborted) throw new Error('任务已取消');
        task.status = 'running';
        task.startedAt = Date.now();
        await this.persist(entry);
        if (controller.signal.aborted) throw new Error('任务已取消');
        task.result = await executor({ taskId: task.id, signal: controller.signal, report: progress => {
          if (task.status !== 'running') return;
          task.progress = { ...progress };
          void this.persist(entry).catch(() => console.warn('任务进度未能写入本地数据库'));
        } });
        if (controller.signal.aborted) throw new Error('任务已取消');
        if (task.progress.total !== undefined && task.progress.current < task.progress.total) {
          task.progress = { ...task.progress, current: task.progress.total, message: '已完成' };
        }
        task.status = 'completed';
      } catch (error) {
        task.status = controller.signal.aborted ? 'cancelled' : 'failed';
        task.error = error instanceof Error ? error.message : String(error);
        if (controller.signal.aborted) task.progress = { ...task.progress, message: '任务已取消' };
      }
      task.finishedAt = Date.now();
      await this.persist(entry);
      entry.resolve(task);
    } catch (error) {
      if (task.status === 'completed') {
        const failure = new Error('任务状态保存失败', { cause: error });
        task.status = 'failed';
        task.error = failure.message;
        try { await this.persist(entry); } catch { console.warn('任务失败状态未能写入本地数据库'); }
        entry.reject(failure);
      } else entry.reject(error);
    } finally {
      this.entries.delete(task.id);
      this.waiting.delete(task.id);
      if (entry.admitted) {
        this.running--;
        const serialId = serialSystem(task);
        if (serialId) this.activeSerialSystems.delete(serialId);
      }
      this.admitWaiting();
    }
  }

  private async finishQueuedCancellation(entry: ScheduledTask): Promise<void> {
    if (entry.admitted || entry.finishing || !entry.ready) return;
    entry.finishing = true;
    this.waiting.delete(entry.task.id);
    entry.task.status = 'cancelled';
    entry.task.error = '任务已取消';
    entry.task.progress = { ...entry.task.progress, message: '任务已取消，未执行' };
    entry.task.finishedAt = Date.now();
    try { await this.persist(entry); entry.resolve(entry.task); }
    catch (error) { entry.reject(error); }
    finally { this.entries.delete(entry.task.id); this.admitWaiting(); }
  }

  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.controller.signal.aborted || entry.task.finishedAt !== undefined) return false;
    entry.controller.abort();
    if (!entry.admitted) void this.finishQueuedCancellation(entry);
    return true;
  }
}
