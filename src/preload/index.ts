import type { TaskHistoryQuery } from '../core/storage/platform-store';
import type { RuntimeTask } from '../core/tasks/engine';
import type { PractitionerNumberConfig } from '../core/config/practitioner-numbers';
import { contextBridge, ipcRenderer } from 'electron';
import type { QueryContext } from '../core/query/types';
import { IPC_CHANNELS } from '../core/ipc/channels';
import type { SourceTabsState } from '../core/session/source-tabs';
import type { SessionState } from '../core/session/types';
import type { HealthImportResult, HealthPublicityState } from '../core/tools/health-publicity/types';
import type { ExportResult } from '../core/export/types';
import type { GovernmentExportTarget } from '../core/export/government-target';
import type { AutomaticUpdateState } from '../core/updater/automatic';
import type { ComponentSummary } from '../core/plugins/components';
import type { PublicationPlatformId } from '../core/publication/platforms';
import type { HrssDashboardData } from '../core/hrss/dashboard';
import type { AppSettings } from '../core/settings/types';

const desktopApi = {
  hrss: {
    dashboard: (): Promise<HrssDashboardData> => ipcRenderer.invoke(IPC_CHANNELS.hrssDashboardGet),
    openDashboard: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.hrssDashboardOpen),
    closeDashboard: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.hrssDashboardClose),
  },
  publications: {
    open: (platformId: PublicationPlatformId): Promise<SourceTabsState> => ipcRenderer.invoke(IPC_CHANNELS.publicationOpen, platformId),
  },
  practitionerNumbers: {
    get: (year: number): Promise<PractitionerNumberConfig[]> => ipcRenderer.invoke(IPC_CHANNELS.practitionerNumbersGet, year),
    save: (config: PractitionerNumberConfig): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.practitionerNumbersSave, config),
  },
  license: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.licenseStatus),
    activate: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.licenseActivate, key),
    importFile: () => ipcRenderer.invoke(IPC_CHANNELS.licenseImport),
    deactivate: () => ipcRenderer.invoke(IPC_CHANNELS.licenseDeactivate),
    refresh: () => ipcRenderer.invoke(IPC_CHANNELS.licenseRefresh),
    copyIdentifier: (kind: 'license' | 'device') => ipcRenderer.invoke(IPC_CHANNELS.licenseCopyIdentifier, kind) as Promise<void>,
  },
  backend: { status: (): Promise<{ origin: string; connected: boolean; insecure: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.backendStatus) },
  healthTool: {
    state: (): Promise<HealthPublicityState> => ipcRenderer.invoke(IPC_CHANNELS.healthToolState),
    importFiles: (): Promise<HealthImportResult | null> => ipcRenderer.invoke(IPC_CHANNELS.healthToolImport),
    update: (id: string, data: Record<string, string>): Promise<HealthPublicityState> => ipcRenderer.invoke(IPC_CHANNELS.healthToolUpdate, id, data),
    settings: (code: string): Promise<HealthPublicityState> => ipcRenderer.invoke(IPC_CHANNELS.healthToolSettings, code),
    remove: (id: string): Promise<HealthPublicityState> => ipcRenderer.invoke(IPC_CHANNELS.healthToolRemove, id),
    export: (ids: string[]): Promise<ExportResult | null> => ipcRenderer.invoke(IPC_CHANNELS.healthToolExport, ids),
  },
  exports: { openFolder: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.exportsOpenFolder, path) },
  modules: { list: () => ipcRenderer.invoke(IPC_CHANNELS.modulesList) },
  components: { list: (): Promise<ComponentSummary[]> => ipcRenderer.invoke(IPC_CHANNELS.componentsList) },
  tasks: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.tasksList),
    page: (query: TaskHistoryQuery): Promise<{ rows: RuntimeTask[]; total: number }> => ipcRenderer.invoke(IPC_CHANNELS.tasksPage, query),
    cancel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.taskCancel, id),
    output: (id: string, page = 1, pageSize = 100, keyword?: string) => ipcRenderer.invoke(IPC_CHANNELS.taskOutput, id, page, pageSize, keyword),
    exportOutput: (id: string, keyword?: string, target?: GovernmentExportTarget): Promise<ExportResult | null> => ipcRenderer.invoke(IPC_CHANNELS.taskOutputExport, id, keyword, target),
  },
  records: {
    list: (query?: Record<string, unknown>) => ipcRenderer.invoke(IPC_CHANNELS.recordsList, query),
    versions: (systemId: string, matterId: string, recordKey: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.recordVersions, systemId, matterId, recordKey),
    update: (systemId: string, matterId: string, recordKey: string, data: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC_CHANNELS.recordUpdate, systemId, matterId, recordKey, data),
    export: (query: Record<string, unknown>, format: 'xlsx' | 'csv' | 'json', target?: GovernmentExportTarget): Promise<ExportResult | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.recordsExport, query, format, target),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    update: (patch: Partial<Omit<AppSettings, 'locale'>>): Promise<AppSettings> => ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch),
  },
  credentials: {
    status: (systemId: string) => ipcRenderer.invoke(IPC_CHANNELS.credentialsStatus, systemId),
    save: (systemId: string, account: string, password: string) => ipcRenderer.invoke(IPC_CHANNELS.credentialsSave, systemId, account, password),
  },
  audit: { list: () => ipcRenderer.invoke(IPC_CHANNELS.auditList) },
  diagnostics: {
    list: (query?: { limit?: number; level?: 'info' | 'warn' | 'error' | 'all'; keyword?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.diagnosticsList, query),
    openFolder: () => ipcRenderer.invoke(IPC_CHANNELS.diagnosticsOpenFolder),
    export: () => ipcRenderer.invoke(IPC_CHANNELS.diagnosticsExport),
    report: (level: 'info' | 'warn' | 'error', source: string, message: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.diagnosticsReport, level, source, message),
  },
  updates: {
    check: () => ipcRenderer.invoke(IPC_CHANNELS.updatesCheck),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.updatesInstall),
    state: (): Promise<AutomaticUpdateState> => ipcRenderer.invoke(IPC_CHANNELS.updatesState),
    download: (): Promise<AutomaticUpdateState> => ipcRenderer.invoke(IPC_CHANNELS.updatesDownload),
    onChanged: (listener: (state: AutomaticUpdateState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: AutomaticUpdateState) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.updatesChanged, handler);
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.updatesChanged, handler); };
    },
  },
  systems: {
    tabs: (): Promise<SourceTabsState> => ipcRenderer.invoke(IPC_CHANNELS.systemTabs),
    activateTab: (systemId: string | null): Promise<SourceTabsState> => ipcRenderer.invoke(IPC_CHANNELS.systemTabActivate, systemId),
    onTabsChanged: (listener: (state: SourceTabsState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: SourceTabsState) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.systemTabsChanged, handler);
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.systemTabsChanged, handler); };
    },
    list: () => ipcRenderer.invoke(IPC_CHANNELS.systemsList),
    session: (systemId: string, force = false) => ipcRenderer.invoke(IPC_CHANNELS.systemSession, systemId, force),
    onSessionChanged: (listener: (state: SessionState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: SessionState) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.systemSessionChanged, handler);
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.systemSessionChanged, handler); };
    },
    login: (systemId: string) => ipcRenderer.invoke(IPC_CHANNELS.systemLogin, systemId),
    closeLogin: (systemId: string) => ipcRenderer.invoke(IPC_CHANNELS.systemLoginClose, systemId),
    reloadLogin: (systemId: string) => ipcRenderer.invoke(IPC_CHANNELS.systemLoginReload, systemId),
    backLogin: (systemId: string) => ipcRenderer.invoke(IPC_CHANNELS.systemLoginBack, systemId),
    logout: (systemId: string) => ipcRenderer.invoke(IPC_CHANNELS.systemLogout, systemId),
  },
  matters: {
    list: (systemId: string) => ipcRenderer.invoke(IPC_CHANNELS.mattersList, systemId),
    query: (systemId: string, matterId: string, context: QueryContext) =>
      ipcRenderer.invoke(IPC_CHANNELS.matterQuery, systemId, matterId, context),
    run: (systemId: string, matterId: string, context: QueryContext) => ipcRenderer.invoke(IPC_CHANNELS.matterRun, systemId, matterId, context),
  },
  sync: {
    preview: (systemId: string, matterId: string, rows: Record<string, unknown>[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.syncPreview, systemId, matterId, rows),
    commit: (previewId: string) => ipcRenderer.invoke(IPC_CHANNELS.syncCommit, previewId),
  },
};

contextBridge.exposeInMainWorld('desktopApi', desktopApi);

export type DesktopApi = typeof desktopApi;
