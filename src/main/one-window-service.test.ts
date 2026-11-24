import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { BusinessSystemPlugin } from '../core/plugins/types';
import type { SessionState } from '../core/session/types';
import { NodeSqliteDriver } from '../core/storage/database';
import { SqliteLocalRepository } from '../core/storage/sqlite-repository';
import { SqlitePlatformStore } from '../core/storage/platform-store';
import { DefaultLocalSyncEngine } from '../core/sync/engine';
import { TaskEngine } from '../core/tasks/engine';
import { OneWindowService } from './one-window-service';

const systemId = 'shenzhen-one-window';
const matterId = 'outdoor-advertising-approval';
const filters = { dateType: 'all', startDate: '', endDate: '', state: '' };

describe('one-window local collection and direct-upload lifecycle', () => {
  let directory: string;
  let database: NodeSqliteDriver;
  let repository: SqliteLocalRepository;
  let platformStore: SqlitePlatformStore;
  let tasks: TaskEngine;
  let service: OneWindowService;
  let now: number;
  let sessionStatus: SessionState['status'];
  let permitted: boolean;
  let rows: Record<string, unknown>[];
  const query = vi.fn();
  const upload = vi.fn();
  const authorize = vi.fn();

  const sample = (index: number) => ({
    bsnum: 'SYNTHETIC-' + String(index).padStart(5, '0'), receiveNumber: '000' + index,
    matterName: '设置大型户外广告审批', applicant: '测试单位 ' + index, detailStatus: 'complete', detailFailures: [],
    details: { base: { status: 'complete', data: { 企业名称: '测试单位 ' + index } },
      form: { status: 'complete', data: { name: '测试表单', version: '1', fields: [], data: { value: index } } } },
  });

  function plugin(): BusinessSystemPlugin {
    const state = async (): Promise<SessionState> => ({ systemId, status: sessionStatus });
    return {
      id: systemId, name: '深圳市一窗综合服务受理平台', version: '0.1.0', loginMode: 'embedded',
      auth: { getState: state, login: state, logout: async () => {}, getSessionForRequest: async () => ({}) },
      getSessionState: state, initialize: async () => {},
      matters: [{ id: matterId, name: '设置大型户外广告审批', uniqueKey: ['bsnum'], query,
        querySchema: [
          { key: 'dateType', label: '日期类型', type: 'select', options: ['all', 'received', 'finished'].map(value => ({ value, label: value })) },
          { key: 'startDate', label: '开始日期', type: 'date' }, { key: 'endDate', label: '结束日期', type: 'date' },
          { key: 'state', label: '状态', type: 'text' },
        ] }],
    };
  }

  async function open() {
    database = new NodeSqliteDriver(join(directory, 'local.sqlite'));
    repository = new SqliteLocalRepository(database);
    await repository.initialize();
    platformStore = new SqlitePlatformStore(database);
    await platformStore.initialize();
    tasks = new TaskEngine(platformStore);
    service = new OneWindowService({ database, platformStore, syncEngine: new DefaultLocalSyncEngine(repository),
      plugin: plugin(), tasks, exportDirectory: join(directory, 'exports'), authorize, upload,
      businessOperation: operation => operation(), now: () => now });
    await service.initialize();
  }

  async function waitUntilIdle() {
    await vi.waitFor(async () => { expect((await service.state(matterId)).running).toBe(false); }, { timeout: 3_000, interval: 10 });
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(join(tmpdir(), 'one-window-service-'));
    now = Date.parse('2026-11-24T01:00:00Z');
    sessionStatus = 'authenticated';
    permitted = true;
    rows = [sample(1)];
    query.mockImplementation(async () => ({ rows, page: 1, pageSize: 100, total: rows.length }));
    upload.mockImplementation(async ({ taskId }) => ({ uploadId: taskId }));
    authorize.mockImplementation(async () => { if (!permitted) throw new Error('LICENSE_MATTER_DENIED'); });
    await open();
  });

  afterEach(async () => {
    await service.stop();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('uploads every row in a batch larger than the UI page limit and retains exact batch snapshots', async () => {
    rows = Array.from({ length: 503 }, (_, index) => sample(index));
    const task = await service.run(matterId, filters);
    expect(task.status).toBe('completed');
    expect(task.result).toMatchObject({ total: 503, uploadStatus: 'uploaded' });
    expect(upload).toHaveBeenCalledTimes(1);
    const input = upload.mock.calls[0][0];
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(input.bytes as unknown as ExcelJS.Buffer);
    expect(workbook.getWorksheet('办件总览')!.rowCount).toBe(504);
    expect(workbook.getWorksheet('办件总览')!.getCell('A504').value).toBe('SYNTHETIC-00502');
    expect((await service.records(matterId, { batchId: task.id, pageSize: 500 })).rows).toHaveLength(500);
    expect((await service.records(matterId, { batchId: task.id, page: 2, pageSize: 500 })).rows).toHaveLength(3);
    expect((await platformStore.taskRowsForExport(task.id))).toHaveLength(503);
  });

  it('retains local data after a failed direct upload and retries the same bytes and batch without recollecting', async () => {
    upload.mockRejectedValueOnce(new Error('测试上传失败'));
    const task = await service.run(matterId, filters);
    expect(task.status).toBe('completed');
    expect(task.result).toMatchObject({ total: 1, uploadStatus: 'failed' });
    const failed = (await service.state(matterId)).batches[0];
    expect(failed).toMatchObject({ taskId: task.id, uploadStatus: 'failed', total: 1, uploadError: '测试上传失败' });
    expect((await service.records(matterId, {})).total).toBe(1);
    expect((await service.records(matterId, { batchId: task.id })).total).toBe(1);
    expect(await service.folder(task.id)).toBe(join(directory, 'exports'));
    const original = await readFile(failed.filePath);
    rows = [sample(999)];
    expect(await service.retry(task.id)).toMatchObject({ taskId: task.id, uploadStatus: 'uploaded' });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[1][0]).toEqual(upload.mock.calls[0][0]);
    expect(upload.mock.calls[1][0].bytes).toEqual(original);
    await service.retry(task.id);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('persists the selected filters, weekly schedule and next run across a service restart', async () => {
    const selected = { schedule: { enabled: true, loginAutoRun: false, mode: 'weekly', time: '09:30', weekdays: [1, 3, 5] },
      filters: { ...filters, dateType: 'finished', startDate: '2026-11-01', endDate: '2026-11-24', state: '4' } };
    const saved = await service.savePlan(matterId, selected);
    expect(saved.nextRunAt).toBe(Date.parse('2026-11-25T01:30:00Z'));
    await service.stop();
    await database.close();
    await open();
    expect(await service.plan(matterId)).toEqual(saved);
    expect((await service.state(matterId)).batches).toEqual([]);
  });

  it('starts login-triggered collection once per confirmed login and waits while logged out', async () => {
    await service.savePlan(matterId, { schedule: { loginAutoRun: true }, filters });
    sessionStatus = 'logged-out';
    await service.tick();
    expect(query).not.toHaveBeenCalled();
    sessionStatus = 'authenticated';
    await service.tick();
    await waitUntilIdle();
    expect(query).toHaveBeenCalledTimes(1);
    await service.tick();
    await waitUntilIdle();
    expect(query).toHaveBeenCalledTimes(1);
    sessionStatus = 'expired';
    await service.tick();
    expect(query).toHaveBeenCalledTimes(1);
    sessionStatus = 'authenticated';
    await service.tick();
    await waitUntilIdle();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('pauses overdue schedules while logged out and prevents manual or scheduled overlap', async () => {
    await service.savePlan(matterId, { schedule: { enabled: true, intervalMinutes: 1 }, filters });
    now += 61_000;
    sessionStatus = 'logged-out';
    await service.tick();
    expect(query).not.toHaveBeenCalled();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    query.mockImplementationOnce(async () => { await gate; return { rows, page: 1, pageSize: 100, total: rows.length }; });
    sessionStatus = 'authenticated';
    await service.tick();
    await vi.waitFor(() => { expect(query).toHaveBeenCalledTimes(1); });
    now += 61_000;
    await service.tick();
    expect(query).toHaveBeenCalledTimes(1);
    await expect(service.run(matterId, filters)).rejects.toThrow('正在回流');
    release();
    await waitUntilIdle();
    await service.tick();
    await waitUntilIdle();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('checks current grants before collection and again before persisting or uploading source results', async () => {
    permitted = false;
    await expect(service.run(matterId, filters)).rejects.toThrow('LICENSE_MATTER_DENIED');
    expect(query).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    permitted = true;
    query.mockImplementationOnce(async () => { permitted = false; return { rows, page: 1, pageSize: 100, total: 1 }; });
    const task = await service.run(matterId, filters);
    expect(task.status).toBe('failed');
    expect(task.error).toBe('LICENSE_MATTER_DENIED');
    expect(upload).not.toHaveBeenCalled();
    expect(await database.get<{ count: number }>('SELECT COUNT(*) AS count FROM one_window_batches')).toEqual({ count: 0 });
    expect(await database.get<{ count: number }>('SELECT COUNT(*) AS count FROM local_records')).toEqual({ count: 0 });
  });

  it('waits for an interrupted manual retry to finish saving its failure state before shutdown completes', async () => {
    upload.mockRejectedValueOnce(new Error('测试上传失败'));
    const task = await service.run(matterId, filters);
    let finishUpload!: () => void;
    const uploadCleanup = new Promise<void>(resolve => { finishUpload = resolve; });
    let aborted = false;
    upload.mockImplementationOnce(async (_file, signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      await uploadCleanup;
      throw new Error('测试上传已中断');
    });
    const retry = service.retry(task.id);
    const retryFailure = retry.catch(error => error);
    await vi.waitFor(() => { expect(upload).toHaveBeenCalledTimes(2); });
    let stopped = false;
    const stopping = service.stop().then(() => { stopped = true; });
    try {
      await vi.waitFor(() => { expect(aborted).toBe(true); });
      expect(stopped).toBe(false);
    } finally {
      finishUpload();
      await retryFailure;
      await stopping;
    }
    expect((await database.get<{ upload_status: string }>('SELECT upload_status FROM one_window_batches WHERE task_id=?', [task.id]))?.upload_status).toBe('failed');
  });
});
