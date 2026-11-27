import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../src/core/ipc/channels';
const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke('credentials-smoke', method, ...args);
const group = (prefix: string, methods: string[]) => Object.fromEntries(methods.map(method => [method, (...args: unknown[]) => invoke(prefix + '.' + method, ...args)]));
contextBridge.exposeInMainWorld('desktopApi', {
  license: group('license', ['status']), components: group('components', ['list']),
  settings: group('settings', ['get']), credentials: group('credentials', ['status', 'save']),
  matters: group('matters', ['list']), tasks: group('tasks', ['list', 'page']), records: group('records', ['list']),
  housingBinding: group('housing', ['state']), oneWindow: group('oneWindow', ['state', 'records']),
  diagnostics: { report: async () => true },
  updates: { state: async () => ({ status: 'up-to-date', currentVersion: '0.0.0', automatic: false, installMode: 'manual' }), onChanged: () => () => {} },
  systems: {
    ...group('systems', ['list', 'session', 'tabs', 'login', 'activateTab', 'closeLogin']),
    onTabsChanged: (callback: (value: unknown) => void) => {
      const listener = (_event: unknown, value: unknown) => callback(value);
      ipcRenderer.on(IPC_CHANNELS.systemTabsChanged, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.systemTabsChanged, listener);
    },
    onSessionChanged: () => () => {},
  },
});
