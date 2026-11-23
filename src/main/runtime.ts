import { PractitionerNumbers, type PractitionerNumberConfig } from '../core/config/practitioner-numbers';
import { DefaultPluginRegistry, sourceOrigins } from '../core/plugins/types';
import { publicationPlatformsForSystem } from '../core/publication/platforms';
import { marketAccessPlugin } from '../plugins/market-access';
import { configureGovernmentInfoSessionPersistence, governmentInfoPlugin } from '../plugins/government-info';
import { configurePractitionerCredentials, transportPractitionerPlugin } from '../plugins/transport-practitioner';
import { configureOversizeTransportCredentials, oversizeTransportPlugin } from '../plugins/oversize-transport';
import { configureOnlineCarPermitCredentials, onlineCarPermitPlugin } from '../plugins/online-car-permit';
import { createGuangdongHrssPlugin } from '../plugins/guangdong-hrss';
import { createShenzhenHazardousPlugin } from '../plugins/shenzhen-hazardous-chemicals';
import { HAZCHEM_SYSTEM_ID, HAZCHEM_SYSTEM_NAME } from '../plugins/shenzhen-hazardous-chemicals/catalog';
import { createSpecialEquipmentPlugin } from '../plugins/guangdong-special-equipment';
import { EQUIPMENT_SYSTEM_ID, EQUIPMENT_SYSTEM_NAME, EQUIPMENT_VERSION } from '../plugins/guangdong-special-equipment/catalog';
import { createFoodDrugPlugin } from '../plugins/guangdong-food-drug';
import { FOOD_DRUG_SYSTEM_ID, FOOD_DRUG_SYSTEM_NAME, FOOD_DRUG_VERSION } from '../plugins/guangdong-food-drug/catalog';
import { buildHrssDashboard } from '../core/hrss/dashboard';
import { NodeSqliteDriver } from '../core/storage/database';
import { SqliteLocalRepository } from '../core/storage/sqlite-repository';
import { DefaultLocalSyncEngine } from '../core/sync/engine';
import { TaskEngine } from '../core/tasks/engine';
import type { SyncSummary } from '../core/sync/types';
import { LocalLicenseService } from '../core/license/local-license-service';
import { OnlineLicenseMonitor } from '../core/license/online-monitor';
import { EnterpriseEnrichmentService, enterpriseInput, mergeEnterpriseRecord } from '../core/enterprise/service';
import type { LicenseGrant } from '../core/license/types';
import { assertSystemLicensed } from '../core/license/gate';
import { join } from 'node:path';
import { SqlitePlatformStore, type LocalRecordQuery, type TaskHistoryQuery } from '../core/storage/platform-store';
import type { AppSettings } from '../core/settings/types';
import type { AuditEventType } from '../core/audit/types';
import { LocalExportService } from '../core/export/local-export-service';
import type { ExportFormat } from '../core/export/types';
import { assertGovernmentExportTarget, GOVERNMENT_EXPORT_LABELS, type GovernmentExportTarget } from '../core/export/government-target';
import { ApplicationExportDirectory, type ExportIdentity } from '../core/export/export-directory';
import type { ConfirmExport } from '../core/double-publicity/validation';
import { assertFeatureLicensed } from '../core/license/gate';
import { UpdateService, runtimeUpdateTarget, type UpdateArtifact, type DownloadProgress } from '../core/updater/service';
import { buildRecordKey } from '../core/sync/engine';
import type { TaskContext } from '../core/tasks/engine';
import type { QueryContext } from '../core/query/types';
import type { StoredRecord } from '../core/storage/types';
import { SecureCredentialStore } from './credential-store';
import { SecureSessionStore } from './session-store';
import { SessionRecoveryService } from './session-recovery';
import { loginTabController } from './login-tab';
import type { BrowserWindow } from 'electron';
import { backendConfiguration } from '../core/config/backend';
import { releaseTrustedKey } from '../core/config/release-trust';
import { HealthPublicityService } from '../core/tools/health-publicity/service';
import { assertToolLicensed } from '../core/license/gate';
import toolCatalog from '../core/tools/catalog.json';
import type { ComponentSummary } from '../core/plugins/components';
import { installSourceCertificateVerifiers } from './source-certificate-trust';
import { HRSS_SOURCE_CERTIFICATE_TRUST } from '../core/config/source-certificate-pins';
import { businessBootstrapContext } from './business-bootstrap-context';

