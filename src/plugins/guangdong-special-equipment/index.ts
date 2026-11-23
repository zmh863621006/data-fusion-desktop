import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { SessionState } from '../../core/session/types';
import { observeBrowserAuth, clearBrowserAuth } from '../../main/browser-auth';
import {
  DEFAULT_EQUIPMENT_CITY, EQUIPMENT_API, EQUIPMENT_CITIES, EQUIPMENT_LOGIN_URL, EQUIPMENT_ORIGIN,
  EQUIPMENT_PARTITION, EQUIPMENT_SSO_ORIGIN, EQUIPMENT_SYSTEM_ID, EQUIPMENT_SYSTEM_NAME, EQUIPMENT_VERSION,
  equipmentDate, PERSONNEL_ASSESSMENT, USE_REGISTRATION,
} from './catalog';
import { SpecialEquipmentClient, type EquipmentClientOptions } from './client';
import { querySpecialEquipment } from './query';

export function createSpecialEquipmentPlugin(options: EquipmentClientOptions = {}): BusinessSystemPlugin {
  const client = new SpecialEquipmentClient(options);
  const getState = async (): Promise<SessionState> => {
    const state = client.apiCredentials().status;
    if (state !== 'present') return { systemId: EQUIPMENT_SYSTEM_ID, status: state === 'expired' ? 'expired' : 'logged-out' };
    try {
      const verified = await client.validateSession(AbortSignal.timeout(10_000));
      return { systemId: EQUIPMENT_SYSTEM_ID, status: 'authenticated', ...verified };
    } catch {
      return { systemId: EQUIPMENT_SYSTEM_ID, status: client.apiCredentials().status === 'expired' ? 'expired' : 'unverified' };
    }
  };
  const defaults = () => {
    const date = equipmentDate((options.now ?? Date.now)() - 86_400_000);
    return { page: 1, pageSize: 200, filters: { startDate: date, endDate: date, city: DEFAULT_EQUIPMENT_CITY } };
  };
  const querySchema: BusinessSystemPlugin['matters'][number]['querySchema'] = [
    { key: 'startDate', type: 'date', label: '许可决定开始日期', required: true },
    { key: 'endDate', type: 'date', label: '许可决定截止日期', required: true },
    { key: 'city', type: 'select', label: '查询地市', required: true, options: EQUIPMENT_CITIES },
  ];
  return {
    id: EQUIPMENT_SYSTEM_ID, name: EQUIPMENT_SYSTEM_NAME, version: EQUIPMENT_VERSION,
    description: '按许可决定日期回流设备使用登记、作业人员考核，核对并导出双公示。',
    workspaceMode: 'return-ledger', loginMode: 'embedded',
    loginPage: {
      url: EQUIPMENT_LOGIN_URL, allowedOrigin: EQUIPMENT_ORIGIN, additionalAllowedOrigins: [EQUIPMENT_SSO_ORIGIN],
      partition: EQUIPMENT_PARTITION,
      onLoginPageChange: visible => client.setLoginVisible(visible),
      onNavigate: url => client.noteNavigation(url),
    },
    auth: {
      getState, login: getState,
      logout: async () => { client.clear(); await clearBrowserAuth(EQUIPMENT_PARTITION); },
      async getSessionForRequest() {
        client.assertSession(client.apiCredentials().revision);
        return { metadata: { partition: EQUIPMENT_PARTITION } };
      },
    },
    sessionRecovery: {
      apiCredentials: () => client.apiCredentials(),
      snapshot: () => client.snapshot(),
      restore: value => client.restore(value),
      validate: signal => client.validateSession(signal),
      homeUrl: () => client.homeUrl(),
    },
    matters: [
      { ...USE_REGISTRATION, kind: 'registration' as const, description: '按设备拆分登记记录，核对登记证和许可决定书。' },
      { ...PERSONNEL_ASSESSMENT, kind: 'personnel' as const, description: '核对作业项目、有效期及决定书，排除不予许可的记录。' },
    ].map(({ kind, ...matter }) => ({
      ...matter, executionMode: 'one-click-return' as const, querySchema,
      uniqueKey: ['sourceRecordId'], createDefaultContext: defaults,
      dateFilter: { mode: 'applied' as const, message: '按许可决定日期逐日查询，请选择原系统账号可查询的地市。' },
      query: context => querySpecialEquipment(client, kind, context),
    })),
    async initialize() {
      observeBrowserAuth({
        partition: EQUIPMENT_PARTITION, urlPattern: EQUIPMENT_API + '*', header: 'token',
        credentialGeneration: () => client.browserAuthGeneration(),
        accept: token => client.acceptToken(token),
        // An individual browser request can be denied while the portal session is still valid.
        // The workbench probe and navigation to the SSO page own session invalidation.
        clear: () => {},
      });
    },
    getSessionState: getState,
  };
}
