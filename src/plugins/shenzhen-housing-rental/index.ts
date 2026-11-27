import { session } from 'electron';
import { AppError } from '../../core/errors/app-error';
import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { SessionState } from '../../core/session/types';
import { HousingRentalClient, type HousingRentalClientOptions } from './client';
import {
  HOUSING_BINDING_MATTER_ID, HOUSING_BINDING_MATTER_NAME, HOUSING_HOME_URL, HOUSING_LOGIN_URL,
  HOUSING_ORIGIN, HOUSING_PARTITION, HOUSING_SYSTEM_ID, HOUSING_SYSTEM_NAME, HOUSING_VERSION,
} from './catalog';
export * from './catalog';
export { HousingRentalClient } from './client';
export type { HousingRentalClientOptions, HousingBindingClient, HousingBindingTarget, HousingBindingHouse } from './client';

export function createHousingRentalPlugin(options: HousingRentalClientOptions & { client?: HousingRentalClient } = {}): BusinessSystemPlugin {
  const client = options.client ?? new HousingRentalClient(options);
  const getState = async (): Promise<SessionState> => {
    const credentials = client.apiCredentials();
    if (credentials.status !== 'present') return { systemId: HOUSING_SYSTEM_ID, status: credentials.status === 'expired' ? 'expired' : 'logged-out' };
    try { return { systemId: HOUSING_SYSTEM_ID, status: 'authenticated', ...await client.validateSession(AbortSignal.timeout(10_000)) }; }
    catch (error) { return { systemId: HOUSING_SYSTEM_ID, status: error instanceof AppError && error.code === 'SESSION_EXPIRED' ? 'expired' : 'unverified' }; }
  };
  return {
    id: HOUSING_SYSTEM_ID, name: HOUSING_SYSTEM_NAME, version: HOUSING_VERSION,
    description: '按受理编号与产权证，导入房屋编码并逐条挂接、核对处理结果。',
    supportsCredentialConfiguration: false, loginMode: 'embedded',
    loginPage: {
      url: HOUSING_LOGIN_URL, partition: HOUSING_PARTITION, allowedOrigin: HOUSING_ORIGIN,
      onNavigate: url => client.noteNavigation(url), onLoginPageChange: visible => client.setLoginVisible(visible),
    },
    auth: {
      getState, login: getState,
      async logout() { client.clear(); await session.fromPartition(HOUSING_PARTITION).clearStorageData(); },
      async getSessionForRequest() {
        if ((await getState()).status !== 'authenticated') throw new AppError('SYSTEM_LOGIN_REQUIRED', '请先在房屋租赁原系统完成登录');
        return { metadata: { partition: HOUSING_PARTITION } };
      },
    },
    sessionRecovery: {
      apiCredentials: () => client.apiCredentials(), snapshot: () => client.snapshot(), restore: value => client.restore(value),
      validate: signal => client.validateSession(signal), homeUrl: () => HOUSING_HOME_URL,
    },
    matters: [{
      id: HOUSING_BINDING_MATTER_ID, name: HOUSING_BINDING_MATTER_NAME,
      departmentId: 'housing-rental', departmentName: '房屋租赁', departmentOrder: 0, matterOrder: 0,
      description: '填写受理编号与产权证，上传房屋编码后生成自动绑定任务。',
      querySchema: [], uniqueKey: ['code'], executionMode: 'interactive-query', queryAvailable: false,
      async query() { throw new AppError('QUERY_INVALID', '请在工作台创建房屋编码自动绑定任务'); },
    }],
    initialize: () => client.initialize(), getSessionState: getState,
  };
}
