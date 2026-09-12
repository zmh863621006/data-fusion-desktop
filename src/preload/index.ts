import { contextBridge, ipcRenderer } from 'electron';
import type { QueryContext } from '../core/query/types';
import { IPC_CHANNELS } from '../main/ipc';

const desktopApi = {
  systems: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.systemsList),
    session: (systemId: string) => ipcRenderer.invoke(IPC_CHANNELS.systemSession, systemId),
    login: (systemId: string) => ipcRenderer.invoke(IPC_CHANNELS.systemLogin, systemId),
    logout: (systemId: string) => ipcRenderer.invoke(IPC_CHANNELS.systemLogout, systemId),
  },
  matters: {
    list: (systemId: string) => ipcRenderer.invoke(IPC_CHANNELS.mattersList, systemId),
    query: (systemId: string, matterId: string, context: QueryContext) =>
      ipcRenderer.invoke(IPC_CHANNELS.matterQuery, systemId, matterId, context),
  },
};

contextBridge.exposeInMainWorld('desktopApi', desktopApi);

export type DesktopApi = typeof desktopApi;
