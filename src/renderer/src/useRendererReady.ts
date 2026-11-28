import { useEffect } from 'react';

/** Invoked only after a real first view and its essential IPC response have committed. */
export function useRendererReady(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !window.desktopApi.startup) return;
    let disposed = false;
    const deadline = Date.now() + 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notify = async () => {
      if (disposed) return;
      try {
        if (await window.desktopApi.startup.ready()) return;
      } catch { /* The native guard presents recovery if the bridge cannot complete. */ }
      if (!disposed && Date.now() < deadline) timer = setTimeout(() => { void notify(); }, 250);
    };
    timer = setTimeout(() => { void notify(); }, 0);
    return () => { disposed = true; clearTimeout(timer); };
  }, [enabled]);
}
