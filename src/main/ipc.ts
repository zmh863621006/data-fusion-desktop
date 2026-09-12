import { ipcMain } from 'electron';
import { appRuntime } from './runtime';
import type { QueryContext } from '../core/query/types';

export const IPC_CHANNELS = {
  systemsList: 'systems:list',
  systemSession: 'system:session',
  systemLogin: 'system:login',
  systemLogout: 'system:logout',
  mattersList: 'matters:list',
  matterQuery: 'matter:query',
} as const;

function requireSystem(systemId: string) {
  const plugin = appRuntime.plugins.get(systemId);
  if (!plugin) throw new Error(`Unknown system: ${systemId}`);
  return plugin;
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.systemsList, async () => {
    return Promise.all(
      appRuntime.plugins.list().map(async (plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        session: await plugin.getSessionState(),
      })),
    );
  });

  ipcMain.handle(IPC_CHANNELS.systemSession, async (_event, systemId: string) => {
    return requireSystem(systemId).getSessionState();
  });

  ipcMain.handle(IPC_CHANNELS.systemLogin, async (_event, systemId: string) => {
    return requireSystem(systemId).auth.login();
  });

  ipcMain.handle(IPC_CHANNELS.systemLogout, async (_event, systemId: string) => {
    await requireSystem(systemId).auth.logout();
    return requireSystem(systemId).getSessionState();
  });

  ipcMain.handle(IPC_CHANNELS.mattersList, async (_event, systemId: string) => {
    const plugin = requireSystem(systemId);
    return plugin.matters.map(({ query, getDetail, ...matter }) => matter);
  });

  ipcMain.handle(
    IPC_CHANNELS.matterQuery,
    async (_event, systemId: string, matterId: string, context: QueryContext) => {
      const plugin = requireSystem(systemId);
      const session = await plugin.getSessionState();
      if (session.status !== 'authenticated') {
        throw new Error('请先登录该业务系统');
      }

      // Force authentication material to be resolved inside the main-process plugin boundary.
      await plugin.auth.getSessionForRequest();

      const matter = plugin.matters.find((item) => item.id === matterId);
      if (!matter) throw new Error(`Unknown matter: ${matterId}`);
      return matter.query(context);
    },
  );
}
