import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../src/core/ipc/channels';

// This preload is used only by the isolated source-tab smoke test, never by the app.
const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke('smoke:invoke', method, ...args);
contextBridge.exposeInMainWorld('desktopApi', {
  license: { status: () => invoke('license') },
  settings: { get: async () => ({ autoCheckUpdates: false }) },
  updates: { state: async () => ({status:'disabled',currentVersion:'0.0.0',automatic:false,installMode:'manual',message:''}), onChanged: () => () => {} },
  components: { list: () => invoke('components') },
  systems: {
    list: () => invoke('systems'), session: (id: string, force = false) => invoke('session', id, force),
    tabs: () => invoke('tabs'), login: (id: string) => invoke('login', id),
    activateTab: (id: string | null) => invoke('activate', id), closeLogin: (id: string) => invoke('close', id),
    backLogin: (id: string) => invoke('back', id), reloadLogin: (id: string) => invoke('reload', id),
    onTabsChanged: (callback: (value: unknown) => void) => {
      const listener = (_event: unknown, value: unknown) => callback(value);
      ipcRenderer.on(IPC_CHANNELS.systemTabsChanged, listener);
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.systemTabsChanged, listener); };
    },
    onSessionChanged: (callback: (value: unknown) => void) => {
      const listener = (_event: unknown, value: unknown) => callback(value);
      ipcRenderer.on(IPC_CHANNELS.systemSessionChanged, listener);
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.systemSessionChanged, listener); };
    },
  },
  matters: { list: (id: string) => invoke('matters', id) },
  tasks: { list: async () => [] },
  records: { list: async () => ({ rows: [], total: 0 }) },
  credentials: { status: async () => ({ configured: false, account: '' }), save: (id: string, account: string, password: string) => invoke('credentials', id, account, password) },
  diagnostics: { report: async () => true },
});
