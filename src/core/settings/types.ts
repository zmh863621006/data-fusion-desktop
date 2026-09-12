export interface AppSettings {
  locale: 'zh-CN';
  autoCheckUpdates: boolean;
  defaultPageSize: number;
  exportDirectory?: string;
  taskConcurrency: number;
  retainAuditDays: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  locale: 'zh-CN',
  autoCheckUpdates: true,
  defaultPageSize: 50,
  taskConcurrency: 2,
  retainAuditDays: 180,
};

export interface SettingsStore {
  get(): Promise<AppSettings>;
  update(patch: Partial<AppSettings>): Promise<AppSettings>;
}
