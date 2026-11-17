import type { AutomaticUpdateState } from '../core/updater/automatic';
import { newer } from '../core/updater/service';
import type { BusinessBootstrapContext } from './business-bootstrap-context';

interface Dependencies {
  context: BusinessBootstrapContext;
  busy(): boolean;
  restart(): Promise<void>;
  changed(state: AutomaticUpdateState): void;
}
export interface BusinessUpdateCheckResult {
  configured: true;
  checkedAt: number;
  businessVersion: string;
  message: string;
}

/** Prepares a separate version directory; the running business process stays on its original files. */
export class StartupBusinessUpdates {
  private state: AutomaticUpdateState;
  private checking?: Promise<BusinessUpdateCheckResult>;
  private stopped = false;
  constructor(private readonly deps: Dependencies) {
    this.state = { status: 'up-to-date', kind: 'business', shellVersion: deps.context.shellVersion,
      currentVersion: deps.context.version, automatic: true, installMode: 'startup', offline: deps.context.offline,
      message: deps.context.offline ? '本次使用已校验的本地版本；下次启动将再次检查更新' : '启动更新检查已完成，当前业务版本可用' };
  }
  snapshot(): AutomaticUpdateState { return structuredClone(this.state); }
  start(): void { /* Cold-start enforcement belongs to the immutable bootstrap. */ }
  requestCheckSoon(): void { /* Account/settings changes cannot weaken or duplicate the startup gate. */ }
  private set(value: Partial<AutomaticUpdateState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...value }; this.deps.changed(this.snapshot());
  }
  async check(): Promise<BusinessUpdateCheckResult> {
    if (this.stopped) throw new Error('应用正在退出');
    if (this.state.status === 'installing') throw new Error('应用正在重启更新');
    if (this.checking) return this.checking;
    const work = (async () => {
      this.set({ status: 'checking', message: '正在检查业务更新', progress: undefined });
      try {
        const result = await this.deps.context.check(progress => {
          if (progress.phase === 'DOWNLOADING') this.set({ status: 'downloading', message: '正在后台准备业务更新，不影响当前工作',
            ...(progress.version ? { version: progress.version } : {}),
            progress: { downloaded: progress.downloaded ?? progress.received ?? 0, total: progress.total,
              percent: progress.total ? Math.min(99, Math.floor((progress.downloaded ?? progress.received ?? 0) / progress.total * 100)) : undefined } });
        });
        const available = newer(result.version, this.deps.context.version);
        const message = available ? '新业务版本已校验，保存工作后可重启应用；下次启动将自动进入新版本'
          : result.offline ? '暂时无法检查更新，当前继续使用已校验的本地版本' : '当前业务版本已是最新版本';
        const checkedAt = Date.now();
        this.set({ status: available ? 'ready' : 'up-to-date', version: available ? result.version : undefined,
          progress: undefined, checkedAt, message, offline: result.offline });
        return { configured: true as const, checkedAt, businessVersion: result.version, message };
      } catch {
        this.set({ status: 'error', progress: undefined, message: '业务更新尚未准备完成，请稍后重试；当前工作可以继续，已确认的更新将在下次启动时完成' });
        throw new Error('业务更新尚未准备完成，请稍后重试');
      }
    })();
    this.checking = work;
    try { return await work; } finally { if (this.checking === work) this.checking = undefined; }
  }
  async download(): Promise<void> { await this.check(); }
  async install(): Promise<void> {
    if (this.stopped || this.state.status !== 'ready' || this.checking) throw new Error('请先检查并准备业务更新');
    if (this.deps.busy()) throw new Error('正在回流、查询或导出，请等待任务完成后重启更新');
    this.set({ status: 'installing', message: '正在保存会话和业务数据，随后重新启动应用' });
    try { await this.deps.restart(); }
    catch { this.set({ status: 'ready', message: '本次尚未重启，请保存工作后重试' }); throw new Error('应用尚未重启，请稍后重试'); }
  }
  async stop(): Promise<void> {
    this.stopped = true; this.deps.context.cancelCheck?.();
    await this.checking?.catch(() => {});
  }
}
