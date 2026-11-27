import { session } from 'electron';
import { createCatalogMatter } from '../core/query/catalog-matter';
import { rejectUnavailableMatterQuery } from '../core/query/validation';
import type { BusinessSystemPlugin } from '../core/plugins/types';
import type { SessionState } from '../core/session/types';
import { clearBrowserAuth } from '../main/browser-auth';
import population from './guangdong-population/matter-catalog.json';

export const catalogOnlySystems = [
  { ...population, loginUrl: 'http://19.16.44.169/login', description: '生育登记业务与本地台账' },
];

export function createCatalogOnlySystem({ id, name, version, description, loginUrl, matters }: (typeof catalogOnlySystems)[number]): BusinessSystemPlugin {
  const partition = 'persist:' + id;
  const origin = new URL(loginUrl).origin;
  const getState = async (): Promise<SessionState> => {
    try {
      const cookies = await session.fromPartition(partition).cookies.get({ url: loginUrl });
      if (!cookies.length) return { systemId: id, status: 'logged-out' };
    } catch {
      // The original page can still be opened when the local sign-in state cannot be read.
    }
    return { systemId: id, status: 'unverified', message: '请在原系统页面核对登录状态。' };
  };
  return {
    id, name, version, description, workspaceMode: 'list-ledger', loginMode: 'embedded',
    loginPage: { url: loginUrl, partition, allowedOrigin: origin },
    matters: matters.map(matter => createCatalogMatter(matter)),
    auth: {
      getState,
      login: getState,
      logout: () => clearBrowserAuth(partition),
      async getSessionForRequest() { return rejectUnavailableMatterQuery(); },
    },
    getSessionState: getState,
    async initialize() {},
  };
}
