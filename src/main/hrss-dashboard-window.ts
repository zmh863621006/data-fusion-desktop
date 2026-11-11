import { BrowserWindow } from 'electron';
import { join } from 'node:path';

/** A local, aggregate-only window. Source website views never share this window. */
export class HrssDashboardWindow {
  private window?: BrowserWindow;
  constructor(private readonly assets = { preload: join(__dirname, '../preload/index.js'), renderer: join(__dirname, '../renderer/index.html') }) {}
  contentsId(): number | undefined { return this.window?.isDestroyed() ? undefined : this.window?.webContents.id; }
  close(): void { this.window?.close(); }
  open(rendererUrl?: string): void {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return; }
    const window = new BrowserWindow({ title: '南山区公共就业数据看板', width: 1440, height: 900,
      minWidth: 860, minHeight: 620, fullscreen: true, autoHideMenuBar: true, backgroundColor: '#f5f5f7',
      webPreferences: { preload: this.assets.preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('before-input-event', (event, input) => { if (input.key === 'Escape') { event.preventDefault(); window.close(); } });
    window.once('closed', () => { if (this.window === window) this.window = undefined; });
    if (rendererUrl) {
      const url = new URL(rendererUrl); url.hash = 'hrss-dashboard'; void window.loadURL(url.href);
    } else void window.loadFile(this.assets.renderer, { hash: 'hrss-dashboard' });
  }
}
