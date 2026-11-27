import { session } from 'electron';
import { AppError } from '../../core/errors/app-error';
import type { BusinessMatter } from '../../core/query/types';
import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { SessionState } from '../../core/session/types';
import {
  ONE_WINDOW_HOME_URL, ONE_WINDOW_LIST_COLUMNS, ONE_WINDOW_LOGIN_URL, ONE_WINDOW_MATTERS,
  ONE_WINDOW_ORIGIN, ONE_WINDOW_PARTITION, ONE_WINDOW_STATES, ONE_WINDOW_SYSTEM_ID, ONE_WINDOW_SYSTEM_NAME, ONE_WINDOW_VERSION,
} from './catalog';
import { OneWindowClient, type OneWindowClientOptions } from './client';
import { mergeOneWindowRecord, queryOneWindow } from './query';
import type { OneWindowRecord } from './types';

export * from './catalog';
export { OneWindowClient } from './client';
export type { OneWindowClientOptions } from './client';
export type { OneWindowRecord, OneWindowDetailSection, OneWindowFormData, OneWindowHtmlData } from './types';
export { normalizeOneWindowFilters } from './query';

export function createOneWindowPlugin(options: OneWindowClientOptions = {}): BusinessSystemPlugin {
  const client = new OneWindowClient(options);
  let loginVisible = false;
  const verify = async (signal: AbortSignal) => {
    if (loginVisible) throw new AppError('SESSION_EXPIRED', '请在一窗原系统页面完成登录');
    return client.validateSession(signal);
  };
  const getState = async (): Promise<SessionState> => {
    try { return { systemId: ONE_WINDOW_SYSTEM_ID, status: 'authenticated', ...await verify(AbortSignal.timeout(10_000)) }; }
    catch (error) {
      return { systemId: ONE_WINDOW_SYSTEM_ID,
        status: error instanceof AppError && error.code === 'SESSION_EXPIRED' ? 'logged-out' : 'unverified' };
    }
  };
  const querySchema: BusinessMatter['querySchema'] = [
    { key: 'dateType', label: '日期类型', type: 'select', options: [
      { value: 'all', label: '全部日期' }, { value: 'received', label: '接收／受理日期' }, { value: 'finished', label: '办结日期' },
    ] },
    { key: 'startDate', label: '开始日期', type: 'date' }, { key: 'endDate', label: '结束日期', type: 'date' },
    { key: 'state', label: '办理状态', type: 'select', options: ONE_WINDOW_STATES },
  ];
  const plugin: BusinessSystemPlugin = {
    id: ONE_WINDOW_SYSTEM_ID, name: ONE_WINDOW_SYSTEM_NAME, version: ONE_WINDOW_VERSION,
    description: '广告审批与门楣招牌备案完整详情回流、定时采集和推送后台',
    workspaceMode: 'detail-ledger', loginMode: 'embedded', supportsCredentialConfiguration: true,
    loginPage: { url: ONE_WINDOW_LOGIN_URL, allowedOrigin: ONE_WINDOW_ORIGIN, partition: ONE_WINDOW_PARTITION,
      credentialPaths: [new URL(ONE_WINDOW_LOGIN_URL).pathname],
      credentialFields: { account: '#uname', password: '#password' },
      onLoginPageChange: visible => { loginVisible = visible; } },
    auth: {
      getState, login: getState,
      async logout() { loginVisible = true; await session.fromPartition(ONE_WINDOW_PARTITION).clearStorageData(); },
      async getSessionForRequest() {
        if ((await plugin.getSessionState()).status !== 'authenticated') throw new AppError('SYSTEM_LOGIN_REQUIRED', '请先在原系统登录一窗受理平台');
        return { metadata: { partition: ONE_WINDOW_PARTITION } };
      },
    },
    sessionRecovery: { snapshot: () => null, restore() {}, validate: verify, homeUrl: () => ONE_WINDOW_HOME_URL },
    matters: ONE_WINDOW_MATTERS.map(matter => ({
      id: matter.id, name: matter.name, departmentId: 'urban-management', departmentName: '城管局', departmentOrder: 0,
      description: '采集办件列表、主体资料、电子表单、办理意见及相关文件目录。',
      querySchema, uniqueKey: ['bsnum'], executionMode: 'one-click-return', listColumns: ONE_WINDOW_LIST_COLUMNS,
      createDefaultContext: () => ({ page: 1, pageSize: 100, filters: { dateType: 'all', startDate: '', endDate: '', state: '' } }),
      query: context => queryOneWindow(client, matter, context, options.now?.() ?? Date.now()),
      mergeRecord: (incoming, previous) => mergeOneWindowRecord(incoming as OneWindowRecord, previous as OneWindowRecord),
    })),
    async initialize() {}, getSessionState: getState,
  };
  return plugin;
}
