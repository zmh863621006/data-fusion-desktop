import { describe, expect, it, vi } from 'vitest';
import { TaskEngine, type RuntimeTask } from './engine';

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

describe('task scheduling', () => {
  it('admits tasks in order and applies settings changes to waiting tasks', async () => {
    const engine = new TaskEngine(undefined, 1);
    const gates = Array.from({ length: 4 }, gate);
    const starts: number[] = [];
    const tasks = gates.map(({ wait }, i) => engine.run(String(i), async () => { starts.push(i); await wait; }));
    await vi.waitFor(() => expect(starts).toEqual([0]));
    expect(engine.list().filter(task => task.status === 'queued')).toHaveLength(3);
    engine.setConcurrency(2);
    await vi.waitFor(() => expect(starts).toEqual([0, 1]));
    engine.setConcurrency(1);
    gates[0].release();
    await tasks[0];
    expect(starts).toEqual([0, 1]);
    gates[1].release();
    await vi.waitFor(() => expect(starts).toEqual([0, 1, 2]));
    gates[2].release();
    gates[3].release();
    expect((await Promise.all(tasks)).every(task => task.status === 'completed')).toBe(true);
    expect(starts).toEqual([0, 1, 2, 3]);
  });

  it('persists a queued cancellation immediately without starting its executor', async () => {
    const states: string[] = [];
    const engine = new TaskEngine({ save: async task => { states.push(task.name + '-' + task.status); }, listTasks: async () => [] }, 1);
    const first = gate();
    const running = engine.run('first', () => first.wait);
    const execute = vi.fn(async () => {});
    const queued = engine.run('second', execute);
    const id = engine.list().find(task => task.name === 'second')!.id;
    expect(engine.cancel(id)).toBe(true);
    expect(await queued).toMatchObject({ status: 'cancelled', error: '任务已取消' });
    expect(execute).not.toHaveBeenCalled();
    expect(engine.cancel(id)).toBe(false);
    expect(states.filter(state => state.startsWith('second'))).toEqual(['second-queued', 'second-cancelled']);
    first.release();
    await running;
  });

  it.each(['queued', 'running', 'completed'])('releases capacity after a %s write fails', async status => {
    const engine = new TaskEngine({ save: async (task: RuntimeTask) => {
      if (task.name === 'first' && task.status === status) throw new Error('模拟写入失败');
    }, listTasks: async () => [] }, 1);
    const failed = engine.run('first', async () => {});
    const next = engine.run('next', async () => 1);
    if (status === 'completed') await expect(failed).rejects.toThrow('模拟写入失败');
    else expect((await failed).status).toBe('failed');
    expect(await next).toMatchObject({ status: 'completed', result: 1 });
  });
});
