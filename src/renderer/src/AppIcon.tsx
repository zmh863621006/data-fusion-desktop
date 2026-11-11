import type { CSSProperties } from 'react';
import applicationMark from '../../../resources/app-icon.svg';

export function BrandMark() {
  return <div className="brand-mark" aria-hidden="true"><img src={applicationMark} alt="" draggable={false} /></div>;
}

export type IconName = 'home' | 'building' | 'government' | 'person' | 'truck' | 'car' | 'document' | 'components' | 'settings' | 'shield' | 'database' | 'arrow' | 'chevron' | 'upload' | 'download' | 'check' | 'warning' | 'search' | 'close' | 'refresh' | 'dashboard';

const paths: Record<IconName, React.ReactNode> = {
  dashboard: <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M7 16v-4m5 4V7m5 9v-7" /></>,
  home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h5v-7h4v7h5V9" /></>,
  building: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h1m4 0h1M9 11h1m4 0h1M9 15h1m4 0h1M10 21v-3h4v3" /></>,
  government: <><path d="m3 8 9-5 9 5H3Zm1 13h16M6 10v8m6-8v8m6-8v8" /></>,
  person: <><circle cx="12" cy="7" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
  truck: <><path d="M3 5h11v12H3zM14 9h4l3 4v4h-7" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></>,
  car: <><path d="m5 9 2-5h10l2 5M3 15V9h18v6H3Zm2 0v5m14-5v5M6 12h2m8 0h2" /></>,
  document: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6M8 13h8m-8 4h6" /></>,
  components: <><path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm-9 5 9 5 9-5m-9 5v9" /></>,
  settings: <><path d="m9 3-.8 3-3 .8-2 3 2.2 2.2L5 15l2 3 3-.2 2 2.2 3-1 1-3 3-1 1-3-2.2-2 .2-3-3-2-3 .2L12 3H9Z" /><circle cx="12" cy="12" r="3" /></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7" /></>,
  arrow: <><path d="M4 12h16m-6-6 6 6-6 6" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" /></>,
  download: <><path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  warning: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3h.01" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></>,
};

const systemIcons: Record<string, IconName> = {
  'market-access': 'building', 'government-info': 'government', 'transport-practitioner': 'person',
  'oversize-transport': 'truck', 'online-car-permit': 'car',
  'guangdong-hrss': 'person',
};
export const systemIcon = (id: string): IconName => systemIcons[id] ?? 'components';

export function AppIcon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg className="app-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={style}>{paths[name]}</svg>;
}

export function SystemBadge({ id }: { id: string }) {
  return <span className={`system-badge system-badge-${id}`} aria-hidden="true"><span><AppIcon name={id === 'health-publicity' ? 'document' : systemIcon(id)} size={29} /></span></span>;
}
