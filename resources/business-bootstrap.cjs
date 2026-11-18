'use strict';
// The installed base package owns this entry, its public key and the update UI.
// Verified business code is loaded only after the cold-start update gate ends.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('original-fs');
const updater = require('./business-updater.cjs');
const shell = require('./shell.json');

if (process.platform === 'linux' && !app.commandLine.hasSwitch('password-store')) app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
const legacy = process.platform === 'win32' && Number(process.versions.electron.split('.')[0]) === 22;
const profile = app.commandLine.getSwitchValue('user-data-dir');
const profilePath = profile ? path.resolve(profile) : path.join(app.getPath('appData'), legacy ? 'data-fusion-desktop-win7' : 'data-fusion-desktop');
fs.mkdirSync(profilePath, { recursive: true }); app.setPath('userData', profilePath);
if (process.platform === 'win32') app.setAppUserModelId('cn.zzkj.datafusion.desktop');
const primaryInstance = app.requestSingleInstanceLock();
let window = null, running, businessAttempted = false, businessStarted = false, quitting = false;
const coldStartAbort = new AbortController();
let manualAbort;
let state = { status: 'checking', message: '正在检查可用版本…', detail: '准备完成后将自动进入应用。', version: shell.baseBusinessVersion };
const target = { platform: process.platform, arch: process.arch,
  variant: process.platform === 'linux' && process.env.DATA_FUSION_LINUX_COMPAT_VARIANT === 'kirin990-arm64' ? 'kirin990' : 'standard',
  electronMajor: Number(process.versions.electron.split('.')[0]) };
const lane = [target.platform, target.arch, target.variant, 'electron-' + target.electronMajor].join('-');
const directory = path.join(profilePath, 'updates', 'business', lane);
const allowLoopbackHttp = shell.testing === true && process.env.DATA_FUSION_STARTUP_TEST === '1';
const options = { directory, feedBase: shell.feedBase, publicKey: shell.publicKey, baseVersion: shell.baseBusinessVersion,
  shellVersion: shell.shellVersion, target, allowLoopbackHttp, baseBackend: shell.builtin?.backend };
app.on('before-quit', () => { coldStartAbort.abort(); if (manualAbort) manualAbort.abort(); });

