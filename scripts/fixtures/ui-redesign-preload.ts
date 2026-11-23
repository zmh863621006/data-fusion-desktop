import { contextBridge, ipcRenderer } from 'electron';

// Test-only transport. All responses come from the isolated in-memory smoke
// process, not the production runtime, network, vault, or user database.
const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke('ui-redesign:invoke', method, ...args);
const group = (name: string, methods: string[]) => Object.fromEntries(methods.map(method => [method, (...args: unknown[]) => invoke(`${name}.${method}`, ...args)]));
contextBridge.exposeInMainWorld('desktopApi', {
  license: group('license', ['status', 'activate', 'importFile', 'deactivate', 'refresh', 'copyIdentifier']),
  backend: group('backend', ['status']),
  healthTool: group('healthTool', ['state', 'importFiles', 'update', 'settings', 'remove', 'export']),
  modules: group('modules', ['list']),
  components: group('components', ['list']),
  publications: group('publications', ['open']),
  hrss: group('hrss', ['dashboard', 'openDashboard', 'closeDashboard']),
  tasks: group('tasks', ['list', 'page', 'cancel', 'output', 'exportOutput']),
  records: group('records', ['list', 'versions', 'update', 'export']),
  exports: group('exports', ['openFolder']),
  settings: group('settings', ['get', 'update']),
  credentials: group('credentials', ['status', 'save']),
  practitionerNumbers: group('practitionerNumbers', ['get', 'save']),
  audit: group('audit', ['list']),
  diagnostics: group('diagnostics', ['list', 'openFolder', 'export', 'report']),
  updates: {
    ...group('updates', ['check', 'install', 'state', 'download']),
    onChanged: (listener: (value: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
      ipcRenderer.on('ui-redesign:updates-changed', handler);
      return () => ipcRenderer.removeListener('ui-redesign:updates-changed', handler);
    },
  },
  matters: group('matters', ['list', 'query', 'run']),
  sync: group('sync', ['preview', 'commit']),
  systems: {
    ...group('systems', ['tabs', 'activateTab', 'list', 'session', 'login', 'closeLogin', 'reloadLogin', 'backLogin', 'logout']),
    onTabsChanged: () => () => {},
    onSessionChanged: () => () => {},
  },
});
