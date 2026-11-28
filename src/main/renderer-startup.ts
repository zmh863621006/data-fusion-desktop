import type { IpcMainInvokeEvent } from 'electron';

interface StartupDependencies {
  contentsId(): number;
  mainFrame(): unknown;
  verifyView(): Promise<boolean>;
  show(): void;
  ready(): void;
  failed(code: string): void;
  timeoutMs?: number;
}

/** A first paint alone is not evidence that React and its IPC-backed first view work. */
export class RendererStartupGuard {
  private painted = false;
  private acknowledged = false;
  private ready = false;
  private failed = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout>;
  constructor(private readonly deps: StartupDependencies) {
    this.timer = setTimeout(() => this.fail('BUSINESS_RENDERER_TIMEOUT'), deps.timeoutMs ?? 25_000);
    this.timer.unref?.();
  }
  firstPaint(): void { this.painted = true; this.finish(); }
  async acknowledge(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): Promise<boolean> {
    if (event.sender.id !== this.deps.contentsId() || event.senderFrame !== this.deps.mainFrame()) throw new Error('拒绝来自非受信页面的启动确认');
    if (this.disposed || this.failed) return false;
    if (!await this.deps.verifyView()) return false;
    if (this.disposed || this.failed) return false;
    this.acknowledged = true; this.finish(); return true;
  }
  private finish(): void {
    if (this.disposed || this.failed || this.ready || !this.painted || !this.acknowledged) return;
    this.ready = true; clearTimeout(this.timer); this.deps.show(); this.deps.ready();
  }
  fail(code: string): void {
    if (this.disposed || this.failed) return;
    this.failed = true; clearTimeout(this.timer); this.deps.failed(code);
  }
  dispose(): void { this.disposed = true; clearTimeout(this.timer); }
}
