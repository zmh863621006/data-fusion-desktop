import { newer, validArtifact, artifactMatchesTarget, type UpdateTarget, type DownloadProgress, type UpdateArtifact, type UpdateCheckResult } from './service';

export interface AutomaticUpdateState {
  status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'installing' | 'error' | 'disabled';
  currentVersion: string; version?: string; notes?: string; message: string;
  checkedAt?: number; progress?: DownloadProgress; automatic: boolean;
  installMode: 'installed' | 'system' | 'manual' | 'startup';
  kind?: 'business';
  shellVersion?: string;
  offline?: boolean;
  lastInstallError?: string;
}
export interface AutomaticUpdateDependencies {
  version: string;
  installMode: AutomaticUpdateState['installMode'];
  target?: UpdateTarget;
  settings(): Promise<{ autoCheckUpdates: boolean }>;
  check(): Promise<UpdateCheckResult>;
  download(artifact: UpdateArtifact, progress: (value: DownloadProgress) => void, signal: AbortSignal): Promise<string>;
  verify(path: string, artifact: UpdateArtifact): Promise<void>;
  install(path: string, artifact: UpdateArtifact): Promise<void>;
  busy(): boolean;
  changed(state: AutomaticUpdateState): void;
  lastInstallError?: string;
  disabledReason?: string;
}

