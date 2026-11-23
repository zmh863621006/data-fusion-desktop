import { AppError } from '../../core/errors/app-error';
import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { SessionState } from '../../core/session/types';
import { clearBrowserAuth } from '../../main/browser-auth';
import {
  FOOD_DRUG_HOME, FOOD_DRUG_LICENSES, FOOD_DRUG_LOGIN, FOOD_DRUG_ORIGIN, FOOD_DRUG_PARTITION,
  FOOD_DRUG_SYSTEM_ID, FOOD_DRUG_SYSTEM_NAME, FOOD_DRUG_VERSION, foodDrugPreviousDay,
} from './catalog';
import { FoodDrugClient, type FoodDrugClientOptions } from './client';
import { queryFoodDrug } from './query';

export function createFoodDrugPlugin(options: FoodDrugClientOptions = {}): BusinessSystemPlugin {
  const client = new FoodDrugClient(options);
  let loginVisible = false;
  const previousDay = () => foodDrugPreviousDay(options.now?.());
  const verify = async (signal: AbortSignal) => {
    if (loginVisible) throw new AppError('SESSION_EXPIRED', '食药监仍停留在登录页');
    const day = previousDay();
    await client.list(FOOD_DRUG_LICENSES[0], day, day, 1, 1, signal, true);
    return { displayName: FOOD_DRUG_SYSTEM_NAME + '会话' };
  };
  const getState = async (): Promise<SessionState> => {
    try {
      return { status: 'authenticated', systemId: FOOD_DRUG_SYSTEM_ID, ...await verify(AbortSignal.timeout(10_000)) };
    } catch (error) {
      const status = error instanceof AppError && error.code === 'SESSION_EXPIRED' ? 'expired' : 'unverified';
      return { status, systemId: FOOD_DRUG_SYSTEM_ID };
    }
  };
  const querySchema: BusinessSystemPlugin['matters'][number]['querySchema'] = [
    { key: 'startDate', type: 'date', label: '办结开始日期', required: true },
    { key: 'endDate', type: 'date', label: '办结截止日期', required: true },
  ];
  const plugin: BusinessSystemPlugin = {
    id: FOOD_DRUG_SYSTEM_ID, name: FOOD_DRUG_SYSTEM_NAME, version: FOOD_DRUG_VERSION,
    description: '食品生产和第三类医疗器械经营许可回流及双公示导出',
    workspaceMode: 'return-ledger',
    loginMode: 'embedded',
    loginPage: {
      url: FOOD_DRUG_LOGIN, partition: FOOD_DRUG_PARTITION, allowedOrigin: FOOD_DRUG_ORIGIN,
      onLoginPageChange: visible => { loginVisible = visible; },
    },
    auth: {
      getState, login: getState,
      logout: () => clearBrowserAuth(FOOD_DRUG_PARTITION),
      async getSessionForRequest() {
        if ((await plugin.getSessionState()).status !== 'authenticated') throw new AppError('SYSTEM_LOGIN_REQUIRED', '请先登录食药监原系统');
        return { metadata: { partition: FOOD_DRUG_PARTITION } };
      },
    },
    sessionRecovery: { snapshot: () => null, restore: () => {}, validate: verify, homeUrl: () => FOOD_DRUG_HOME },
    matters: FOOD_DRUG_LICENSES.map(matter => ({
      id: matter.id, name: matter.name, querySchema, uniqueKey: ['sourceRecordId'],
      description: '关联受理信息和许可证，核对后导出双公示。',
      executionMode: 'one-click-return',
      createDefaultContext() {
        const day = previousDay();
        return { page: 1, pageSize: 200, filters: { startDate: day, endDate: day } };
      },
      dateFilter: { mode: 'applied', message: '按原系统办结日期查询已办结、准予许可的办件。' },
      query: context => queryFoodDrug(client, matter, context),
    })),
    async initialize() {},
    getSessionState: getState,
  };
  return plugin;
}
