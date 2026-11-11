/** Polls without overlapping requests. Offline errors never grant or revoke permissions. */
export class OnlineLicenseMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  constructor(private readonly refresh: () => Promise<unknown>, private readonly intervalMs = 5 * 60_000) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.pending) return;
      this.pending = this.refresh().then(() => {}, () => {
        console.warn('定时授权校验未通过，请检查授权状态或网络');
      }).finally(() => { this.pending = undefined; });
    }, this.intervalMs);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
