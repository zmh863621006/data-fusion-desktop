import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/** Shared keyboard/focus behavior for the local editor and record detail sheet. */
export function Modal({ children, onClose, labelledBy, className, backdropClassName }: {
  children: ReactNode; onClose: () => void; labelledBy: string; className: string; backdropClassName: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const panel = ref.current!;
    const focusable = () => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(element => element.getClientRects().length > 0);
    (focusable()[0] ?? panel).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0], last = elements.at(-1);
      if (!first) { event.preventDefault(); panel.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last!.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <div className={backdropClassName} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <section ref={ref} className={className} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>{children}</section>
  </div>;
}
