/** A small, serial queue for opportunistic list enrichment. It never owns business records. */
export class LocalEnrichmentQueue {
  private readonly waiting = new Map<string, (signal: AbortSignal) => Promise<void>>();
  private readonly checked = new Map<string, number>();
  private activeKey?: string;
  private active?: Promise<void>;
  private readonly controller = new AbortController();

  schedule(key: string, work: (signal: AbortSignal) => Promise<void>): void {
    if (this.controller.signal.aborted || this.activeKey === key || this.waiting.has(key)
      || Date.now() - (this.checked.get(key) ?? -Infinity) < 30_000) return;
    // Rapid paging should not queue unbounded lookups of pages no longer visible.
    if (this.waiting.size >= 20) this.waiting.delete(this.waiting.keys().next().value!);
    this.waiting.set(key, work);
    this.pump();
  }

  private pump(): void {
    if (this.active || !this.waiting.size || this.controller.signal.aborted) return;
    this.active = this.drain().finally(() => {
      this.active = undefined;
      // A new page can arrive after drain's final loop check but before this microtask.
      this.pump();
    });
  }

  private async drain(): Promise<void> {
    while (this.waiting.size && !this.controller.signal.aborted) {
      const [key, work] = this.waiting.entries().next().value!;
      this.waiting.delete(key);
      this.activeKey = key;
      try { await work(this.controller.signal); }
      catch { if (!this.controller.signal.aborted) console.warn('后台企业补全暂未完成，已保留本地记录'); }
      finally {
        this.checked.delete(key);
        this.checked.set(key, Date.now());
        while (this.checked.size > 200) this.checked.delete(this.checked.keys().next().value!);
        this.activeKey = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    this.waiting.clear();
    await this.active;
  }
}
