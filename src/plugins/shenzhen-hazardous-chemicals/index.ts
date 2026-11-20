import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { SessionState } from '../../core/session/types';
import { HAZCHEM_HOME_URL, HAZCHEM_LOGIN_URL, HAZCHEM_MATTERS, HAZCHEM_ORIGIN, HAZCHEM_PARTITION, HAZCHEM_SYSTEM_ID, HAZCHEM_SYSTEM_NAME } from './catalog';
import { HazardousClient, type HazardousClientOptions } from './client';
import { queryHazardous } from './query';

export function createShenzhenHazardousPlugin(options: HazardousClientOptions = {}): BusinessSystemPlugin {
  const client = new HazardousClient(options);
  const state = async (): Promise<SessionState> => {
    if (client.needsValidation()) {
      try { await client.validateSession(); }
      catch { if (client.hasSession()) return { systemId: HAZCHEM_SYSTEM_ID, status: 'unverified', message: '暂时无法验证登录，请检查网络或原系统页面' }; }
    }
    if (client.apiCredentials().status === 'expired') return { systemId: HAZCHEM_SYSTEM_ID, status: 'expired', message: '原系统会话已失效，请重新登录' };
    return client.verified() ? { systemId: HAZCHEM_SYSTEM_ID, status: 'authenticated', displayName: `${HAZCHEM_SYSTEM_NAME}会话` }
      : { systemId: HAZCHEM_SYSTEM_ID, status: client.hasSession() ? 'unverified' : 'logged-out', message: client.hasSession() ? '会话校验尚未完成，请检查原系统页面' : undefined };
  };
  return {
    id: HAZCHEM_SYSTEM_ID, name: HAZCHEM_SYSTEM_NAME, version: '0.1.0',
    description: '筛选流程结束的已办业务，按流水号关联制证数据，生成省执法和南山双公示。',
    workspaceMode: 'return-ledger', loginMode: 'embedded', supportsCredentialConfiguration: true,
    loginPage: { url: HAZCHEM_LOGIN_URL, allowedOrigin: HAZCHEM_ORIGIN, partition: HAZCHEM_PARTITION,
      onLoginPageChange: visible => { if (visible) client.clearSession(); },
      credentialPaths: ['/iHome/'], browserAuth: { localStorageKeys: [], sessionStorageKeys: ['Authorization', 'userId'], accept: values => client.acceptStorage(values) } },
    auth: { getState: state, login: state, logout: () => client.logout(), async getSessionForRequest() {
      if (!client.verified()) await client.validateSession(); return { metadata: { auth: 'portal-session' } };
    } },
    sessionRecovery: { apiCredentials: () => client.apiCredentials(), snapshot: () => client.exportSession(), restore: value => client.restoreSession(value), validate: signal => client.validateSession(signal), homeUrl: () => HAZCHEM_HOME_URL },
    matters: HAZCHEM_MATTERS.map(matter => ({
      id: matter.id, name: matter.name, departmentId: matter.departmentId, departmentName: matter.departmentName,
      departmentOrder: matter.departmentOrder, matterOrder: matter.matterOrder,
      description: matter.id === 'hazchem-precursor-filing' ? '回流已办备案列表及可关联制证字段；缺项需人工核对。' : '关联流程结束业务和制证数据；原系统缺项保留提示。',
      executionMode: 'one-click-return' as const, uniqueKey: ['sourceSerial'],
      querySchema: [ { key: 'startDate', label: '许可决定开始日期', type: 'date' as const }, { key: 'endDate', label: '许可决定截止日期', type: 'date' as const } ],
      dateFilter: { mode: 'applied' as const, message: '按许可决定日期筛选。日期无法确认的记录会在任务结果中提示。留空回流全部流程结束记录。' },
      createDefaultContext: () => ({ page: 1, pageSize: 50_000, filters: {} }),
      query: context => queryHazardous(client, matter, context),
    })),
    async initialize() {}, getSessionState: state,
  };
}