function publish(value) {
  state = { ...state, ...value };
  if (window && !window.isDestroyed()) {
    const height = state.status === 'blocked' ? 320 : 250;
    if (window.getContentBounds().height !== height) window.setContentSize(380, height);
    window.webContents.send('business-startup:state', state);
  }
}
function record(event, value = {}) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'startup.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.previous');
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, version: state.version, ...value }) + '\n', { mode: 0o600 });
  } catch { /* Logging cannot turn a failed update into a successful launch. */ }
}
function blocked(code) {
  record('blocked', { code: /^[A-Z_]{1,80}$/.test(code || '') ? code : 'STARTUP_FAILED' });
  const detail = /TARGET|SHELL|COMPATIBLE/.test(code || '') ? '当前更新需要匹配的基础运行环境，请联系维护人员获取对应安装包。'
    : /SIGNATURE|CHECKSUM|ASAR|LOCAL|STATE|PAYLOAD/.test(code || '') ? '更新文件未通过校验。现有数据已保留，请重试或联系维护人员。'
      : /PENDING|DOWNLOAD|NETWORK|HTTP|CHECK/.test(code || '') ? '已确认的新版本尚未准备完成。请检查网络后重试，或退出应用稍后再试。'
        : '启动准备未能完成。现有数据已保留，可以重试或退出应用。';
  publish({ status: 'blocked', message: '暂时无法进入应用', detail, percent: undefined });
  showWindow();
}
function showWindow() {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({ width: 380, height: state.status === 'blocked' ? 320 : 250, frame: false, resizable: false, maximizable: false, show: false, autoHideMenuBar: true, backgroundColor: '#ffffff',
    title: '数据融合助手', webPreferences: { preload: path.join(__dirname, 'business-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => { if (window && !window.isDestroyed()) window.show(); });
  window.on('close', () => { if (!businessStarted && !quitting) { quitting = true; app.quit(); } });
  window.on('closed', () => { window = null; });
  void window.loadFile(path.join(__dirname, 'business-startup.html'));
}
const trusted = event => {
  if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id || event.senderFrame !== event.sender.mainFrame) throw Error('拒绝来自非启动页面的调用');
};
ipcMain.handle('business-startup:state', event => { trusted(event); return state; });
ipcMain.handle('business-startup:quit', event => { trusted(event); quitting = true; app.quit(); });
ipcMain.handle('business-startup:retry', async event => { trusted(event); await start(); return state; });
function onProgress(value) {
  const phase = String(value.phase || value.status || '').toLowerCase();
  const downloading = /download/.test(phase);
  const received = value.received ?? value.downloaded, total = value.total ?? value.bytes;
  publish({ status: downloading ? 'downloading' : 'preparing', message: downloading ? '正在下载业务更新…' : '正在校验并准备应用…',
    detail: downloading ? '新版本准备完成后将自动进入应用。' : '请稍候，授权、登录信息和业务数据会继续保留。',
    ...(value.version ? { version: value.version } : {}), percent: total > 0 && Number.isFinite(received) ? Math.min(100, Math.floor(received / total * 100)) : undefined });
  if (downloading && !quitting && !window) showWindow();
}
async function prepare() {
  if (shell.schema !== 1 || shell.product !== 'data-fusion-desktop' || Object.keys(target).some(key => target[key] !== shell.target?.[key])) throw Object.assign(Error('BASE_TARGET_MISMATCH'), { code: 'BASE_TARGET_MISMATCH' });
  const result = await updater.runStartupUpdate({ ...options, onProgress, manifestTimeoutMs: 3000, signal: coldStartAbort.signal, repairCache: true });
  if (result.status === 'blocked') return result;
  if (result.root) return result;
  const builtin = { schema: 1, product: shell.product, version: shell.baseBusinessVersion, minShellVersion: shell.builtin.minShellVersion,
    target, backend: shell.builtin.backend, bytes: shell.builtin.bytes, sha256: shell.builtin.sha256 };
  const selected = await updater.ensureBuiltinPayload({ ...options, asarFile: path.join(process.resourcesPath, 'business', 'builtin.asar'), manifest: builtin,
    signal: coldStartAbort.signal, repairCache: true });
  return { ...result, ...selected, status: result.status };
}
async function start() {
  if (running) return running;
  running = (async () => {
    try {
      publish({ status: 'checking', message: '正在检查可用版本…', detail: '无法联网且尚未确认新版时，将使用已校验的本地版本。', percent: undefined });
      const selected = await prepare();
      if (quitting) return;
      if (selected.status === 'blocked') { blocked(selected.code); return; }
      publish({ status: 'preparing', message: '正在启动应用…', detail: '', version: selected.version, percent: undefined });
      if (businessAttempted) { record('relaunch-after-repair'); app.relaunch(); quitting = true; app.quit(); return; }
      const context = {
        schema: 1, primaryInstance: true, profilePath, shellVersion: shell.shellVersion, version: selected.version,
        root: selected.root, backend: selected.backend || selected.manifest.backend, offline: selected.status === 'offline',
        check: async progress => prepareForNextStart(progress),
        cancelCheck: () => { if (manualAbort) manualAbort.abort(); },
        ready: () => {
          businessStarted = true; record('business-ready', { offline: selected.status === 'offline', shellVersion: shell.shellVersion });
          if (window && !window.isDestroyed()) window.destroy(); window = null;
        },
        failed: code => { businessStarted = false; blocked(code || 'BUSINESS_START_FAILED'); },
      };
      Object.defineProperty(globalThis, '__DATA_FUSION_BUSINESS_BOOTSTRAP__', { value: Object.freeze(context), writable: false, configurable: false });
      businessAttempted = true; record('business-load', { offline: context.offline });
      require(path.join(selected.root, 'out', 'main', 'index.js'));
    } catch (error) { if (!quitting) blocked(error.code || 'BUSINESS_START_FAILED'); }
  })();
  try { await running; } finally { running = null; }
}
async function prepareForNextStart(progress) {
  const controller = new AbortController(); manualAbort = controller;
  try {
    const result = await updater.runStartupUpdate({ ...options, onProgress: typeof progress === 'function' ? progress : undefined, signal: controller.signal });
    if (result.status === 'blocked') throw Object.assign(Error('业务更新尚未准备完成，请重试'), { code: result.code });
    return { version: result.version, offline: result.status === 'offline' };
  } finally { if (manualAbort === controller) manualAbort = null; }
}
if (!primaryInstance) app.quit();
else {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('window-all-closed', () => { if (!businessStarted) app.quit(); });
  void app.whenReady().then(start).catch(error => blocked(error.code || 'STARTUP_FAILED'));
}
