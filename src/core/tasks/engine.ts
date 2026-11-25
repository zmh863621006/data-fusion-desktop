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
  listTasks(limit?: number): Promise<RuntimeTask[]>;
}

export class TaskEngine {
  private readonly tasks = new Map<string, RuntimeTask>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly waiting = new Map<string, (admitted: boolean) => void>();
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
    for (const [id, resolve] of this.waiting) {
      if (this.running >= this.concurrency) break;
      this.waiting.delete(id);
      this.running++;
      resolve(true);
    }
  }

  private removeWaiting(id: string): void {
    this.waiting.get(id)?.(false);
    this.waiting.delete(id);
  }

  async history(limit = 100): Promise<RuntimeTask[]> {
    return this.store ? this.store.listTasks(limit) : this.list().slice(0, limit);
  }

  async run<T>(name: string, executor: (context: TaskContext) => Promise<T>, metadata: TaskMetadata = { type: 'generic' }): Promise<RuntimeTask<T>> {
    const id = globalThis.crypto.randomUUID();
    const controller = new AbortController();
    const task: RuntimeTask<T> = {
      id, type: metadata.type, name, systemId: metadata.systemId, matterId: metadata.matterId, details: metadata.details,
      status: 'queued', progress: { current: 0 }, createdAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.controllers.set(id, controller);

    const admission = new Promise<boolean>(resolve => this.waiting.set(id, resolve));
    this.admitWaiting();
    try {
      try {
        await this.store?.save(task);
        if (!await admission || controller.signal.aborted) throw new Error('任务已取消');
        task.status = 'running';
        task.startedAt = Date.now();
        await this.store?.save(task);
        if (controller.signal.aborted) throw new Error('任务已取消');
        task.result = await executor({ taskId: id, signal: controller.signal, report: progress => {
          if (task.status !== 'running') return;
          task.progress = progress;
          void this.store?.save(task).catch(() => console.warn('任务进度未能写入本地数据库'));
        } });
        if (task.progress.total !== undefined && task.progress.current < task.progress.total) {
          task.progress = { ...task.progress, current: task.progress.total, message: '已完成' };
        }
        task.status = 'completed';
      } catch (error) {
        task.status = controller.signal.aborted ? 'cancelled' : 'failed';
        task.error = error instanceof Error ? error.message : String(error);
      }
      task.finishedAt = Date.now();
      await this.store?.save(task);
      return task;
    } finally {
      this.controllers.delete(id);
      this.removeWaiting(id);
      if (await admission) this.running--;
      this.admitWaiting();
    }
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller || controller.signal.aborted || this.tasks.get(id)?.finishedAt !== undefined) return false;
    controller.abort();
    this.removeWaiting(id);
    return true;
  }
}
