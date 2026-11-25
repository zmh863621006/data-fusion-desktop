import { describe, expect, it, vi } from 'vitest';
import { TaskEngine, type RuntimeTask, type TaskDefinition, type TaskStore } from './engine';

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
    expect(engine.get(id)?.progress.message).toBe('任务已取消，未执行');
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
    if (status === 'completed') {
      await expect(failed).rejects.toThrow('任务状态保存失败');
      expect(engine.list().find(task => task.name === 'first')).toMatchObject({ status: 'failed', error: '任务状态保存失败' });
    }
    else expect((await failed).status).toBe('failed');
    expect(await next).toMatchObject({ status: 'completed', result: 1 });
  });
});

const remote = (name: string, systemId: string, executor: TaskDefinition['executor'], type = 'data-return'): TaskDefinition => ({
  name, executor, metadata: { type, systemId, matterId: name },
});

describe('batch scheduling and per-system admission', () => {
  it('serializes HRSS and Shenzhen separately without blocking other systems behind their queues', async () => {
    const engine = new TaskEngine(undefined, 3);
    const waits = Array.from({ length: 5 }, gate), starts: string[] = [];
    const names = ['hrss-1', 'hrss-2', 'sz-1', 'sz-2', 'other'];
    const systems = ['guangdong-hrss', 'guangdong-hrss', 'shenzhen-integrated-services', 'shenzhen-integrated-services', 'government-info'];
    const jobs = await engine.enqueueBatch(names.map((name, i) => remote(name, systems[i], async () => { starts.push(name); await waits[i].wait; })));
    await vi.waitFor(() => expect(starts).toEqual(['hrss-1', 'sz-1', 'other']));
    for (const name of ['hrss-2', 'sz-2']) {
      const task = engine.list().find(task => task.name === name)!;
      expect(task.status).toBe('queued'); expect(task.startedAt).toBeUndefined();
    }
    waits[0].release(); await jobs[0].completion;
    await vi.waitFor(() => expect(starts).toEqual(['hrss-1', 'sz-1', 'other', 'hrss-2']));
    waits[2].release(); await jobs[2].completion;
    await vi.waitFor(() => expect(starts.at(-1)).toBe('sz-2'));
    waits.forEach(wait => wait.release());
    expect((await Promise.all(jobs.map(job => job.completion))).every(task => task.status === 'completed')).toBe(true);
  });

  it('keeps the global cap while allowing independent nonserial tasks from the same system to run together', async () => {
    const engine = new TaskEngine(undefined, 2), waits = Array.from({ length: 4 }, gate);
    let active = 0, peak = 0;
    const starts: number[] = [];
    const jobs = await engine.enqueueBatch(waits.map((wait, i) => remote(String(i), 'oversize-transport', async () => {
      starts.push(i); active++; peak = Math.max(peak, active); await wait.wait; active--;
    })));
    await vi.waitFor(() => expect(starts).toEqual([0, 1]));
    expect(engine.list().filter(task => task.status === 'queued')).toHaveLength(2);
    waits[0].release(); await jobs[0].completion;
    await vi.waitFor(() => expect(starts).toEqual([0, 1, 2]));
    waits.forEach(wait => wait.release()); await Promise.all(jobs.map(job => job.completion));
    expect(peak).toBe(2);
  });

  it('persists every initial row together before dispatching any batch executor', async () => {
    const durable = gate(), starts: string[] = [], initial: RuntimeTask[][] = [];
    const store: TaskStore = {
      save: vi.fn(async () => {}), listTasks: async () => [],
      saveMany: vi.fn(async tasks => { initial.push(structuredClone(tasks)); await durable.wait; }),
    };
    const engine = new TaskEngine(store, 2);
    const pending = engine.enqueueBatch(['a', 'b', 'c'].map(name => remote(name, 'demo', async () => { starts.push(name); })));
    await vi.waitFor(() => expect(initial).toHaveLength(1));
    expect(initial[0].map(task => task.status)).toEqual(['queued', 'queued', 'queued']);
    expect(initial[0].every(task => task.startedAt === undefined)).toBe(true);
    expect(engine.list()).toHaveLength(3); expect(starts).toEqual([]); expect(store.save).not.toHaveBeenCalled();
    durable.release(); const jobs = await pending;
    await Promise.all(jobs.map(job => job.completion));
    expect(starts).toEqual(['a', 'b', 'c']); expect(store.saveMany).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('does not execute or reserve slots if initial persistence fails (transactional: %s)', async transactional => {
    const source = vi.fn(async () => 1);
    let fail = true;
    const save = vi.fn(async (task: RuntimeTask) => { if (fail && task.name === 'b') throw new Error('初始写入失败'); });
    const store: TaskStore = { save, listTasks: async () => [],
      ...(transactional ? { saveMany: async (tasks: RuntimeTask[]) => { if (fail) throw new Error('初始写入失败'); for (const task of tasks) await save(task); } } : {}),
    };
    const engine = new TaskEngine(store, 1);
    await expect(engine.enqueueBatch(['a', 'b'].map(name => remote(name, 'guangdong-hrss', source)))).rejects.toThrow('初始写入失败');
    expect(source).not.toHaveBeenCalled(); expect(engine.list()).toEqual([]);
    fail = false;
    expect(await engine.run('next', source, { type: 'data-return', systemId: 'guangdong-hrss' })).toMatchObject({ status: 'completed', result: 1 });
  });

  it('freezes task filter details at creation while keeping serial tasks queued', async () => {
    const engine = new TaskEngine(undefined, 2), first = gate();
    const details = { batchId: 'BATCH', filters: { startDate: '2026-11-01', endDate: '2026-11-25' } };
    const pending = engine.enqueueBatch([
      remote('first', 'guangdong-hrss', () => first.wait),
      { ...remote('second', 'guangdong-hrss', async () => {}), metadata: { type: 'data-return', systemId: 'guangdong-hrss', details } },
    ]);
    details.filters.startDate = '2030-01-01'; const jobs = await pending;
    expect(jobs[1].task.details).toEqual({ batchId: 'BATCH', filters: { startDate: '2026-11-01', endDate: '2026-11-25' } });
    expect(jobs[1].task.status).toBe('queued'); first.release(); await Promise.all(jobs.map(job => job.completion));
  });

  it('cancels a serial queued task without occupying a global slot or stopping later jobs', async () => {
    const engine = new TaskEngine(undefined, 2), first = gate(), starts: string[] = [];
    const jobs = await engine.enqueueBatch([
      remote('first', 'guangdong-hrss', async () => { starts.push('first'); await first.wait; }),
      remote('cancel', 'guangdong-hrss', async () => { starts.push('cancel'); }),
      remote('last', 'guangdong-hrss', async () => { starts.push('last'); }),
      remote('other', 'government-info', async () => { starts.push('other'); }),
    ]);
    await vi.waitFor(() => expect(starts).toEqual(['first', 'other']));
    expect(engine.cancel(jobs[1].task.id)).toBe(true);
    expect((await jobs[1].completion).status).toBe('cancelled'); expect(jobs[1].task.startedAt).toBeUndefined();
    first.release(); await Promise.all(jobs.map(job => job.completion));
    expect(starts).toEqual(['first', 'other', 'last']);
  });

  it('releases the same-system queue after an executor fails', async () => {
    const engine = new TaskEngine(undefined, 2), first = gate(), starts: string[] = [];
    const jobs = await engine.enqueueBatch([
      remote('first', 'guangdong-hrss', async () => { starts.push('first'); await first.wait; throw new Error('查询失败'); }),
      remote('next', 'guangdong-hrss', async () => { starts.push('next'); return 2; }),
    ]);
    await vi.waitFor(() => expect(starts).toEqual(['first'])); first.release();
    expect(await jobs[0].completion).toMatchObject({ status: 'failed', error: '查询失败' });
    expect(await jobs[1].completion).toMatchObject({ status: 'completed', result: 2 });
  });

  it('pauses only remote work for that system and resumes without blocking local exports or other systems', async () => {
    const engine = new TaskEngine(undefined, 2), starts: string[] = [];
    engine.pauseSystem('guangdong-hrss', '等待登录');
    const jobs = await engine.enqueueBatch([
      remote('held', 'guangdong-hrss', async () => { starts.push('held'); }),
      remote('export', 'guangdong-hrss', async () => { starts.push('export'); }, 'export'),
      remote('other', 'government-info', async () => { starts.push('other'); }),
    ]);
    await Promise.all(jobs.slice(1).map(job => job.completion));
    expect(starts).toEqual(['export', 'other']);
    expect(jobs[0].task).toMatchObject({ status: 'queued', progress: { message: '等待登录' } });
    expect(jobs[0].task.startedAt).toBeUndefined();
    engine.resumeSystem('guangdong-hrss'); expect((await jobs[0].completion).status).toBe('completed');
    expect(starts).toEqual(['export', 'other', 'held']);
  });

  it('keeps queued cancellation durable while a system is paused', async () => {
    const snapshots: RuntimeTask[] = [];
    const engine = new TaskEngine({ save: async task => { snapshots.push(structuredClone(task)); }, listTasks: async () => [] }, 1);
    engine.pauseSystem('shenzhen-integrated-services');
    const source = vi.fn(async () => {});
    const [job] = await engine.enqueueBatch([remote('held', 'shenzhen-integrated-services', source)]);
    expect(engine.cancel(job.task.id)).toBe(true); await job.completion;
    expect(snapshots.at(-1)).toMatchObject({ status: 'cancelled' }); expect(snapshots.at(-1)?.startedAt).toBeUndefined();
    expect(snapshots.at(-1)?.progress.message).toBe('任务已取消，未执行');
    engine.resumeSystem('shenzhen-integrated-services'); expect(source).not.toHaveBeenCalled();
  });

  it('ends a running cancellation with a cancelled progress message while preserving its numeric progress', async () => {
    const engine = new TaskEngine(undefined, 1), running = gate();
    const [job] = await engine.enqueueBatch([remote('running', 'guangdong-hrss', async context => {
      context.report({ current: 12, total: 20, message: '正在回流' }); await running.wait;
    })]);
    await vi.waitFor(() => expect(job.task.progress.current).toBe(12));
    expect(engine.cancel(job.task.id)).toBe(true); running.release();
    expect(await job.completion).toMatchObject({ status: 'cancelled', progress: { current: 12, total: 20, message: '任务已取消' } });
  });

  it('atomically rejects a single/bulk registration race for the same return fingerprint', async () => {
    const durable = gate(), running = gate(), source = vi.fn(async () => running.wait);
    const store: TaskStore = { save: async () => {}, listTasks: async () => [], saveMany: async () => durable.wait };
    const engine = new TaskEngine(store, 2);
    const metadata = { type: 'data-return', systemId: 'guangdong-hrss', matterId: 'same', details: { returnFingerprint: 'SAME-DATES' } };
    const single = engine.run('single', source, metadata);
    await expect(engine.enqueueBatch([{ name: 'bulk', executor: source, metadata }])).rejects.toThrow('相同条件的任务已在队列中');
    expect(engine.list()).toHaveLength(1); expect(source).not.toHaveBeenCalled();
    durable.release(); await vi.waitFor(() => expect(source).toHaveBeenCalledTimes(1)); running.release(); await single;
    expect((await engine.run('repeat after completion', async () => 2, metadata)).status).toBe('completed');
  });

  it('detects the reverse bulk/single race, permits other date keys, and rejects duplicated batches without leftovers', async () => {
    const engine = new TaskEngine(undefined, 1), running = gate();
    const first = remote('first', 'guangdong-hrss', () => running.wait);
    first.metadata.details = { returnFingerprint: 'DATES-A' };
    const [job] = await engine.enqueueBatch([first]);
    await expect(engine.run('same single', async () => 1, first.metadata)).rejects.toThrow('相同条件的任务已在队列中');
    const next = remote('different', 'guangdong-hrss', async () => 2);
    next.metadata = { ...first.metadata, details: { returnFingerprint: 'DATES-B' } };
    const [different] = await engine.enqueueBatch([next]); expect(different.task.status).toBe('queued');
    const before = engine.list().length;
    const duplicate = remote('duplicate', 'other', async () => 3);
    duplicate.metadata.details = { returnFingerprint: 'INTERNAL-DUPLICATE' };
    await expect(engine.enqueueBatch([duplicate, { ...duplicate, name: 'same inside batch' }])).rejects.toThrow('相同条件的任务已在队列中');
    expect(engine.list()).toHaveLength(before);
    running.release(); await Promise.all([job.completion, different.completion]);
  });

  it('makes a final completed-state persistence failure visible to batch readers and durably records failure if possible', async () => {
    const stored = new Map<string, RuntimeTask>();
    const engine = new TaskEngine({ save: async task => {
      if (task.status === 'completed') throw new Error('private sqlite details');
      stored.set(task.id, structuredClone(task));
    }, listTasks: async () => [...stored.values()] }, 1);
    const [job] = await engine.enqueueBatch([remote('one', 'guangdong-hrss', async () => 1)]);
    await expect(job.completion).rejects.toThrow('任务状态保存失败');
    expect(engine.get(job.task.id)).toMatchObject({ status: 'failed', error: '任务状态保存失败' });
    expect(stored.get(job.task.id)).toMatchObject({ status: 'failed', error: '任务状态保存失败' });
    expect(engine.get(job.task.id)?.error).not.toContain('private');
  });
});
