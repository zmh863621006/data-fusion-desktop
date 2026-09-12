export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskProgress {
  current: number;
  total?: number;
  message?: string;
}

export interface RuntimeTask<T = unknown> {
  id: string;
  name: string;
  status: TaskStatus;
  progress: TaskProgress;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: T;
  error?: string;
}

export interface TaskContext {
  signal: AbortSignal;
  report(progress: TaskProgress): void;
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

  async run<T>(name: string, executor: (context: TaskContext) => Promise<T>): Promise<RuntimeTask<T>> {
    const id = globalThis.crypto.randomUUID();
    const controller = new AbortController();
    const task: RuntimeTask<T> = { id, name, status: 'queued', progress: { current: 0 }, createdAt: Date.now() };
    this.tasks.set(id, task);
    this.controllers.set(id, controller);

    task.status = 'running';
    task.startedAt = Date.now();
    try {
      task.result = await executor({ signal: controller.signal, report: (progress) => { task.progress = progress; } });
      task.status = controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      task.status = controller.signal.aborted ? 'cancelled' : 'failed';
      task.error = error instanceof Error ? error.message : String(error);
    } finally {
      task.finishedAt = Date.now();
      this.controllers.delete(id);
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
