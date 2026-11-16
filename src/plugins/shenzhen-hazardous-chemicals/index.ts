import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { SessionState } from '../../core/session/types';
import { HAZCHEM_HOME_URL, HAZCHEM_LOGIN_URL, HAZCHEM_MATTERS, HAZCHEM_ORIGIN, HAZCHEM_PARTITION, HAZCHEM_SYSTEM_ID } from './catalog';
import { HazardousClient, type HazardousClientOptions } from './client';
import { queryHazardous } from './query';

export function createShenzhenHazardousPlugin(options: HazardousClientOptions = {}): BusinessSystemPlugin {
  const client = new HazardousClient(options);
  const state = async (): Promise<SessionState> => {
    if (client.needsValidation()) await client.validateSession().catch(() => {});
    return client.verified() ? { systemId: HAZCHEM_SYSTEM_ID, status: 'authenticated', displayName: '深圳危化品系统会话' }
      : { systemId: HAZCHEM_SYSTEM_ID, status: client.hasSession() ? 'unverified' : 'logged-out', message: client.hasSession() ? '会话校验尚未完成，请检查原系统页面' : undefined };
  };
  return {
    id: HAZCHEM_SYSTEM_ID, name: '深圳市危险化学品安全生产风险监测预警系统', version: '0.1.0',
    description: '筛选流程结束的已办业务，按流水号关联制证数据，生成省执法和南山双公示。',
    workspaceMode: 'return-ledger', loginMode: 'embedded', supportsCredentialConfiguration: true,
    loginPage: { url: HAZCHEM_LOGIN_URL, allowedOrigin: HAZCHEM_ORIGIN, partition: HAZCHEM_PARTITION,
      credentialPaths: ['/iHome/'], browserAuth: { localStorageKeys: [], sessionStorageKeys: ['Authorization', 'userId'], accept: values => client.acceptStorage(values) } },
    auth: { getState: state, login: state, logout: () => client.logout(), async getSessionForRequest() {
      if (!client.verified()) await client.validateSession(); return { metadata: { auth: 'portal-session' } };
    } },
    sessionRecovery: { snapshot: () => client.exportSession(), restore: value => client.restoreSession(value), validate: signal => client.validateSession(signal), homeUrl: () => HAZCHEM_HOME_URL },
    matters: HAZCHEM_MATTERS.map(matter => ({
      id: matter.id, name: matter.name, departmentId: matter.departmentId, departmentName: matter.departmentName,
      departmentOrder: matter.departmentOrder, matterOrder: matter.matterOrder,
      description: matter.id === 'hazchem-precursor-filing' ? '回流已办备案列表及可关联制证字段；缺项需人工核对。' : '关联流程结束业务和制证数据；原系统缺项保留提示。',
      executionMode: 'one-click-return' as const, uniqueKey: ['sourceSerial'],
      querySchema: [ { key: 'startDate', label: '许可决定开始日期', type: 'date' as const }, { key: 'endDate', label: '许可决定截止日期', type: 'date' as const } ],
      dateFilter: { mode: 'applied' as const, message: '按制证导出记录的许可决定日期筛选，留空回流全部流程结束记录。' },
      createDefaultContext: () => ({ page: 1, pageSize: 50_000, filters: {} }),
      query: context => queryHazardous(client, matter, context),
    })),
    async initialize() {}, getSessionState: state,
  };
}
