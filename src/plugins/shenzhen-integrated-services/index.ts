import { AppError } from '../../core/errors/app-error';
import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { SessionState } from '../../core/session/types';
import { clearBrowserAuth, observeBrowserAuth } from '../../main/browser-auth';
import {
  SHENZHEN_HOME_URL, SHENZHEN_LOGIN_URL, SHENZHEN_ORIGIN, SHENZHEN_PARTITION,
  SHENZHEN_SYSTEM_ID, SHENZHEN_SYSTEM_NAME, SHENZHEN_VERSION, SHENZHEN_MATTERS,
  SHENZHEN_LIST_COLUMNS, SHENZHEN_QUERY_SCHEMA, createDefaultShenzhenContext,
} from './catalog';
import { ShenzhenIntegratedClient, SHENZHEN_STORAGE_KEYS, type ShenzhenClientOptions } from './client';
import { mergeShenzhenRecord, queryShenzhenCases } from './query';

export { ShenzhenIntegratedClient } from './client';
export type { ShenzhenClientOptions } from './client';

export function createShenzhenIntegratedPlugin(options: ShenzhenClientOptions = {}): BusinessSystemPlugin {
  const client = new ShenzhenIntegratedClient(options);
  const getState = async (input?: { force?: boolean }): Promise<SessionState> => {
    const credential = client.apiCredentials();
    if (credential.status !== 'present') return { systemId: SHENZHEN_SYSTEM_ID, status: credential.status === 'expired' ? 'expired' : 'logged-out' };
    try {
      const result = await client.validateSession(AbortSignal.timeout(10_000), input?.force);
      return { systemId: SHENZHEN_SYSTEM_ID, status: 'authenticated', ...result };
    } catch {
      const status = client.apiCredentials().status;
      return { systemId: SHENZHEN_SYSTEM_ID, status: status === 'expired' ? 'expired' : status === 'missing' ? 'logged-out' : 'unverified' };
    }
  };
  let initialized = false;
  return {
    id: SHENZHEN_SYSTEM_ID, name: SHENZHEN_SYSTEM_NAME, version: SHENZHEN_VERSION,
    description: '按接收、受理或办结日期采集全部经办列表，保留完整办理过程。',
    workspaceMode: 'list-ledger', loginMode: 'embedded', supportsCredentialConfiguration: true,
    loginPage: {
      url: SHENZHEN_LOGIN_URL, allowedOrigin: SHENZHEN_ORIGIN, partition: SHENZHEN_PARTITION,
      credentialPaths: ['/cas/login'],
      // The source masks passwordVal on focus; casPd is the hidden encrypted output.
      // These selectors do not match the separate pinCode certificate step.
      credentialFields: { account: '#username', password: '#passwordVal' },
      onLoginPageChange: visible => client.setLoginVisible(visible),
      onNavigate: url => client.noteNavigation(url),
      browserAuth: { localStorageKeys: [], sessionStorageKeys: [...SHENZHEN_STORAGE_KEYS], accept: values => client.acceptStorage(values) },
    },
    auth: {
      getState, login: getState,
      async logout() { client.clear(); await clearBrowserAuth(SHENZHEN_PARTITION); },
      async getSessionForRequest() {
        if (client.apiCredentials().status !== 'present') throw new AppError('SYSTEM_LOGIN_REQUIRED', '请先在原系统登录深圳一体化');
        await client.validateSession();
        return { metadata: { partition: SHENZHEN_PARTITION } };
      },
    },
    sessionRecovery: {
      apiCredentials: () => client.apiCredentials(), snapshot: () => client.snapshot(), restore: value => client.restore(value),
      validate: signal => client.validateSession(signal, true), homeUrl: () => SHENZHEN_HOME_URL,
    },
    matters: SHENZHEN_MATTERS.map(matter => ({
      id: matter.id, name: matter.name, executionMode: 'one-click-return' as const,
      description: matter.description ?? '按原系统事项查询全部经办列表，保留每笔办件及完整办理过程。',
      querySchema: SHENZHEN_QUERY_SCHEMA, listColumns: SHENZHEN_LIST_COLUMNS, uniqueKey: ['recordKey'],
      dateFilter: { mode: 'applied' as const, message: '按所选日期类型查询办件，随后采集这些办件的全部办理过程。' },
      createDefaultContext: () => createDefaultShenzhenContext((options.now ?? Date.now)()),
      query: context => queryShenzhenCases(client, matter, context),
      mergeRecord: mergeShenzhenRecord,
    })),
    async initialize() {
      if (initialized) return;
      observeBrowserAuth({
        partition: SHENZHEN_PARTITION, urlPattern: SHENZHEN_ORIGIN + '/TRANSB/*', header: 'access-token',
        credentialGeneration: () => client.browserAuthGeneration(),
        accept: value => client.acceptToken(value),
        // One denied page request does not prove logout. The identity probe owns expiry.
        clear: () => {},
      });
      initialized = true;
    },
    getSessionState: getState,
  };
}
