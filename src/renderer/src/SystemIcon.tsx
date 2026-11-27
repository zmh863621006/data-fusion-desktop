import { useState, type CSSProperties, type ReactNode } from 'react';
import oneWindowSprite from './assets/system-icons/one-window-login-icon.png';
import shenzhenIntegratedMark from './assets/system-icons/shenzhen-integrated.png';
import hazardousMark from './assets/system-icons/hazardous-favicon.png';

// These are the original sites' static assets. Their safe URLs and hashes are
// documented beside the images; none is loaded from the source website at runtime.
const sourceMarks: Record<string, { src: string; viewBox?: string }> = {
  'shenzhen-one-window': { src: oneWindowSprite, viewBox: '8 324 69 62' },
  'shenzhen-integrated-services': { src: shenzhenIntegratedMark },
  'shenzhen-hazardous-chemicals': { src: hazardousMark },
};

/** Display an original static mark when available, otherwise retain the caller's business glyph. */
export function SourceSystemIcon({ id, size = 20, style, fallback }: {
  id: string; size?: number; style?: CSSProperties; fallback: ReactNode;
}) {
  const asset = sourceMarks[id];
  const [failedSource, setFailedSource] = useState<string>();
  if (!asset || failedSource === asset.src) return <>{fallback}</>;
  return <span className="source-system-icon" data-source-system={id} aria-hidden="true" style={{ width: size, height: size, ...style }}>
    {asset.viewBox
      ? <svg width={size} height={size} viewBox={asset.viewBox} aria-hidden="true" focusable="false">
        <image href={asset.src} width="600" height="447" onError={() => setFailedSource(asset.src)} />
      </svg>
      : <img src={asset.src} alt="" draggable={false} onError={() => setFailedSource(asset.src)} />}
  </span>;
}