const PRODUCT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAn2Th5TQoO3juKQte8Ai+
/C4t/Oa11amYGoiNxDe95TxgmlhPeBR5xHoS8937amVNiEPvx0bjk6b5801km1s9
/e0YuSQUE7UVQgYzbC2QEGlvfvw8ZUmJeAjje3lJJQ9jxKgRpiyF4SN7p70PbMBd
eEzjOLqEZKPqeTLTNhdbYu1Ag+Zc6NVWvkRqP8dMt4Iub64hCMib0p7GblJc3TB6
DfzpUlxRCKTnZ8INRft9TGV/3gBJQV28MvOa/NZsCXXqaS5XyWE7OIfkpx7LlAsx
96DO/x6UIIYToHY75p0lBaU1Xq7dHMVYt0yhXbw2KFbottcxlIZ/47vqSOBGHsrx
cu/nH92sN0tv+hWeQTG5A50Tu1/MDmHRiQzPg5gAsvqMmj5+QxEJROaLtL7k51Es
c/je/tkNQnVphb+BMM40jmA2xU7uNNfwc2Kf5EpwemttCUex7LBm3HUmnX+vmxQ4
b1oByVzE+8Uj5k4ApNg1P0JX3kxWn0qhcUFtRxsMO/nPAgMBAAE=
-----END PUBLIC KEY-----`;

const builtinModules = [
  {
    id: FOOD_DRUG_SYSTEM_ID, name: FOOD_DRUG_SYSTEM_NAME, version: FOOD_DRUG_VERSION, publisher: '数据融合助手',
    description: '食品生产和第三类医疗器械经营许可回流及双公示导出',
  },
  {
    id: EQUIPMENT_SYSTEM_ID, name: EQUIPMENT_SYSTEM_NAME, version: EQUIPMENT_VERSION, publisher: '数据融合助手',
    description: '特种设备使用登记、作业人员考核及双公示导出',
  },
  {
    id: HAZCHEM_SYSTEM_ID, name: HAZCHEM_SYSTEM_NAME, version: '0.1.0', publisher: '数据融合助手',
    description: '已办流程结束记录关联制证数据，生成省执法和南山双公示',
  },
  {
    id: 'market-access', name: '广东省市场准入系统', version: '1.0.0', publisher: '数据融合助手',
    description: '市场准入业务办理查询与本地回流',
  },
  {
    id: 'government-info', name: '政务综合信息平台', version: '1.0.0', publisher: '数据融合助手',
    description: '双公示审批数据回流',
  },
  {
    id: 'transport-practitioner', name: '广东省道路运输从业人员管理服务平台', version: '0.1.0', publisher: '数据融合助手',
    description: '从业人员行政许可双公示数据回流',
  },
  {
    id: 'oversize-transport', name: '广东省交通运输厅大件运输许可系统', version: '0.1.0', publisher: '数据融合助手',
    description: '通过公路路政平台登录大件运输3.0，按办理日期回流惠州许可数据',
  },
  {
    id: 'online-car-permit', name: '惠州市网约车监管系统（车证）', version: '0.1.0', publisher: '数据融合助手',
    description: '网络预约出租汽车运输证双公示数据回流',
  },
  {
    id: 'guangdong-hrss', name: '广东省集中式人力资源和社会保障一体化门户系统', version: '0.1.0', publisher: '数据融合助手',
    description: '就业服务与补贴列表回流、本地业务台账及全屏数据看板',
  },
];

interface PendingSyncPreview {
  systemId: string;
  matterId: string;
  createdAt: number;
  summary: SyncSummary<Record<string, unknown>>;
}

export interface SyncPreviewReceipt {
  previewId: string;
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
}

export class AppRuntime {
  readonly plugins = new DefaultPluginRegistry();
  tasks = new TaskEngine();
  private repository?: SqliteLocalRepository;
  practitionerNumbers?: PractitionerNumbers;
  private syncEngine?: DefaultLocalSyncEngine;
  private platformStore?: SqlitePlatformStore;
  private readonly exportService = new LocalExportService();
  private exportDirectory?: ApplicationExportDirectory;
  private updateService?: UpdateService;
  private credentialStore?: SecureCredentialStore;
  private appVersion = '0.0.0';
  private userDataPath = '';
  license?: LocalLicenseService;
  private readonly pendingPreviews = new Map<string, PendingSyncPreview>();
  private sessionRecovery?: SessionRecoveryService;
  private sessionStore?: SecureSessionStore;
  private shuttingDown = false;
  private licenseMonitor?: OnlineLicenseMonitor;
  private enterpriseService?: EnterpriseEnrichmentService;
  private healthPublicityService?: HealthPublicityService;
  private activeBusinessOperations = 0;
  private updateInstallation = false;
  private hrssReturning = false;

  async businessOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.updateInstallation || this.shuttingDown) throw new Error('应用正在保存并更新，请稍后再操作');
    this.activeBusinessOperations++;
    try { return await operation(); } finally { this.activeBusinessOperations--; }
  }
  updateBusy(): boolean {
    return this.activeBusinessOperations > 0 || this.tasks.list().some(task => ['queued', 'running'].includes(task.status) && task.type !== 'app-update');
  }
  beginUpdateInstallation(): void {
    if (this.shuttingDown || this.updateInstallation || this.updateBusy()) throw new Error('请等待查询、回流或导出完成后更新');
    this.updateInstallation = true;
  }
  cancelUpdateInstallation(): void { if (!this.shuttingDown) this.updateInstallation = false; }

  async initialize(userDataPath: string, allowDevelopmentLicense: boolean, appVersion: string, exportDirectory?: string): Promise<void> {
    this.appVersion = appVersion;
    this.userDataPath = userDataPath;
    if (exportDirectory) this.exportDirectory = new ApplicationExportDirectory(exportDirectory);
    const database = new NodeSqliteDriver(join(userDataPath, 'data-fusion.sqlite'));
    const repository = new SqliteLocalRepository(database);
    await repository.initialize();
    this.repository = repository;
    this.syncEngine = new DefaultLocalSyncEngine(repository);
    this.practitionerNumbers = new PractitionerNumbers(database);
    await this.practitionerNumbers.initialize();
    this.platformStore = new SqlitePlatformStore(database);
    await this.platformStore.initialize();
    this.healthPublicityService = new HealthPublicityService(database);
    await this.healthPublicityService.initialize();
    await this.platformStore.recoverInterruptedTasks();
    this.tasks = new TaskEngine(this.platformStore, (await this.platformStore.get()).taskConcurrency);

    const backend = backendConfiguration(process.env, businessBootstrapContext()?.backend);
    this.license = new LocalLicenseService({
      storagePath: join(userDataPath, 'license.json'),
      publicKeyPem: releaseTrustedKey(PRODUCT_PUBLIC_KEY, process.env.DATA_FUSION_LICENSE_PUBLIC_KEY, allowDevelopmentLicense),
      activationEndpoint: backend.activationUrl,
      statusEndpoint: backend.statusUrl,
      allowDevelopmentLicense,
    });
    await this.license.refreshOnline().catch((error) => console.warn('在线授权状态刷新失败，将使用本地签名授权', error));
    this.enterpriseService = new EnterpriseEnrichmentService(backend.enterpriseUrl,
      () => this.license!.enterpriseAuthorization(), fetch, backend.insecureHttpOrigin);
    this.updateService = new UpdateService(backend.updateUrl, releaseTrustedKey(PRODUCT_PUBLIC_KEY, process.env.DATA_FUSION_UPDATE_PUBLIC_KEY, allowDevelopmentLicense), runtimeUpdateTarget(process.platform, process.arch));
    this.credentialStore = new SecureCredentialStore(join(userDataPath, 'credentials.secure.json'));
    const sessionStore = new SecureSessionStore(join(userDataPath, 'sessions.secure.json'));
    this.sessionStore = sessionStore;
    configureGovernmentInfoSessionPersistence({
      load: () => sessionStore.get('government-info.lid'),
      save: (lid) => sessionStore.set('government-info.lid', lid),
      clear: () => sessionStore.delete('government-info.lid'),
    });
    const credentialBindings = [
      ['transport-practitioner', configurePractitionerCredentials],
      ['oversize-transport', configureOversizeTransportCredentials],
      ['online-car-permit', configureOnlineCarPermitCredentials],
    ] as const;
    for (const [systemId, configure] of credentialBindings) {
      const credentials = await this.credentialStore.get(systemId).catch((error) => { console.warn(`${systemId} 登录配置读取失败`, error); return null; });
      if (credentials) configure(credentials);
    }
    this.plugins.register(marketAccessPlugin);
    this.plugins.register(governmentInfoPlugin);
    this.plugins.register(transportPractitionerPlugin);
    this.plugins.register(oversizeTransportPlugin);
    this.plugins.register(onlineCarPermitPlugin);
    this.plugins.register(createGuangdongHrssPlugin());
    this.plugins.register(createShenzhenHazardousPlugin());
    this.plugins.register(createSpecialEquipmentPlugin());
    this.plugins.register(createFoodDrugPlugin());
    const plugins = this.plugins.list();
    const sources = plugins.flatMap(({ id, loginPage }) => [
      ...(loginPage ? [{ partition: loginPage.partition, origins: sourceOrigins(loginPage) }] : []),
      ...publicationPlatformsForSystem(id).map(({ partition, allowedOrigin }) => ({ partition, origins: [allowedOrigin] })),
    ]);
    await installSourceCertificateVerifiers(sources, { ...HRSS_SOURCE_CERTIFICATE_TRUST, vault: sessionStore })
      .catch(() => console.warn('原系统公共证书复验配置未能完整加载，将继续使用内置浏览器的证书校验'));
    for (const plugin of plugins) await plugin.initialize();
    this.sessionRecovery = new SessionRecoveryService(sessionStore);
    for (const plugin of this.plugins.list()) await this.sessionRecovery.register(plugin);
    loginTabController.configurePersistence({
      load: (id) => this.sessionRecovery!.storage(id),
      save: (id, value) => this.sessionRecovery!.saveStorage(id, value),
      forget: (id) => {
        const plugin = this.plugins.get(id);
        const awaitApiLogin = Boolean(plugin?.sessionRecovery?.apiCredentials || plugin?.loginPage?.browserAuth);
        return this.sessionRecovery!.forget(id, { awaitApiLogin });
      },
    });
    this.licenseMonitor = new OnlineLicenseMonitor(() => this.license!.refreshOnline());
    this.licenseMonitor.start();
  }

  async restoreSourceTabs(window: BrowserWindow): Promise<void> {
    if (!this.sessionRecovery || this.shuttingDown || window.isDestroyed()) return;
    const initialActivity = loginTabController.activityVersion();
    const closeVersions = new Map(this.plugins.list().map((plugin) => [plugin.id, loginTabController.closeVersion(plugin.id)]));
    const grant = await this.currentGrant();
    if (!grant || grant.expiresAt <= Date.now()) return;
    const recovered = await this.sessionRecovery.recoverableSystems(grant.allowedSystems);
    const currentGrant = await this.currentGrant();
    if (this.shuttingDown || window.isDestroyed() || !currentGrant || currentGrant.expiresAt <= Date.now()) return;
    for (const id of recovered) {
      if (!currentGrant.allowedSystems.includes(id) || !this.sessionRecovery.canRestore(id)
        || loginTabController.closeVersion(id) !== closeVersions.get(id)) continue;
      const plugin = this.plugins.get(id);
      if (!plugin?.sessionRecovery) continue;
      // Do not interrupt a tab the user has already opened while validation was running.
      if (!loginTabController.state().tabs.some((tab) => tab.systemId === id)) {
        loginTabController.open(window, plugin, null, { url: plugin.sessionRecovery!.homeUrl(), background: true });
      }
    }
    const state = loginTabController.state();
    if (!window.isDestroyed() && loginTabController.activityVersion() === initialActivity
      && !state.activeSystemId && state.tabs.length && recovered.includes(state.tabs[0].systemId)) {
      loginTabController.activate(state.tabs[0].systemId);
    }
  }

  async forgetSession(systemId: string): Promise<void> { await this.sessionRecovery?.forget(systemId); }

  async currentGrant(): Promise<LicenseGrant | null> {
    return this.license?.getCurrent() ?? null;
  }

  async healthTool(): Promise<HealthPublicityService> {
    assertToolLicensed(await this.currentGrant(), 'health-publicity');
    if (!this.healthPublicityService) throw new Error('卫健局双公示工具尚未就绪');
    return this.healthPublicityService;
  }

  async backendStatus() {
    const origin = new URL(backendConfiguration(process.env, businessBootstrapContext()?.backend).activationUrl).origin;
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5000) });
      const body = await response.json() as { status?: string };
      return { origin, connected: response.ok && body.status === 'ok', insecure: origin.startsWith('http:') };
    } catch { return { origin, connected: false, insecure: origin.startsWith('http:') }; }
  }

  async exportHealthDocuments(ids: string[], path?: string, confirm?: ConfirmExport) {
    const tool = await this.healthTool();
    assertFeatureLicensed(await this.currentGrant(), 'export');
    let records = await tool.records(ids);
    if (this.enterpriseService) {
      const enriched = await this.enterpriseService.enrich('health-publicity', 'word-to-publicity', records.map(record => record.data));
      await tool.applyEnterpriseResults(records, enriched);
      records = await tool.records(ids);
    }
    return this.exportRecords(records, 'xlsx', { businessName: '卫健局双公示工具' }, path, confirm);
  }

  private businessName(systemId: string, matterId: string): string {
    const plugin = this.plugins.get(systemId);
    return plugin?.matters.find(matter => matter.id === matterId)?.name ?? plugin?.name ?? matterId;
  }

  private async exportRecords(records: StoredRecord[], format: ExportFormat, identity: ExportIdentity, path?: string, confirm?: ConfirmExport, target?: GovernmentExportTarget) {
    assertGovernmentExportTarget(target, format, records.map(record => record.systemId));
    if (target) identity = { ...identity, businessName: `${GOVERNMENT_EXPORT_LABELS[target]}-${identity.businessName}` };
    const isHrss = records.some(record => record.systemId === 'guangdong-hrss');
    const listColumns = isHrss ? [...new Map(records.flatMap(record =>
      this.plugins.get(record.systemId)?.matters.find(matter => matter.id === record.matterId)?.listColumns ?? []).map(column => [column.key, column])).values()] : undefined;
    if (isHrss) identity = { ...identity, kind: 'list-ledger' };
    if (path) return this.exportService.export(path, format, records, confirm, listColumns, target);
    if (!this.exportDirectory) throw new Error('固定导出目录尚未就绪，请重新启动应用');
    let confirmed: boolean | undefined;
    const confirmOnce: ConfirmExport | undefined = confirm ? async (validation, targetFormat) => {
      if (confirmed === undefined) confirmed = await confirm(validation, targetFormat);
      return confirmed;
    } : undefined;
    return this.exportDirectory.export(records, identity, format, destination => this.exportService.export(destination, format, records, confirmOnce, listColumns, target));
  }

  async exportFolder(path: unknown): Promise<string> {
    if (!this.exportDirectory) throw new Error('固定导出目录尚未就绪');
    return this.exportDirectory.folderForExport(path);
  }

  async requireLicense(systemId: string, matterId?: string): Promise<LicenseGrant> {
    const grant = await this.currentGrant();
    assertSystemLicensed(grant, systemId, matterId);
    return grant!;
  }

  async listPractitionerNumbers(year: number): Promise<PractitionerNumberConfig[]> {
    const systemId = 'transport-practitioner';
    const grant = await this.requireLicense(systemId);
    if (!this.practitionerNumbers) throw new Error('编号模块未就绪');
    const configs = await this.practitionerNumbers.list(year, grant.allowedMatters?.[systemId]);
    const latest = (await this.requireLicense(systemId)).allowedMatters?.[systemId];
    return latest ? configs.filter(config => latest.includes(config.matterId)) : configs;
  }

  async savePractitionerNumber(config: PractitionerNumberConfig): Promise<void> {
    const numbers = this.practitionerNumbers;
    if (!numbers || !this.platformStore) throw new Error('编号模块未就绪');
    await this.platformStore.transaction(async () => {
      await this.requireLicense('transport-practitioner', config.matterId);
      await numbers.save(config);
    });
  }

  async hrssDashboard() {
    const systemId = 'guangdong-hrss';
    const grant = await this.requireLicense(systemId);
    if (!this.platformStore) throw new Error('本地人社台账尚未就绪');
    const allowed = grant.allowedMatters?.[systemId];
    const matterIds = this.plugins.get(systemId)!.matters.filter(matter => !allowed || allowed.includes(matter.id)).map(matter => matter.id);
    const snapshot = await this.platformStore.successfulSnapshots(systemId, matterIds);
    const latestGrant = await this.requireLicense(systemId);
    for (const matterId of matterIds) assertSystemLicensed(latestGrant, systemId, matterId);
    return buildHrssDashboard({ allowedMatterIds: matterIds, records: snapshot.records,
      tasks: snapshot.tasks.map(task => ({ ...task, matterId: task.matterId! })) });
  }

  async audit(type: AuditEventType, systemId?: string, matterId?: string, taskId?: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.platformStore?.append({ id: globalThis.crypto.randomUUID(), type, systemId, matterId, taskId, metadata, createdAt: Date.now() });
  }

  async listLocalRecords(query: LocalRecordQuery) {
    if (!this.platformStore) throw new Error('本地数据模块未就绪');
    const grant = await this.currentGrant();
    if (!grant || grant.expiresAt <= Date.now()) throw new Error('请先激活软件');
    if (query.systemId) await this.requireLicense(query.systemId, query.matterId);
    const accessScopes = grant.allowedSystems.map(systemId => ({ systemId, matterIds: grant.allowedMatters?.[systemId] }));
    const result = await this.platformStore.listRecords({ ...query, accessScopes });
    await this.refreshEnterpriseRecords(result.rows, true);
    return result;
  }

  private async refreshEnterpriseRecords<T extends { systemId: string; matterId: string; recordKey: string; data: Record<string, unknown> }>(records: T[], readLatestLedger = false): Promise<void> {
    if (!this.enterpriseService || !this.platformStore) return;
    const groups = new Map<string, T[]>();
    for (const row of records) {
      const key = `${row.systemId}:${row.matterId}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
    for (const rows of groups.values()) {
      const { systemId, matterId } = rows[0];
      if (systemId === 'guangdong-hrss') continue;
      const enriched = await this.enterpriseService.enrich(systemId, matterId, rows.map(row => row.data));
      const matter = this.plugins.get(systemId)?.matters.find(item => item.id === matterId);
      for (let i = 0; i < rows.length; i++) {
        if (JSON.stringify(rows[i].data) === JSON.stringify(enriched[i])) continue;
        if (matter && buildRecordKey(enriched[i], matter.uniqueKey) !== rows[i].recordKey) continue;
        await this.platformStore.applyEnterpriseEnrichment(systemId, matterId, rows[i].recordKey, rows[i].data, enriched[i]);
        rows[i].data = readLatestLedger
          ? (await this.repository?.find(systemId, matterId, rows[i].recordKey))?.data ?? enriched[i]
          : enriched[i];
      }
    }
  }

  async exportLocalRecords(query: LocalRecordQuery, path: string | undefined, format: ExportFormat, confirm?: ConfirmExport, target?: GovernmentExportTarget) {
    assertFeatureLicensed(await this.currentGrant(), 'export');
    if (target) assertGovernmentExportTarget(target, format, [query.systemId ?? '']);
    if (!this.platformStore) throw new Error('本地数据模块未就绪');
    const records = await this.platformStore.recordsForExport(query);
    if (records.length === 0) throw new Error('当前筛选条件没有可导出的数据');
    const matters = new Map(records.map(record => [`${record.systemId}:${record.matterId}`, record]));
    for (const record of matters.values()) await this.requireLicense(record.systemId, record.matterId);
    await this.refreshEnterpriseRecords(records);
    const names = [...new Set([...matters.values()].map(record => this.businessName(record.systemId, record.matterId)))];
    return this.exportRecords(records, format, { businessName: names.length > 3 ? `${names.slice(0, 3).join('、')}等${names.length}项业务` : names.join('、') }, path, confirm, target);
  }

  async listRecordVersions(systemId: string, matterId: string, recordKey: string) {
    await this.requireLicense(systemId, matterId);
    if (!this.repository) throw new Error('本地数据模块未就绪');
    return this.repository.listVersions(systemId, matterId, recordKey);
  }

  async updateLocalRecord(systemId: string, matterId: string, recordKey: string, data: Record<string, unknown>) {
    await this.requireLicense(systemId, matterId);
    if (systemId === 'guangdong-hrss') throw new Error('人社列表台账只读，请重新回流更新源系统数据');
    const matter = this.plugins.get(systemId)?.matters.find((item) => item.id === matterId);
    if (!matter || !this.platformStore) throw new Error('业务事项数据模块未就绪');
    const newRecordKey = buildRecordKey(data, matter.uniqueKey);
    const updated = await this.platformStore.updateRecord(systemId, matterId, recordKey, newRecordKey, data);
    await this.audit('record.updated', systemId, matterId, undefined, { oldRecordKey: recordKey, newRecordKey });
    return updated;
  }

  async taskPage(query: TaskHistoryQuery) {
    if (!this.platformStore) throw new Error('任务模块未就绪');
    const grant = await this.currentGrant();
    if (query.systemId) assertSystemLicensed(grant, query.systemId, query.matterId);
    if (!grant || grant.expiresAt <= Date.now()) return { rows: [], total: 0 };
    const scopes = grant.allowedSystems.map(systemId => ({ systemId, matterIds: grant.allowedMatters?.[systemId] }));
    return this.platformStore.taskPage(query, scopes);
  }

  async cancelTask(id: string) {
    const task = this.tasks.get(id);
    if (!task?.systemId || !task.matterId) return false;
    await this.requireLicense(task.systemId, task.matterId);
    return this.tasks.cancel(id);
  }

  async listTaskOutput(taskId: string, page?: number, pageSize?: number, keyword?: string) {
    if (!this.platformStore) throw new Error('任务结果模块未就绪');
    const task = await this.platformStore.getTask(taskId);
    if (task?.type !== 'data-return' || !task.systemId || !task.matterId) throw new Error('回流批次不存在');
    await this.requireLicense(task.systemId, task.matterId);
    const result = await this.platformStore.listTaskOutput(taskId, page, pageSize, keyword);
    await this.refreshEnterpriseRecords(result.rows);
    return this.platformStore.listTaskOutput(taskId, page, pageSize, keyword);
  }

  async exportTaskOutput(taskId: string, path?: string, keyword?: string, confirm?: ConfirmExport, target?: GovernmentExportTarget) {
    assertFeatureLicensed(await this.currentGrant(), 'export');
    if (!this.platformStore) throw new Error('任务结果模块未就绪');
    const task = await this.platformStore.getTask(taskId);
    if (task?.type !== 'data-return' || !task.systemId || !task.matterId) throw new Error('回流批次不存在');
    assertGovernmentExportTarget(target, 'xlsx', [task.systemId]);
    await this.requireLicense(task.systemId, task.matterId);
    const rows = await this.platformStore.taskRowsForExport(taskId, keyword);
    const records: StoredRecord[] = rows.map(row => ({
      systemId: row.systemId, matterId: row.matterId, recordKey: row.recordKey, data: row.data,
      firstSeenAt: task.createdAt, updatedAt: task.finishedAt ?? task.createdAt,
    }));
    if (records.length === 0) throw new Error('当前批次没有可导出的数据');
    if (this.enterpriseService && task.systemId !== 'guangdong-hrss') {
      const enriched = await this.enterpriseService.enrich(task.systemId, task.matterId, records.map(row => row.data));
      for (let i = 0; i < records.length; i++) {
        await this.platformStore.applyEnterpriseEnrichment(task.systemId, task.matterId, records[i].recordKey, records[i].data, enriched[i]);
        records[i].data = enriched[i];
      }
    }
    return this.exportRecords(records, 'xlsx', {
      businessName: this.businessName(task.systemId, task.matterId),
      startDate: task.details?.dateFilterStatus === 'pending' ? undefined : task.details?.startDate,
      endDate: task.details?.dateFilterStatus === 'pending' ? undefined : task.details?.endDate,
    }, path, confirm, target);
  }

  async runOneClickReturn(systemId: string, matterId: string, context: TaskContext, requestedContext?: QueryContext) {
    const plugin = this.plugins.get(systemId);
    const matter = plugin?.matters.find((item) => item.id === matterId);
    await this.requireLicense(systemId, matterId);
    if (!plugin || !matter || !this.syncEngine || !this.platformStore) throw new Error('数据回流模块未就绪');
    if (matter.executionMode !== 'one-click-return' || !matter.createDefaultContext) throw new Error('该业务事项不支持一键回流');
    if ((await plugin.getSessionState()).status !== 'authenticated') throw new Error('请先登录该业务系统');
    await plugin.auth.getSessionForRequest();

    context.report({ current: 1, total: 4, message: '正在从业务系统提取数据' });
    const defaults = matter.createDefaultContext();
    const queryContext = requestedContext
      ? { ...defaults, ...requestedContext, filters: { ...defaults.filters, ...requestedContext.filters } }
      : defaults;
    if (systemId === 'guangdong-hrss') {
      if (this.hrssReturning) throw new Error('人社列表回流正在进行，请等待当前任务完成后再开始');
      this.hrssReturning = true;
      try {
        const result = await matter.query({ ...queryContext, signal: context.signal, onProgress: context.report });
        if (context.signal.aborted) throw new Error('任务已取消');
        const summary = await this.syncEngine.preview(systemId, matterId, matter.uniqueKey, result.rows);
        context.report({ current: 0, total: summary.total, message: '全部列表获取完成，正在保存成功批次' });
        await this.requireLicense(systemId, matterId);
        await this.platformStore.transaction(async () => {
          if (context.signal.aborted) throw new Error('任务已取消');
          await this.syncEngine!.commit(systemId, matterId, summary);
          await this.platformStore!.replaceTaskOutput(context.taskId, systemId, matterId,
            summary.changes.map(change => ({ recordKey: change.key, data: change.current })));
          if (context.signal.aborted) throw new Error('任务已取消');
        });
        context.report({ current: summary.total, total: summary.total, message: `列表回流完成，共 ${summary.total} 条` });
        return { total: summary.total, inserted: summary.inserted, updated: summary.updated, unchanged: summary.unchanged };
      } finally { this.hrssReturning = false; }
    }
    const result = await matter.query({ ...queryContext, signal: context.signal, onProgress: context.report });
    if (context.signal.aborted) throw new Error('任务已取消');

    const localRows: Record<string, unknown>[] = [];
    for (const row of result.rows) {
      if (context.signal.aborted) throw new Error('任务已取消');
      if (!enterpriseInput(systemId, row) || !this.repository) { localRows.push(row); continue; }
      const previous = await this.repository.find(systemId, matterId, buildRecordKey(row, matter.uniqueKey));
      let reused = previous ? mergeEnterpriseRecord(systemId, row, previous.data) : row;
      // A matching local traffic record may also contain manually verified fields.
      // Fill blanks only; never let older local data replace a fresh source value.
      if (previous && ['oversize-transport', 'online-car-permit'].includes(systemId)
        && String(row.xkXdrMc ?? '').trim() === String(previous.data.xkXdrMc ?? '').trim()
        && (!String(row.xkXdrShxym ?? '').trim() || !String(previous.data.xkXdrShxym ?? '').trim()
          || row.xkXdrShxym === previous.data.xkXdrShxym)) {
        reused = { ...reused };
        for (const key of ['xkFrdb', 'xkXdrShxym']) {
          if (!String(reused[key] ?? '').trim() && String(previous.data[key] ?? '').trim()) reused[key] = previous.data[key];
        }
      }
      localRows.push(reused);
    }
    const enterpriseCandidates = localRows.filter(row => enterpriseInput(systemId, row)).length;
    context.report({ current: 2, total: 4, message: enterpriseCandidates
      ? `已提取 ${result.rows.length} 条，正在补充 ${enterpriseCandidates} 条缺失的企业法人或信用代码`
      : `已提取 ${result.rows.length} 条，正在去重比对` });
    const enriched = this.enterpriseService ? await this.enterpriseService.enrich(systemId, matterId, localRows, context.signal) : localRows;
    if (context.signal.aborted) throw new Error('任务已取消');
    context.report({ current: 3, total: 4, message: '正在保存本次回流数据' });
    const commitRows = async (numbered: Record<string, unknown>[]) => {
      const summary = await this.syncEngine!.preview(systemId, matterId, matter.uniqueKey, numbered,
        (incoming, previous) => mergeEnterpriseRecord(systemId, matter.mergeRecord ? matter.mergeRecord(incoming, previous) : incoming, previous));
      if (context.signal.aborted) throw new Error('任务已取消');
      await this.syncEngine!.commit(systemId, matterId, summary);
      await this.platformStore!.replaceTaskOutput(context.taskId, systemId, matterId,
        summary.changes.map(change => ({ recordKey: change.key, data: change.current })));
      if (context.signal.aborted) throw new Error('任务已取消');
      return summary;
    };
    const summary = await this.platformStore.transaction(async () => {
      await this.requireLicense(systemId, matterId);
      if (context.signal.aborted) throw new Error('任务已取消');
      if (systemId !== 'transport-practitioner') return commitRows(enriched);
      if (!this.practitionerNumbers) throw new Error('编号模块未就绪');
      return this.practitionerNumbers.withNumbers(matterId, enriched, commitRows);
    });
    const undated = result.undatedExcludedCount;
    const warning = undated ? `。另有 ${undated} 条许可决定日期无法确认，未纳入本批次。可清空日期回流后核对。` : '';
    context.report({ current: 4, total: 4, message: `回流完成，共 ${summary.total} 条${warning}` });
    return {
      total: summary.total,
      inserted: summary.inserted,
      updated: summary.updated,
      unchanged: summary.unchanged,
      ...(undated ? { undatedExcludedCount: undated } : {}),
    };
  }

  async getSettings(): Promise<AppSettings> {
    if (!this.platformStore) throw new Error('设置模块未就绪');
    return this.platformStore.get();
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    if (!this.platformStore) throw new Error('设置模块未就绪');
    const settings = await this.platformStore.update(patch);
    this.tasks.setConcurrency(settings.taskConcurrency);
    return settings;
  }

  async credentialStatus(systemId: string) {
    this.requireCredentialConfiguration(systemId);
    const credentials = await this.credentialStore?.get(systemId);
    return { configured: Boolean(credentials), account: credentials?.account ?? '' };
  }

  async credentialsForLogin(systemId: string) {
    this.requireCredentialConfiguration(systemId);
    return this.credentialStore?.get(systemId) ?? null;
  }

  private requireCredentialConfiguration(systemId: string): void {
    if (!this.plugins.get(systemId)?.supportsCredentialConfiguration) throw new Error('该业务系统暂不支持账号密码配置');
  }

  async saveCredentials(systemId: string, account: string, password: string) {
    this.requireCredentialConfiguration(systemId);
    if (!this.credentialStore) throw new Error('登录配置模块未就绪');
    const credentials = { account, password };
    await this.credentialStore.set(systemId, credentials);
    if (systemId === 'transport-practitioner') configurePractitionerCredentials(credentials);
    else if (systemId === 'oversize-transport') configureOversizeTransportCredentials(credentials);
    else if (systemId === 'online-car-permit') configureOnlineCarPermitCredentials(credentials);
    return { configured: true, account };
  }

  async listAudit() {
    return this.platformStore?.list() ?? [];
  }

  async listSystemModules() {
    const grant = await this.currentGrant();
    if (!grant || grant.expiresAt <= Date.now()) return [];
    return builtinModules.filter((module) => grant.allowedSystems.includes(module.id))
      .map((module) => ({ ...module, authorized: true }));
  }

  async listComponents(): Promise<ComponentSummary[]> {
    const grant = await this.currentGrant();
    if (!grant || grant.expiresAt <= Date.now()) return [];
    const systems: ComponentSummary[] = builtinModules.filter(module => grant.allowedSystems.includes(module.id)).map(module => {
      const plugin = this.plugins.get(module.id);
      return { ...module, kind: 'system', authorized: true, workspaceMode: plugin?.workspaceMode ?? 'standard',
        supportsCredentialConfiguration: Boolean(plugin?.supportsCredentialConfiguration) };
    });
    const tools: ComponentSummary[] = toolCatalog.filter(tool => grant.allowedTools?.includes(tool.id))
      .map(tool => ({ ...tool, kind: 'tool', publisher: '数据融合助手', authorized: true }));
    return [...systems, ...tools];
  }

  async checkUpdates() {
    if (!runtimeUpdateTarget(process.platform, process.arch)) return { configured: false, checkedAt: Date.now(), message: '当前系统或芯片架构暂不支持在线更新' };
    if (!this.updateService) throw new Error('更新模块未就绪');
    const grant = await this.currentGrant();
    if (!grant || grant.activationMode !== 'online' || !grant.allowAutoUpdate) {
      return { configured: false, checkedAt: Date.now(), message: '当前授权未开通在线更新，请联系管理员或手动安装新版' };
    }
    const authorization = await this.license!.clientAuthorization();
    if (!authorization) throw new Error('当前设备缺少签名授权凭据，请重新激活');
    const result = await this.updateService.check(
      this.appVersion,
      { licenseId: grant.licenseId, ...authorization },
    );
    await this.audit('update.checked', undefined, undefined, undefined, { app: result.app?.version });
    return result;
  }

  async downloadAppUpdate() {
    if (!this.updateService) throw new Error('更新模块未就绪');
    const check = await this.checkUpdates();
    if (!check.configured || !check.app) throw new Error(check.message ?? '当前没有可安装的新版本');
    return this.updateService.downloadApp(check.app, join(this.userDataPath, 'updates'));
  }

  async downloadUpdateArtifact(artifact: UpdateArtifact, progress: (value: DownloadProgress) => void, signal: AbortSignal): Promise<string> {
    if (!this.updateService) throw new Error('更新模块未就绪');
    return this.updateService.downloadApp(artifact, join(this.userDataPath, 'updates'), progress, signal);
  }
  async verifyUpdateArtifact(path: string, artifact: UpdateArtifact): Promise<void> {
    if (!this.updateService) throw new Error('更新模块未就绪');
    return this.updateService.verifyFile(path, artifact);
  }

  async createSyncPreview(
    systemId: string,
    matterId: string,
    rows: Record<string, unknown>[],
  ): Promise<SyncPreviewReceipt> {
    if (systemId === 'guangdong-hrss') throw new Error('人社数据请通过列表回流任务保存');
    const plugin = this.plugins.get(systemId);
    const matter = plugin?.matters.find((item) => item.id === matterId);
    await this.requireLicense(systemId, matterId);
    if (!plugin || !matter || !this.syncEngine) throw new Error('同步模块未就绪');
    if ((await plugin.getSessionState()).status !== 'authenticated') throw new Error('请先登录该业务系统');

    const enriched = this.enterpriseService ? await this.enterpriseService.enrich(systemId, matterId, rows) : rows;
    const summary = await this.syncEngine.preview(systemId, matterId, matter.uniqueKey, enriched,
      (incoming, previous) => mergeEnterpriseRecord(systemId, matter.mergeRecord ? matter.mergeRecord(incoming, previous) : incoming, previous));
    const previewId = globalThis.crypto.randomUUID();
    this.removeExpiredPreviews();
    this.pendingPreviews.set(previewId, { systemId, matterId, summary, createdAt: Date.now() });
    return {
      previewId,
      total: summary.total,
      inserted: summary.inserted,
      updated: summary.updated,
      unchanged: summary.unchanged,
    };
  }

  syncPreviewScope(previewId: string) {
    this.removeExpiredPreviews();
    const pending = this.pendingPreviews.get(previewId);
    if (!pending) throw new Error('同步预览已失效，请重新预览');
    return { systemId: pending.systemId, matterId: pending.matterId };
  }

  async commitSyncPreview(previewId: string): Promise<Omit<SyncPreviewReceipt, 'previewId'>> {
    const { systemId, matterId } = this.syncPreviewScope(previewId);
    await this.requireLicense(systemId, matterId);
    this.removeExpiredPreviews();
    const pending = this.pendingPreviews.get(previewId);
    if (!pending || !this.syncEngine) throw new Error('同步预览已失效，请重新预览');
    this.pendingPreviews.delete(previewId);
    try {
      await this.syncEngine.commit(pending.systemId, pending.matterId, pending.summary);
    } catch (error) {
      this.pendingPreviews.set(previewId, pending);
      throw error;
    }
    const { total, inserted, updated, unchanged } = pending.summary;
    return { total, inserted, updated, unchanged };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.licenseMonitor?.stop();
    await loginTabController.flushSessionStorage();
    await this.sessionRecovery?.flush();
    await this.sessionStore?.flush();
    await this.repository?.close();
    this.repository = undefined;
    this.syncEngine = undefined;
  }

  private removeExpiredPreviews(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, preview] of this.pendingPreviews) {
      if (preview.createdAt < cutoff) this.pendingPreviews.delete(id);
    }
  }
}

export const appRuntime = new AppRuntime();