/** Main-process state machine: automatic download, never an unsolicited interruption of business work. */
export class AutomaticUpdateController {
  private state: AutomaticUpdateState;
  private artifact?: UpdateArtifact;
  private path?: string;
  private running?: Promise<UpdateCheckResult>;
  private downloading?: Promise<void>;
  private abort = new AbortController();
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly deps: AutomaticUpdateDependencies) {
    this.state = { status: deps.disabledReason ? 'disabled' : 'idle', currentVersion: deps.version,
      message: deps.disabledReason ?? '正在等待检查更新', automatic: !deps.disabledReason, installMode: deps.installMode,
      ...(deps.lastInstallError ? { lastInstallError: deps.lastInstallError } : {}) };
  }
  snapshot(): AutomaticUpdateState { return structuredClone(this.state); }
  private target(): UpdateTarget { return this.deps.target ?? { platform: 'win32', arch: 'x64' }; }
  private installable(artifact: UpdateArtifact): boolean {
    const target = this.target();
    return artifactMatchesTarget(artifact, target) && artifact.platform === target.platform && artifact.arch === target.arch
      && (this.deps.installMode === 'installed' && target.platform === 'win32' && artifact.installer === 'nsis'
        || this.deps.installMode === 'system' && target.platform === 'linux' && artifact.installer === 'deb');
  }
  private readyMessage(): string {
    return this.deps.installMode === 'system' ? '更新包已下载并校验，保存工作后可打开系统安装器确认安装' : '更新已下载并校验，保存工作后可重启更新';
  }
  private set(value: Partial<AutomaticUpdateState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...value }; this.deps.changed(this.snapshot());
  }
  start(): void { this.schedule(10_000); }
  /** Called after activation/preferences change. The poll still respects the persisted opt-out. */
  requestCheckSoon(): void { this.schedule(1000); }
  private schedule(delay: number): void {
    clearTimeout(this.timer);
    if (this.stopped || this.deps.disabledReason) return;
    this.timer = setTimeout(() => { void this.poll(); }, delay); this.timer.unref?.();
  }
  private async poll(): Promise<void> {
    try {
      const settings = await this.deps.settings(); this.set({ automatic: settings.autoCheckUpdates });
      if (this.stopped) return;
      if (settings.autoCheckUpdates && this.state.status !== 'installing') await this.check(true);
      else if (!settings.autoCheckUpdates && this.state.status === 'idle') this.set({ message: '自动检查已关闭，可随时手动检查更新' });
    } catch { /* check() exposes a safe retryable status; background work never produces unhandled rejections. */ }
    finally { this.schedule(this.state.status === 'error' ? 15 * 60_000 : 4 * 60 * 60_000); }
  }
  async check(automatic = false): Promise<UpdateCheckResult> {
    if (this.stopped) throw new Error('更新服务正在退出');
    if (this.deps.disabledReason) return { configured: false, checkedAt: Date.now(), message: this.deps.disabledReason };
    if (this.state.status === 'installing') throw new Error('正在安装更新');
    if (this.running) return this.running;
    const work = (async () => {
      try {
        if (this.downloading) await this.downloading;
        this.set({ status: 'checking', message: '正在检查新版本', progress: undefined });
        const result = await this.deps.check();
        if (this.stopped) return result;
        if (!result.configured) {
          this.artifact = undefined; this.path = undefined;
          this.set({ status: 'disabled', version: undefined, notes: undefined, installMode: this.deps.installMode, checkedAt: result.checkedAt, message: result.message || '当前授权不支持在线更新' });
        } else if (!result.app) {
          this.artifact = undefined; this.path = undefined;
          this.set({ status: 'up-to-date', version: undefined, notes: undefined, installMode: this.deps.installMode, checkedAt: result.checkedAt, message: '当前已是最新版本' });
        } else {
          if (!validArtifact(result.app) || !artifactMatchesTarget(result.app, this.target()) || !newer(result.app.version, this.deps.version)) throw new Error('更新版本信息无效');
          const changed = this.artifact?.sha256 !== result.app.sha256 || this.artifact?.version !== result.app.version;
          if (changed) this.path = undefined;
          this.artifact = result.app;
          if (this.path) {
            try { await this.deps.verify(this.path, this.artifact); }
            catch { this.path = undefined; }
            if (this.stopped) return result;
          }
          this.set({ status: this.path ? 'ready' : 'available', version: result.app.version, notes: result.app.notes, checkedAt: result.checkedAt,
            installMode: this.installable(result.app) ? this.deps.installMode : 'manual',
            message: this.path ? this.readyMessage() : `发现新版本 ${result.app.version}` });
          if (this.installable(result.app) && !this.path) await this.download();
          else if (!automatic && !this.installable(result.app)) this.set({ message: '此运行方式或更新包需手动安装正式版，安装后可自动下载更新' });
        }
        return result;
      } catch {
        if (!this.stopped) this.set({ status: 'error', message: '更新检查或下载失败，请稍后重试；当前版本仍可正常使用', progress: undefined });
        throw new Error('更新检查或下载失败，请稍后重试');
      }
    })();
    this.running = work;
    try { return await work; } finally { if (this.running === work) this.running = undefined; }
  }
  async download(): Promise<void> {
    if (this.downloading) return this.downloading;
    if (this.state.status === 'checking') throw new Error('正在检查更新，请稍后下载');
    if (!this.artifact || this.stopped || this.state.status === 'installing') throw new Error('没有可下载的新版本');
    if (this.path && this.state.status === 'ready') return;
    const artifact = this.artifact;
    const work = (async () => {
      this.set({ status: 'downloading', message: '正在后台下载更新，不影响当前业务', progress: { downloaded: 0, total: artifact.bytes, percent: 0 } });
      try {
        const path = await this.deps.download(artifact, progress => this.set({ progress }), this.abort.signal);
        if (this.stopped) return;
        this.path = path;
        this.set({ status: 'ready', message: this.installable(artifact) ? this.readyMessage() : '安装包已下载并校验，请手动安装正式版' });
      } catch {
        this.path = undefined;
        this.set({ status: 'error', progress: undefined, message: '更新下载失败，可稍后重试；当前版本仍可正常使用' });
        throw new Error('更新下载失败，请稍后重试');
      }
    })();
    this.downloading = work;
    try { await work; } finally { if (this.downloading === work) this.downloading = undefined; }
  }
  async install(): Promise<void> {
    if (this.stopped || this.state.status !== 'ready' || !this.artifact || !this.path) throw new Error('请先下载并校验新版本');
    if (this.deps.busy()) throw new Error('正在回流、查询或导出，请等待任务完成后重启更新');
    if (this.running || this.downloading) throw new Error('请等待更新检查和下载完成');
    if (!this.installable(this.artifact)) throw new Error('当前为开发、免安装版或非自动安装包，请手动安装正式版以启用自动更新');
    const artifact = this.artifact, path = this.path;
    this.set({ status: 'installing', message: this.deps.installMode === 'system'
      ? '正在保存会话并打开系统安装器，请在系统窗口确认安装' : '正在保存会话，退出后自动安装并重新打开', progress: undefined });
    try {
      // Re-check live entitlement and publication: a disabled release is never installed from an old cache.
      const latest = await this.deps.check();
      if (this.stopped) throw new Error('更新服务正在退出');
      if (!latest.configured || !latest.app || !this.installable(latest.app) || latest.app.version !== artifact.version || latest.app.sha256 !== artifact.sha256) {
        this.path = undefined; this.artifact = undefined;
        this.set({ status: 'error', version: undefined, message: '更新版本或授权已变更，请重新检查更新' });
        throw new Error('版本已变更，请重新检查更新');
      }
      if (this.deps.busy()) throw new Error('业务任务尚未完成');
      try { await this.deps.verify(path, artifact); }
      catch { this.path = undefined; throw new Error('更新包校验失败，请重新检查并下载'); }
      if (this.stopped || this.deps.busy()) throw new Error('业务任务尚未完成或应用正在退出');
      await this.deps.install(path, artifact);
    } catch {
      this.set({ status: this.path ? 'ready' : 'error', message: this.path
        ? '暂未安装：请确认任务已结束、授权有效，再重试；原版本和数据保持不变'
        : '更新版本、授权或安装包已变更，请重新检查并下载；原版本和数据保持不变' });
      throw new Error('更新尚未安装，请检查任务和授权后重试');
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; clearTimeout(this.timer); this.abort.abort();
    await Promise.allSettled([this.running, this.downloading].filter(Boolean));
  }
}
