import { app, BrowserWindow } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { appRuntime } from './runtime';
import { registerIpcHandlers } from './ipc';
import { loginTabController } from './login-tab';
import { operationalLog } from './operational-log';
import { AutomaticUpdateController } from '../core/updater/automatic';
import { IPC_CHANNELS } from '../core/ipc/channels';
import { prepareUpdateInstall, readUpdateInstallResult, updateInstallFailureMessage } from './update-installer';
import { HrssDashboardWindow } from './hrss-dashboard-window';
import { applicationExportDirectory } from './platform-paths';
import { configureLinuxSecretStorage } from './secure-storage';
import { runtimeUpdateTarget } from '../core/updater/service';
import { prepareLinuxUpdate } from './linux-update-installer';

configureLinuxSecretStorage(app.commandLine);

let mainWindow: BrowserWindow | null = null;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | undefined;
let updates: AutomaticUpdateController | undefined;
const hrssDashboard = new HrssDashboardWindow();
const legacyWindowsRuntime = process.platform === 'win32' && Number(process.versions.electron?.split('.')[0]) === 22;
const kirin990Runtime = process.platform === 'linux' && process.arch === 'arm64'
  && process.env.DATA_FUSION_LINUX_COMPAT_VARIANT === 'kirin990-arm64';
const profileName = legacyWindowsRuntime ? 'data-fusion-desktop-win7' : 'data-fusion-desktop';

// Keep the existing profile stable even when the displayed product name changes.
// An explicit Chromium-style profile argument also allows isolated release verification.
const profileArgument = app.commandLine.getSwitchValue('user-data-dir');
const profilePath = profileArgument ? resolve(profileArgument) : join(app.getPath('appData'), profileName);
mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
if (process.platform === 'win32') app.setAppUserModelId('cn.zzkj.datafusion.desktop');
const primaryInstance = app.requestSingleInstanceLock();

function quitSafely(): void {
  if (shutdownPromise) return;
  shutdownPromise = (async () => { await updates?.stop(); await appRuntime.shutdown(); })().catch(() => {
    console.error('退出时部分会话未能保存，下次启动可能需要重新登录');
  }).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f7',
    title: '数据融合助手',
    icon: join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'icons' : 'resources', 'app-icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL();
    if (currentUrl && url !== currentUrl) event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (!shutdownComplete && updates?.snapshot().status === 'installing') { event.preventDefault(); return; }
    if (!shutdownComplete) { event.preventDefault(); quitSafely(); }
  });
  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow) void appRuntime.restoreSourceTabs(mainWindow).catch(() => console.warn('部分原系统标签页暂未恢复，请手动打开'));
  });
  mainWindow.once('closed', () => {
    loginTabController.close();
    mainWindow = null;
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

if (!primaryInstance) {
  shutdownComplete = true;
  app.quit();
} else {
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

void app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  operationalLog.initialize(userDataPath, app.getVersion());
  operationalLog.installConsoleCapture();
  const exportDirectory = applicationExportDirectory({ platform: process.platform, packaged: app.isPackaged,
    executablePath: app.getPath('exe'), appPath: app.getAppPath(), documentsPath: app.getPath('documents') });
  await appRuntime.initialize(userDataPath, !app.isPackaged, app.getVersion(), exportDirectory);
  const installDirectory = dirname(app.getPath('exe'));
  const updateTarget = runtimeUpdateTarget(process.platform, process.arch);
  const installMode = app.isPackaged && process.platform === 'linux' && updateTarget ? 'system' : app.isPackaged && process.platform === 'win32'
    && ['Uninstall DataFusion.exe', 'Uninstall 数据融合助手.exe'].some(name => existsSync(join(installDirectory, name))) ? 'installed' : 'manual';
  const previousInstall = process.platform === 'win32' ? await readUpdateInstallResult(userDataPath) : null;
  updates = new AutomaticUpdateController({
    version: app.getVersion(), installMode, target: updateTarget,
    ...(!updateTarget ? { disabledReason: '当前系统或芯片架构暂不支持在线更新' } : {}),
    ...(legacyWindowsRuntime ? { disabledReason: 'Win7 兼容测试版暂未开放在线更新，请使用通用安装包升级' } : {}),
    ...(kirin990Runtime ? { disabledReason: '麒麟990兼容测试版请使用对应兼容安装包升级，暂不接收通用ARM64更新' } : {}),
    ...(previousInstall?.status === 'failed' && previousInstall.version !== app.getVersion()
      ? { lastInstallError: updateInstallFailureMessage(previousInstall.code) } : {}),
    settings: () => appRuntime.getSettings(), check: () => appRuntime.checkUpdates(),
    download: (artifact, progress, signal) => appRuntime.downloadUpdateArtifact(artifact, progress, signal),
    verify: (path, artifact) => appRuntime.verifyUpdateArtifact(path, artifact),
    busy: () => appRuntime.updateBusy(),
    changed: state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.updatesChanged, state); },
    install: async (installerPath, artifact) => {
      appRuntime.beginUpdateInstallation();
      let prepared: Awaited<ReturnType<typeof prepareUpdateInstall>> | undefined;
      let saving = false;
      try {
        if (process.platform === 'linux' && updateTarget) {
          const systemInstaller = await prepareLinuxUpdate({ installerPath, updatesDirectory: join(userDataPath, 'updates'), artifact, target: updateTarget });
          await updates?.stop();
          saving = true; await appRuntime.shutdown();
          await systemInstaller.open();
          shutdownComplete = true; app.quit(); return;
        }
        prepared = await prepareUpdateInstall({ installerPath, expectedSha256: artifact.sha256, installDirectory,
          executablePath: app.getPath('exe'), userDataDirectory: userDataPath, defaultUserDataDirectory: join(app.getPath('appData'), profileName),
          version: artifact.version, isPackaged: app.isPackaged, parentPid: process.pid });
        await updates?.stop();
        saving = true; await appRuntime.shutdown();
        await prepared.commit();
        shutdownComplete = true; app.quit();
      } catch (error) {
        await prepared?.cancel().catch(() => {});
        appRuntime.cancelUpdateInstallation();
        if (saving) {
          // Once a database close has begun, never continue business work against a half-closed runtime.
          // No commit means the helper cannot install; relaunch the unchanged application instead.
          console.warn('更新前保存未完成，已取消安装并重新打开原版本');
          app.relaunch(); shutdownComplete = true; app.quit();
        }
        throw error;
      }
    },
  });
  registerIpcHandlers(() => mainWindow?.webContents.id, { updates, exportOwner: () => mainWindow, businessOperation: operation => appRuntime.businessOperation(operation),
    hrssDashboard: { contentsId: () => hrssDashboard.contentsId(), close: () => hrssDashboard.close(),
      open: () => hrssDashboard.open(!app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined) } });
  createMainWindow();
  updates.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}).catch((error: unknown) => {
  console.error('应用初始化失败', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (!shutdownComplete && updates?.snapshot().status === 'installing') { event.preventDefault(); return; }
  if (!shutdownComplete) { event.preventDefault(); quitSafely(); }
});
}
