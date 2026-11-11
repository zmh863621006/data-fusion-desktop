export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskProgress {
  current: number;
  total?: number;
  message?: string;
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

  list(): RuntimeTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): RuntimeTask | undefined {
    return this.tasks.get(id);
  }

  constructor(private readonly store?: TaskStore) {}

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

    await this.store?.save(task);
    task.status = 'running';
    task.startedAt = Date.now();
    await this.store?.save(task);
    try {
      task.result = await executor({ taskId: id, signal: controller.signal, report: (progress) => {
        task.progress = progress;
        void this.store?.save(task);
      } });
      if (task.progress.total !== undefined && task.progress.current < task.progress.total) {
        task.progress = { ...task.progress, current: task.progress.total, message: '已完成' };
      }
      task.status = controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      task.status = controller.signal.aborted ? 'cancelled' : 'failed';
      task.error = error instanceof Error ? error.message : String(error);
    } finally {
      task.finishedAt = Date.now();
      this.controllers.delete(id);
      await this.store?.save(task);
    }
    return task;
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}
