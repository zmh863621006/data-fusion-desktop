import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
import * as workbooks from '../core/one-window/workbook';

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

  async function open(options: Partial<ConstructorParameters<typeof OneWindowService>[0]> = {}) {
    database = new NodeSqliteDriver(join(directory, 'local.sqlite'));
    repository = new SqliteLocalRepository(database);
    await repository.initialize();
    platformStore = new SqlitePlatformStore(database);
    await platformStore.initialize();
    tasks = new TaskEngine(platformStore);
    service = new OneWindowService({ database, platformStore, syncEngine: new DefaultLocalSyncEngine(repository),
      plugin: plugin(), tasks, exportDirectory: join(directory, 'exports'), authorize, upload,
      businessOperation: operation => operation(), now: () => now, ...options });
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
    vi.restoreAllMocks();
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

  it('still requires permission when returning an already-uploaded batch', async () => {
    const task = await service.run(matterId, filters);
    permitted = false;
    await expect(service.retry(task.id)).rejects.toThrow('LICENSE_MATTER_DENIED');
    expect(await database.get('SELECT upload_status FROM one_window_batches WHERE task_id=?', [task.id])).toEqual({ upload_status: 'uploaded' });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('pauses revoked workbook permissions without starving later batches and recovers after restart', async () => {
    const secondMatter = 'tree-removal-approval';
    const twoMatters = plugin();
    twoMatters.matters.push({ ...twoMatters.matters[0], id: secondMatter, name: '测试第二事项' });
    await service.stop(); await database.close(); await open({ plugin: twoMatters });
    upload.mockRejectedValueOnce(new Error('测试上传失败')).mockRejectedValueOnce(new Error('测试上传失败'));
    const first = await service.run(matterId, filters);
    now += 1;
    const second = await service.run(secondMatter, filters);
    const original = upload.mock.calls[0][0].bytes;
    authorize.mockImplementation(async (id: string) => { if (id === matterId) throw new Error('LICENSE_MATTER_DENIED'); });
    now += 5 * 60_000 + 1;
    await service.tick();
    expect(await database.get('SELECT upload_status,attempted_at,upload_error FROM one_window_batches WHERE task_id=?', [first.id]))
      .toMatchObject({ upload_status: 'paused', attempted_at: now, upload_error: expect.stringContaining('授权恢复后将自动重试') });
    await service.tick();
    expect((await service.state(secondMatter)).batches[0]).toMatchObject({ taskId: second.id, uploadStatus: 'uploaded' });
    expect(upload).toHaveBeenCalledTimes(3);
    await service.stop(); await database.close(); await open({ plugin: twoMatters });
    authorize.mockResolvedValue(undefined);
    now += 5 * 60_000 + 1;
    await service.tick();
    expect((await service.state(matterId)).batches[0]).toMatchObject({ taskId: first.id, uploadStatus: 'uploaded', uploadError: null });
    expect(upload).toHaveBeenCalledTimes(4);
    expect(upload.mock.calls[3][0].bytes).toEqual(original);
    expect(query).toHaveBeenCalledTimes(2);
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

  async function openRecords(extra: Partial<ConstructorParameters<typeof OneWindowService>[0]> = {}) {
    await service.stop(); await database.close();
    await open({ deliveryMode: 'records', capture: async () => {}, ...extra });
  }

  it('captures complete records and empty batches transactionally for API sync without generating or uploading any workbook', async () => {
    const capture = vi.fn(async (taskId: string, _matterId: string, captured: Array<{ recordKey: string; data: Record<string, unknown> }>) => {
      await database.run('INSERT INTO fixture_record_queue(task_id,total,state) VALUES(?,?,?)', [taskId, captured.length, 'pending']);
      expect((await platformStore.listTaskOutput(taskId, 1, 500)).total).toBe(captured.length);
    });
    const retryRecords = vi.fn(async () => { await database.run("UPDATE fixture_record_queue SET state='completed'"); });
    await openRecords({ capture, retryRecords, recordUploadState: async taskId => {
      const result = await database.get<{ state: 'pending' | 'completed' }>('SELECT state FROM fixture_record_queue WHERE task_id=?', [taskId]);
      return { state: result?.state ?? 'pending', completedAt: now };
    } });
    await database.exec('CREATE TABLE fixture_record_queue(task_id TEXT PRIMARY KEY,total INTEGER,state TEXT)');
    const createWorkbook = vi.spyOn(workbooks, 'createOneWindowWorkbook');
    const createFilename = vi.spyOn(workbooks, 'oneWindowWorkbookFilename');
    authorize.mockImplementation(async (_id, _automatic, requireExport) => { if (requireExport) throw new Error('NO_EXPORT_PERMISSION'); });
    rows = Array.from({ length: 503 }, (_, index) => sample(index));
    const task = await service.run(matterId, filters);
    expect(task.status).toBe('completed');
    expect(task.result).toMatchObject({ total: 503, deliveryMode: 'records', uploadStatus: 'uploaded' });
    expect(capture).toHaveBeenCalledTimes(1); expect(capture.mock.calls[0][2]).toHaveLength(503);
    expect(capture.mock.calls[0][0]).toBe(task.id);
    expect((await service.records(matterId, { batchId: task.id, pageSize: 500 })).total).toBe(503);
    expect(await service.state(matterId)).toMatchObject({ deliveryMode: 'records', batches: [{
      taskId: task.id, fileName: '', filePath: '', uploadStatus: 'uploaded', uploadedAt: now, objectKey: null,
    }] });
    await expect(service.folder(task.id)).rejects.toThrow('数据接口同步');
    rows = [];
    const empty = await service.run(matterId, filters);
    expect(empty.status).toBe('completed'); expect(empty.result).toMatchObject({ total: 0, deliveryMode: 'records', uploadStatus: 'uploaded' });
    expect(capture.mock.calls[1][2]).toEqual([]);
    expect(retryRecords).toHaveBeenCalledTimes(2);
    expect(createWorkbook).not.toHaveBeenCalled(); expect(createFilename).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
    await expect(readdir(join(directory, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('maps durable API queue status and retries the same saved records across a restart without recollecting', async () => {
    const capture = vi.fn(async (taskId: string) => { await database.run('INSERT INTO fixture_record_queue(task_id,state,last_error) VALUES(?,?,?)', [taskId, 'pending', null]); });
    let deliver = false;
    const retryRecords = vi.fn(async () => {
      if (deliver) await database.run("UPDATE fixture_record_queue SET state='completed',last_error=NULL");
    });
    const recordUploadState = async (taskId: string) => {
      const row = await database.get<{ state: 'pending' | 'blocked' | 'completed'; last_error: string | null }>('SELECT state,last_error FROM fixture_record_queue WHERE task_id=?', [taskId]);
      return { state: row?.state ?? 'pending', lastError: row?.last_error ?? undefined, completedAt: now };
    };
    await openRecords({ capture, retryRecords, recordUploadState });
    await database.exec('CREATE TABLE fixture_record_queue(task_id TEXT PRIMARY KEY,state TEXT,last_error TEXT)');
    const task = await service.run(matterId, filters);
    expect(task.result).toMatchObject({ uploadStatus: 'pending', deliveryMode: 'records' });
    await database.run("UPDATE fixture_record_queue SET state='blocked',last_error='后台暂不可达'");
    expect((await service.state(matterId)).batches[0]).toMatchObject({ taskId: task.id, uploadStatus: 'failed', uploadError: '后台暂不可达' });
    await openRecords({ capture, retryRecords, recordUploadState });
    expect((await service.state(matterId)).batches[0]).toMatchObject({ taskId: task.id, uploadStatus: 'failed' });
    deliver = true;
    expect(await service.retry(task.id)).toMatchObject({ taskId: task.id, uploadStatus: 'uploaded', uploadError: null, fileName: '', filePath: '' });
    expect(query).toHaveBeenCalledTimes(1); expect(capture).toHaveBeenCalledTimes(1); expect(upload).not.toHaveBeenCalled();
    expect((await platformStore.listTaskOutput(task.id)).total).toBe(1);
    await expect(readdir(join(directory, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back local records, output rows, batch metadata and the API queue together if durable capture fails', async () => {
    await openRecords({ capture: async taskId => {
      await database.run('INSERT INTO fixture_record_queue(task_id) VALUES(?)', [taskId]);
      throw new Error('SYNTHETIC_CAPTURE_FAILURE');
    } });
    await database.exec('CREATE TABLE fixture_record_queue(task_id TEXT PRIMARY KEY)');
    const task = await service.run(matterId, filters);
    expect(task.status).toBe('failed'); expect(task.error).toBe('SYNTHETIC_CAPTURE_FAILURE');
    for (const table of ['fixture_record_queue', 'one_window_batches', 'task_output_rows', 'local_records']) {
      expect((await database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))?.count).toBe(0);
    }
    expect(upload).not.toHaveBeenCalled();
    await expect(readdir(join(directory, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let the old Excel retry scheduler run or expose old file actions after switching to records delivery', async () => {
    upload.mockRejectedValueOnce(new Error('synthetic old workbook failure'));
    const legacy = await service.run(matterId, filters), saved = (await service.state(matterId)).batches[0];
    expect(saved.filePath).toBeTruthy(); const original = await readFile(saved.filePath);
    const retryRecords = vi.fn(async () => {});
    await openRecords({ retryRecords, recordUploadState: async () => ({ state: 'pending' }) });
    now += 600_000;
    await service.tick();
    expect(upload).toHaveBeenCalledTimes(1); expect(retryRecords).not.toHaveBeenCalled();
    expect((await service.state(matterId)).batches[0]).toMatchObject({ taskId: legacy.id, fileName: '', filePath: '', objectKey: null, uploadStatus: 'pending', uploadError: null });
    await expect(service.folder(legacy.id)).rejects.toThrow('数据接口同步');
    expect(await readFile(saved.filePath)).toEqual(original);
  });
});
