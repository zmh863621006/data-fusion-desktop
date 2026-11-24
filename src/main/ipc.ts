import { BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { appRuntime } from './runtime';
import { IPC_CHANNELS } from '../core/ipc/channels';
import { parseIdentifier, parseLocalRecordQuery, parseQueryContext, parseRows, parseSettingsPatch, parseTaskHistoryQuery } from '../core/ipc/validation';
import { assertMatterQueryAvailable, validateFilters } from '../core/query/validation';
import { readFile } from 'node:fs/promises';
import { loginTabController } from './login-tab';
import { operationalLog } from './operational-log';
import type { OperationalLogLevel, OperationalLogQuery } from '../core/diagnostics/types';
import type { ConfirmExport } from '../core/double-publicity/validation';
import { assertFeatureLicensed } from '../core/license/gate';
import type { AutomaticUpdateState } from '../core/updater/automatic';
import { publicationPlatform, sourceTabOwner } from '../core/publication/platforms';
import { hrssReturnDateDetails } from '../core/hrss/date-filters';
import { parseGovernmentExportTarget } from '../core/export/government-target';
import { exportWarningOptions } from './export-warning';
import { openExportFolder } from './export-folder';

function requireSystem(systemId: string) {
  const plugin = appRuntime.plugins.get(systemId);
  if (!plugin) throw new Error(`Unknown system: ${systemId}`);
  return plugin;
}

export function registerIpcHandlers(getTrustedWebContentsId: () => number | undefined, options: {
  exportOwner?: () => BrowserWindow | null;
  updates?: {
    snapshot(): AutomaticUpdateState;
    check(): Promise<unknown>;
    download(): Promise<void>;
    install(): Promise<void>;
    requestCheckSoon(): void;
  };
  businessOperation?: <T>(operation: () => Promise<T>) => Promise<T>;
  hrssDashboard?: { contentsId(): number | undefined; open(): void; close(): void };
} = {}): void {
  const confirmExportWarnings: ConfirmExport = async (validation, format) => {
    const owner = options.exportOwner?.();
    const details = exportWarningOptions(validation, format);
    const choice = owner && !owner.isDestroyed() ? await dialog.showMessageBox(owner, details) : await dialog.showMessageBox(details);
    return choice.response === 1;
  };
  const businessChannels = new Set<string>([
    IPC_CHANNELS.oneWindowRun, IPC_CHANNELS.oneWindowRetry, IPC_CHANNELS.oneWindowSavePlan,
    IPC_CHANNELS.licenseActivate, IPC_CHANNELS.licenseImport, IPC_CHANNELS.licenseDeactivate, IPC_CHANNELS.licenseRefresh,
    IPC_CHANNELS.healthToolImport, IPC_CHANNELS.healthToolUpdate, IPC_CHANNELS.healthToolSettings, IPC_CHANNELS.healthToolRemove, IPC_CHANNELS.healthToolExport,
    IPC_CHANNELS.practitionerNumbersSave, IPC_CHANNELS.taskOutput, IPC_CHANNELS.taskOutputExport, IPC_CHANNELS.recordsList,
    IPC_CHANNELS.recordUpdate, IPC_CHANNELS.recordsExport, IPC_CHANNELS.settingsUpdate, IPC_CHANNELS.credentialsSave,
    IPC_CHANNELS.systemLogin, IPC_CHANNELS.publicationOpen, IPC_CHANNELS.systemLoginClose, IPC_CHANNELS.systemLogout, IPC_CHANNELS.matterQuery,
    IPC_CHANNELS.matterRun, IPC_CHANNELS.syncPreview, IPC_CHANNELS.syncCommit,
  ]);
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any) => {
    ipcMain.handle(channel, async (event, ...args) => {
      const result = businessChannels.has(channel) && options.businessOperation
        ? await options.businessOperation(() => listener(event, ...args)) : await listener(event, ...args);
      if ([IPC_CHANNELS.licenseActivate, IPC_CHANNELS.licenseImport, IPC_CHANNELS.settingsUpdate].includes(channel as never)) options.updates?.requestCheckSoon();
      return result;
    });
  };
  const trusted = (event: IpcMainInvokeEvent): void => {
    if (event.sender.id !== getTrustedWebContentsId() || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('拒绝来自非受信页面的调用');
    }
  };

  handle(IPC_CHANNELS.oneWindowState, async (event, matterId, page) => {
    trusted(event);
    return (await appRuntime.oneWindow()).state(parseIdentifier(matterId, '事项标识'), page);
  });
  handle(IPC_CHANNELS.oneWindowSavePlan, async (event, matterId, plan) => {
    trusted(event);
    return (await appRuntime.oneWindow()).savePlan(parseIdentifier(matterId, '事项标识'), plan);
  });
  handle(IPC_CHANNELS.oneWindowRun, async (event, matterId, filters) => {
    trusted(event);
    return (await appRuntime.oneWindow()).run(parseIdentifier(matterId, '事项标识'), filters);
  });
  handle(IPC_CHANNELS.oneWindowRecords, async (event, matterId, input) => {
    trusted(event);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('台账查询格式无效');
    const { batchId, ...scope } = input;
    const query = parseLocalRecordQuery(scope);
    if (query.systemId || query.matterId) throw new Error('台账查询包含未知字段');
    return (await appRuntime.oneWindow()).records(parseIdentifier(matterId, '事项标识'), {
      ...query, batchId: batchId ? parseIdentifier(batchId, '批次标识') : undefined,
    });
  });
  handle(IPC_CHANNELS.oneWindowRetry, async (event, taskId) => {
    trusted(event);
    return (await appRuntime.oneWindow()).retry(parseIdentifier(taskId, '批次标识'));
  });
  handle(IPC_CHANNELS.oneWindowFolder, async (event, taskId) => {
    trusted(event);
    const path = await (await appRuntime.oneWindow()).folder(parseIdentifier(taskId, '批次标识'));
    const error = await shell.openPath(path);
    if (error) throw new Error('无法打开批次文件夹');
  });

  handle(IPC_CHANNELS.hrssDashboardGet, async event => {
    if (event.sender.id === options.hrssDashboard?.contentsId() && event.senderFrame === event.sender.mainFrame) {
      return appRuntime.hrssDashboard();
    }
    trusted(event);
    return appRuntime.hrssDashboard();
  });
  handle(IPC_CHANNELS.hrssDashboardOpen, async event => {
    trusted(event);
    await appRuntime.requireLicense('guangdong-hrss');
    if (!options.hrssDashboard) throw new Error('全屏看板尚未就绪');
    options.hrssDashboard.open();
  });
  handle(IPC_CHANNELS.hrssDashboardClose, event => {
    if (event.sender.id !== options.hrssDashboard?.contentsId() || event.senderFrame !== event.sender.mainFrame) throw new Error('拒绝来自非看板页面的调用');
    options.hrssDashboard.close();
  });

  handle(IPC_CHANNELS.practitionerNumbersGet, async (event, year: number) => {
    trusted(event);
    return appRuntime.listPractitionerNumbers(year);
  });
  handle(IPC_CHANNELS.practitionerNumbersSave, async (event, config) => {
    trusted(event);
    if (!config || typeof config.latestNumber !== 'string' || typeof config.matterId !== 'string') throw new Error('编号配置格式错误');
    return appRuntime.savePractitionerNumber(config);
  });
  handle(IPC_CHANNELS.licenseStatus, async (event) => {
    trusted(event);
    if (!appRuntime.license) throw new Error('授权模块未就绪');
    return appRuntime.license.getStatus();
  });

  handle(IPC_CHANNELS.backendStatus, async event => { trusted(event); return appRuntime.backendStatus(); });
  handle(IPC_CHANNELS.licenseRefresh, async event => {
    trusted(event);
    if (!appRuntime.license) throw new Error('授权模块未就绪');
    await appRuntime.license.refreshOnline();
    return appRuntime.license.getStatus();
  });
  handle(IPC_CHANNELS.licenseCopyIdentifier, async (event, kind: unknown) => {
    trusted(event);
    if (kind !== 'license' && kind !== 'device') throw new Error('授权标识类型无效');
    if (!appRuntime.license) throw new Error('授权模块未就绪');
    const status = await appRuntime.license.getStatus();
    const value = kind === 'device' ? status.deviceId : (status.identity ?? status.grant)?.licenseId;
    if (!value) throw new Error('当前没有可复制的授权编号');
    clipboard.writeText(value);
  });
  handle(IPC_CHANNELS.healthToolState, async event => { trusted(event); return (await appRuntime.healthTool()).state(); });
  handle(IPC_CHANNELS.healthToolImport, async event => {
    trusted(event); await appRuntime.healthTool();
    const selected = await dialog.showOpenDialog({ title: '导入卫健局医疗机构登记批复', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Word 批复文档', extensions: ['docx'] }] });
    if (selected.canceled || !selected.filePaths.length) return null;
    const result = await (await appRuntime.healthTool()).importFiles(selected.filePaths);
    await appRuntime.audit('record.updated', undefined, undefined, undefined, { toolId: 'health-publicity', imported: result.added, duplicates: result.duplicates, failed: result.errors.length });
    return result;
  });
  handle(IPC_CHANNELS.healthToolUpdate, async (event, id: unknown, data: unknown) => {
    trusted(event);
    return (await appRuntime.healthTool()).update(parseIdentifier(id, '文档标识'), parseRows([data])[0]);
  });
  handle(IPC_CHANNELS.healthToolSettings, async (event, code: unknown) => {
    trusted(event);
    if (typeof code !== 'string' || code.length > 80) throw new Error('机关信用代码无效');
    return (await appRuntime.healthTool()).settings(code);
  });
  handle(IPC_CHANNELS.healthToolRemove, async (event, id: unknown) => {
    trusted(event);
    return (await appRuntime.healthTool()).remove(parseIdentifier(id, '文档标识'));
  });
  handle(IPC_CHANNELS.healthToolExport, async (event, ids: unknown) => {
    trusted(event); await appRuntime.healthTool();
    assertFeatureLicensed(await appRuntime.currentGrant(), 'export');
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('请选择有效的文档记录');
    const result = await appRuntime.exportHealthDocuments(ids as string[], undefined, confirmExportWarnings);
    if (result) await appRuntime.audit('export.created', undefined, undefined, undefined, { toolId: 'health-publicity', rowCount: result.rowCount });
    return result;
  });

  handle(IPC_CHANNELS.licenseActivate, async (event, key: unknown) => {
    trusted(event);
    if (typeof key !== 'string' || !key.trim() || key.length > 65_536) throw new Error('请输入有效的激活密钥');
    if (!appRuntime.license) throw new Error('授权模块未就绪');
    await appRuntime.license.activate(key);
    await appRuntime.audit('license.activated');
    return appRuntime.license.getStatus();
  });

  handle(IPC_CHANNELS.licenseDeactivate, async (event) => {
    trusted(event);
    if (!appRuntime.license) throw new Error('授权模块未就绪');
    await appRuntime.license.deactivate();
    return appRuntime.license.getStatus();
  });

  handle(IPC_CHANNELS.licenseImport, async (event) => {
    trusted(event);
    if (!appRuntime.license) throw new Error('授权模块未就绪');
    const selected = await dialog.showOpenDialog({
      title: '导入离线授权文件', properties: ['openFile'],
      filters: [{ name: '数据融合授权文件', extensions: ['txt', 'dfl'] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const key = await readFile(selected.filePaths[0], 'utf8');
    if (key.length > 65_536) throw new Error('授权文件过大');
    await appRuntime.license.activate(key);
    await appRuntime.audit('license.activated', undefined, undefined, undefined, { mode: 'offline' });
    return appRuntime.license.getStatus();
  });

  handle(IPC_CHANNELS.modulesList, async (event) => {
    trusted(event);
    return appRuntime.listSystemModules();
  });
  handle(IPC_CHANNELS.componentsList, async event => {
    trusted(event);
    return appRuntime.listComponents();
  });

  handle(IPC_CHANNELS.tasksList, async (event) => {
    trusted(event);
    return (await appRuntime.taskPage({ pageSize: 100 })).rows;
  });

  handle(IPC_CHANNELS.tasksPage, async (event, query: unknown) => {
    trusted(event);
    return appRuntime.taskPage(parseTaskHistoryQuery(query));
  });

  handle(IPC_CHANNELS.taskCancel, async (event, idInput: unknown) => {
    trusted(event);
    return appRuntime.cancelTask(parseIdentifier(idInput, '任务标识'));
  });

  handle(IPC_CHANNELS.taskOutput, async (event, idInput: unknown, pageInput: unknown, pageSizeInput: unknown, keywordInput: unknown) => {
    trusted(event);
    if (!(await appRuntime.currentGrant())) throw new Error('请先激活软件');
    const page = typeof pageInput === 'number' && Number.isFinite(pageInput) ? Math.trunc(pageInput) : 1;
    const pageSize = typeof pageSizeInput === 'number' && Number.isFinite(pageSizeInput) ? Math.trunc(pageSizeInput) : 100;
    if (keywordInput !== undefined && (typeof keywordInput !== 'string' || keywordInput.length > 200)) throw new Error('搜索关键字无效');
    return appRuntime.listTaskOutput(parseIdentifier(idInput, '任务标识'), page, pageSize, typeof keywordInput === 'string' ? keywordInput.trim() : undefined);
  });

  handle(IPC_CHANNELS.taskOutputExport, async (event, idInput: unknown, keywordInput: unknown, targetInput: unknown) => {
    trusted(event);
    const taskId = parseIdentifier(idInput, '任务标识');
    if (keywordInput !== undefined && (typeof keywordInput !== 'string' || keywordInput.length > 200)) throw new Error('搜索关键字无效');
    const target = parseGovernmentExportTarget(targetInput);
    const result = await appRuntime.exportTaskOutput(taskId, undefined, typeof keywordInput === 'string' ? keywordInput.trim() : undefined, confirmExportWarnings, target);
    if (!result) return null;
    await appRuntime.audit('export.created', undefined, undefined, taskId, { rowCount: result.rowCount, format: 'xlsx', source: 'task-output', ...(target ? { target } : {}) });
    return result;
  });

  handle(IPC_CHANNELS.recordsList, async (event, query: unknown) => {
    trusted(event);
    if (!(await appRuntime.currentGrant())) throw new Error('请先激活软件');
    return appRuntime.listLocalRecords(parseLocalRecordQuery(query));
  });

  handle(IPC_CHANNELS.recordVersions, async (event, systemInput: unknown, matterInput: unknown, keyInput: unknown) => {
    trusted(event);
    const systemId = parseIdentifier(systemInput, '系统标识');
    const matterId = parseIdentifier(matterInput, '事项标识');
    if (typeof keyInput !== 'string' || !keyInput || keyInput.length > 2_000) throw new Error('记录标识无效');
    return appRuntime.listRecordVersions(systemId, matterId, keyInput);
  });

  handle(IPC_CHANNELS.recordUpdate, async (event, systemInput: unknown, matterInput: unknown, keyInput: unknown, dataInput: unknown) => {
    trusted(event);
    const systemId = parseIdentifier(systemInput, '系统标识');
    const matterId = parseIdentifier(matterInput, '事项标识');
    if (typeof keyInput !== 'string' || !keyInput || keyInput.length > 2_000) throw new Error('记录标识无效');
    const data = parseRows([dataInput])[0];
    return appRuntime.updateLocalRecord(systemId, matterId, keyInput, data);
  });

  handle(IPC_CHANNELS.recordsExport, async (event, query: unknown, format: unknown, targetInput: unknown) => {
    trusted(event);
    const parsedQuery = parseLocalRecordQuery(query);
    if (format !== 'xlsx' && format !== 'csv' && format !== 'json') throw new Error('导出格式无效');
    const target = parseGovernmentExportTarget(targetInput);
    const task = await appRuntime.tasks.run('导出本地数据', () => appRuntime.exportLocalRecords(parsedQuery, undefined, format, confirmExportWarnings, target), { type: 'export' });
    if (task.status !== 'completed') throw new Error(task.error ?? '导出失败');
    if (!task.result) return null;
    await appRuntime.audit('export.created', undefined, undefined, task.id, { rowCount: task.result?.rowCount ?? 0, format, ...(target ? { target } : {}) });
    return task.result;
  });

  handle(IPC_CHANNELS.exportsOpenFolder, async (event, path: unknown) => {
    trusted(event);
    const directory = await appRuntime.exportFolder(path);
    return openExportFolder(path as string, directory);
  });

  handle(IPC_CHANNELS.settingsGet, async (event) => {
    trusted(event);
    return appRuntime.getSettings();
  });

  handle(IPC_CHANNELS.settingsUpdate, async (event, patch: unknown) => {
    trusted(event);
    return appRuntime.updateSettings(parseSettingsPatch(patch));
  });

  handle(IPC_CHANNELS.credentialsStatus, async (event, systemIdInput: unknown) => {
    trusted(event);
    const systemId = parseIdentifier(systemIdInput, '系统标识');
    await appRuntime.requireLicense(systemId);
    return appRuntime.credentialStatus(systemId);
  });

  handle(IPC_CHANNELS.credentialsSave, async (event, systemIdInput: unknown, accountInput: unknown, passwordInput: unknown) => {
    trusted(event);
    const systemId = parseIdentifier(systemIdInput, '系统标识');
    await appRuntime.requireLicense(systemId);
    if (typeof accountInput !== 'string' || !accountInput.trim() || accountInput.length > 200) throw new Error('请输入有效账号');
    if (typeof passwordInput !== 'string' || !passwordInput || passwordInput.length > 500) throw new Error('请输入有效密码');
    return appRuntime.saveCredentials(systemId, accountInput.trim(), passwordInput);
  });

  handle(IPC_CHANNELS.auditList, async (event) => {
    trusted(event);
    return appRuntime.listAudit();
  });

  handle(IPC_CHANNELS.diagnosticsList, async (event, queryInput: unknown) => {
    trusted(event);
    const value = queryInput && typeof queryInput === 'object' ? queryInput as Record<string, unknown> : {};
    const level = value.level;
    const query: OperationalLogQuery = {
      limit: typeof value.limit === 'number' && Number.isFinite(value.limit) ? Math.trunc(value.limit) : 500,
      level: level === 'info' || level === 'warn' || level === 'error' || level === 'all' ? level : 'all',
      keyword: typeof value.keyword === 'string' ? value.keyword.slice(0, 200) : '',
    };
    return operationalLog.list(query);
  });

  handle(IPC_CHANNELS.diagnosticsOpenFolder, async (event) => {
    trusted(event);
    const error = await shell.openPath(operationalLog.getDirectory());
    if (error) throw new Error(`无法打开日志目录：${error}`);
    return true;
  });

  handle(IPC_CHANNELS.diagnosticsExport, async (event) => {
    trusted(event);
    const selected = await dialog.showSaveDialog({
      title: '导出运行诊断日志',
      defaultPath: `数据融合助手诊断日志-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: '诊断日志', extensions: ['jsonl'] }],
    });
    if (selected.canceled || !selected.filePath) return null;
    return operationalLog.exportTo(selected.filePath);
  });

  handle(IPC_CHANNELS.diagnosticsReport, async (event, levelInput: unknown, sourceInput: unknown, messageInput: unknown) => {
    trusted(event);
    const level: OperationalLogLevel = levelInput === 'warn' || levelInput === 'error' ? levelInput : 'info';
    const source = typeof sourceInput === 'string' ? sourceInput.slice(0, 120) : 'renderer';
    const message = typeof messageInput === 'string' ? messageInput.slice(0, 12_000) : String(messageInput);
    operationalLog.write(level, source, message);
    return true;
  });

  handle(IPC_CHANNELS.updatesCheck, async (event) => {
    trusted(event);
    return options.updates ? options.updates.check() : appRuntime.checkUpdates();
  });

  handle(IPC_CHANNELS.updatesState, async event => { trusted(event); return options.updates?.snapshot(); });
  handle(IPC_CHANNELS.updatesDownload, async event => {
    trusted(event);
    if (!options.updates) throw new Error('自动更新模块未就绪');
    await options.updates.download(); return options.updates.snapshot();
  });

  handle(IPC_CHANNELS.updatesInstall, async (event) => {
    trusted(event);
    if (options.updates) { await options.updates.install(); return { launched: true }; }
    const task = await appRuntime.tasks.run('下载主程序更新', () => appRuntime.downloadAppUpdate(), { type: 'app-update' });
    if (task.status !== 'completed' || !task.result) throw new Error(task.error ?? '更新包下载失败');
    const launchError = await shell.openPath(task.result);
    if (launchError) throw new Error(`无法启动更新安装包：${launchError}`);
    return { launched: true };
  });

  handle(IPC_CHANNELS.systemsList, async (event) => {
    trusted(event);
    const grant = await appRuntime.currentGrant();
    if (!grant) return [];
    return Promise.all(
      appRuntime.plugins.list().filter((plugin) => grant.allowedSystems.includes(plugin.id)).map(async (plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        workspaceMode: plugin.workspaceMode ?? 'standard',
        supportsCredentialConfiguration: Boolean(plugin.supportsCredentialConfiguration),
        session: await plugin.getSessionState(),
      })),
    );
  });

  handle(IPC_CHANNELS.systemSession, async (event, systemId: unknown, force: unknown = false) => {
    trusted(event);
    const id = parseIdentifier(systemId, '系统标识');
    if (typeof force !== 'boolean') throw new Error('登录检测参数无效');
    await appRuntime.requireLicense(id);
    return requireSystem(id).getSessionState({ force });
  });

  handle(IPC_CHANNELS.systemLogin, async (event, systemId: unknown) => {
    trusted(event);
    const id = parseIdentifier(systemId, '系统标识');
    await appRuntime.requireLicense(id);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('主窗口不可用');
    const plugin = requireSystem(id);
    if (!plugin.loginPage) throw new Error('该业务系统未配置登录方式');
    const credentials = plugin.supportsCredentialConfiguration ? await appRuntime.credentialsForLogin(id) : null;
    const state = await plugin.getSessionState();
    loginTabController.open(window, plugin, credentials, state.status === 'authenticated' && plugin.sessionRecovery
      ? { url: plugin.sessionRecovery.homeUrl() } : {});
    return loginTabController.state();
  });

  handle(IPC_CHANNELS.publicationOpen, async (event, platformInput: unknown) => {
    trusted(event);
    const platform = publicationPlatform(platformInput);
    if (!platform) throw new Error('公示平台无效');
    await appRuntime.requireLicense(platform.ownerSystemId);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('主窗口不可用');
    loginTabController.open(window, {
      id: platform.id, name: platform.name,
      loginPage: { url: platform.url, allowedOrigin: platform.allowedOrigin, partition: platform.partition },
    }, null, { persistStorage: false });
    return loginTabController.state();
  });

  handle(IPC_CHANNELS.systemTabs, (event) => {
    trusted(event);
    return loginTabController.state();
  });

  handle(IPC_CHANNELS.systemTabActivate, async (event, systemId: unknown) => {
    trusted(event);
    const id = systemId === null ? null : parseIdentifier(systemId, '系统标识');
    if (id !== null) await appRuntime.requireLicense(sourceTabOwner(id));
    loginTabController.activate(id);
    return loginTabController.state();
  });

  handle(IPC_CHANNELS.systemLoginClose, async (event, systemId: unknown) => {
    trusted(event);
    const id = parseIdentifier(systemId, '系统标识');
    await loginTabController.flushSessionStorage();
    loginTabController.close(id);
    return loginTabController.state();
  });

  handle(IPC_CHANNELS.systemLoginReload, async (event, systemId: unknown) => {
    trusted(event);
    loginTabController.reload(parseIdentifier(systemId, '系统标识'));
    return true;
  });

  handle(IPC_CHANNELS.systemLoginBack, async (event, systemId: unknown) => {
    trusted(event);
    return loginTabController.back(parseIdentifier(systemId, '系统标识'));
  });

  handle(IPC_CHANNELS.systemLogout, async (event, systemId: unknown) => {
    trusted(event);
    const plugin = requireSystem(parseIdentifier(systemId, '系统标识'));
    await appRuntime.requireLicense(plugin.id);
    loginTabController.close(plugin.id);
    try { await plugin.auth.logout(); }
    finally { await appRuntime.forgetSession(plugin.id); }
    await appRuntime.audit('system.logout', plugin.id);
    return plugin.getSessionState();
  });

  handle(IPC_CHANNELS.mattersList, async (event, systemId: unknown) => {
    trusted(event);
    const plugin = requireSystem(parseIdentifier(systemId, '系统标识'));
    const grant = await appRuntime.requireLicense(plugin.id);
    const allowed = grant.allowedMatters?.[plugin.id];
    return plugin.matters
      .filter((matter) => !allowed || allowed.includes(matter.id))
      // IPC is a data boundary: do not spread runtime methods (e.g. mergeRecord) into the menu.
      .map((matter) => ({
        id: matter.id,
        name: matter.name,
        departmentId: matter.departmentId,
        departmentName: matter.departmentName,
        departmentOrder: matter.departmentOrder,
        matterOrder: matter.matterOrder,
        description: matter.description,
        querySchema: matter.querySchema,
        ...(matter.dateFilter ? { dateFilter: matter.dateFilter } : {}),
        executionMode: matter.executionMode,
        uniqueKey: matter.uniqueKey,
        ...(matter.listColumns ? { listColumns: matter.listColumns } : {}),
        defaultFilters: matter.createDefaultContext?.().filters ?? {},
      }));
  });

  handle(IPC_CHANNELS.matterRun, async (event, systemIdInput: unknown, matterIdInput: unknown, contextInput: unknown) => {
    trusted(event);
    const systemId = parseIdentifier(systemIdInput, '系统标识');
    const matterId = parseIdentifier(matterIdInput, '事项标识');
    const plugin = requireSystem(systemId);
    await appRuntime.requireLicense(systemId, matterId);
    const matter = plugin.matters.find((item) => item.id === matterId);
    if (!matter) throw new Error(`Unknown matter: ${matterId}`);
    assertMatterQueryAvailable(matter);
    const queryContext = parseQueryContext(contextInput);
    validateFilters(matter.querySchema, queryContext.filters);
    if (systemId === 'shenzhen-one-window') {
      const task = await (await appRuntime.oneWindow()).run(matterId, queryContext.filters);
      if (task.status !== 'completed') throw new Error(task.error ?? '一窗详情回流未完成');
      return { taskId: task.id, ...(task.result as Record<string, unknown>) };
    }
    const dateDetails = systemId === 'guangdong-hrss' ? hrssReturnDateDetails(matterId, queryContext.filters) : {
      startDate: queryContext.filters.startDate, endDate: queryContext.filters.endDate,
      ...(systemId === 'government-info' ? { dateBasis: 'bj_bjsj' } : {}),
    };
    const task = await appRuntime.tasks.run(
      `数据回流：${plugin.name} / ${matter.name}`,
      (context) => appRuntime.runOneClickReturn(systemId, matterId, context, queryContext),
      { type: 'data-return', systemId, matterId, details: dateDetails },
    );
    if (task.status !== 'completed') {
      await appRuntime.audit('query.failed', systemId, matterId, task.id, { error: task.error ?? '回流失败' });
      throw new Error(task.error ?? '数据回流失败');
    }
    await appRuntime.audit('sync.committed', systemId, matterId, task.id, task.result as Record<string, unknown>);
    return { taskId: task.id, ...task.result };
  });

  handle(
    IPC_CHANNELS.matterQuery,
    async (event, systemIdInput: unknown, matterIdInput: unknown, contextInput: unknown) => {
      trusted(event);
      const systemId = parseIdentifier(systemIdInput, '系统标识');
      const matterId = parseIdentifier(matterIdInput, '事项标识');
      const context = parseQueryContext(contextInput);
      const plugin = requireSystem(systemId);
      await appRuntime.requireLicense(systemId, matterId);
      if (systemId === 'shenzhen-one-window') throw new Error('请使用一窗业务详情回流，以保存完整批次并推送至后台');
      if (systemId === 'guangdong-hrss') throw new Error('请使用人社列表回流任务，以保证批次完整保存');
      const matter = plugin.matters.find((item) => item.id === matterId);
      if (!matter) throw new Error(`Unknown matter: ${matterId}`);
      assertMatterQueryAvailable(matter);
      validateFilters(matter.querySchema, context.filters);
      const task = await appRuntime.tasks.run(
        `查询：${plugin.name} / ${matter.name}`,
        async ({ report, signal }) => {
          await appRuntime.requireLicense(systemId, matterId);
          if ((await plugin.getSessionState()).status !== 'authenticated') throw new Error('请先登录该业务系统');
          await plugin.auth.getSessionForRequest();
          signal.throwIfAborted();
          report({ current: 0, total: 1, message: '正在请求业务系统' });
          const result = await matter.query({ ...context, signal });
          signal.throwIfAborted();
          return result;
        },
        { type: 'remote-query', systemId, matterId },
      );
      if (task.status !== 'completed') {
        await appRuntime.audit('query.failed', systemId, matterId, task.id, { error: task.error ?? '查询失败' });
        throw new Error(task.error ?? '查询失败');
      }
      await appRuntime.audit('query.completed', systemId, matterId, task.id, { total: task.result?.total ?? 0 });
      return task.result;
    },
  );

  handle(
    IPC_CHANNELS.syncPreview,
    async (event, systemIdInput: unknown, matterIdInput: unknown, rowsInput: unknown) => {
      trusted(event);
      const systemId = parseIdentifier(systemIdInput, '系统标识');
      const matterId = parseIdentifier(matterIdInput, '事项标识');
      await appRuntime.requireLicense(systemId, matterId);
      const task = await appRuntime.tasks.run(
        `同步预览：${systemId} / ${matterId}`,
        async ({ signal }) => {
          const preview = await appRuntime.createSyncPreview(systemId, matterId, parseRows(rowsInput));
          signal.throwIfAborted();
          return preview;
        },
        { type: 'sync-preview', systemId, matterId },
      );
      if (task.status !== 'completed') throw new Error(task.error ?? '同步预览失败');
      await appRuntime.audit('sync.previewed', systemId, matterId, task.id, task.result as unknown as Record<string, unknown>);
      return task.result;
    },
  );

  handle(IPC_CHANNELS.syncCommit, async (event, previewIdInput: unknown) => {
    trusted(event);
    const previewId = parseIdentifier(previewIdInput, '预览标识');
    const scope = appRuntime.syncPreviewScope(previewId);
    await appRuntime.requireLicense(scope.systemId, scope.matterId);
    const task = await appRuntime.tasks.run('提交本地同步', () => appRuntime.commitSyncPreview(previewId), { type: 'sync-commit', ...scope });
    if (task.status !== 'completed') throw new Error(task.error ?? '同步写入失败');
    await appRuntime.audit('sync.committed', undefined, undefined, task.id, task.result as unknown as Record<string, unknown>);
    return task.result;
  });
}
