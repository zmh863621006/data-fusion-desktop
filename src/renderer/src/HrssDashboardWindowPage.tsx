import { useEffect, useRef, useState } from 'react';
import type { HrssDashboardData } from '../../core/hrss/dashboard';
import { HrssDashboard } from './HrssDashboard';

export function HrssDashboardWindowPage() {
  const [data, setData] = useState<HrssDashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false), mounted = useRef(true);
  const close = () => { void window.desktopApi.hrss.closeDashboard(); };
  const refresh = async () => {
    if (busy.current) return;
    busy.current = true; setLoading(true);
    try {
      const result = await window.desktopApi.hrss.dashboard();
      if (mounted.current) { setData(result); setError(''); }
    } catch (error) {
      // Invalidate the displayed aggregates when access has changed.
      if (mounted.current) { setData(null); setError(error instanceof Error ? error.message : '数据看板读取失败'); }
    } finally { busy.current = false; if (mounted.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true; void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => { mounted.current = false; window.clearInterval(timer); window.removeEventListener('keydown', onKey); };
  }, []);
  return <HrssDashboard data={data} loading={loading} error={error} onRefresh={() => void refresh()} onClose={close} />;
}
