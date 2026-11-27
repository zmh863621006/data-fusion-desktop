import type { WebContents } from 'electron';

const opening = new WeakSet<WebContents>();

/** Focus an existing detached inspector; rapid F12 presses do not create another one. */
export function openDetachedDevTools(contents: WebContents): boolean {
  if (contents.isDestroyed()) return false;
  if (contents.isDevToolsOpened() || opening.has(contents)) {
    const inspector = contents.devToolsWebContents;
    if (inspector && !inspector.isDestroyed()) inspector.focus();
    return true;
  }
  const ready = () => {
    opening.delete(contents);
    contents.removeListener('devtools-opened', ready);
    contents.removeListener('devtools-closed', ready);
  };
  opening.add(contents);
  contents.once('devtools-opened', ready);
  contents.once('devtools-closed', ready);
  try {
    contents.openDevTools({ mode: 'detach', activate: true });
    return true;
  } catch {
    ready();
    return false;
  }
}

export function installF12DevTools(contents: WebContents, open: () => void = () => { openDetachedDevTools(contents); }): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F12') return;
    event.preventDefault();
    if (!input.isAutoRepeat && !contents.isDestroyed()) open();
  });
}

/** The app toolbar may hold focus while a source tab is displayed. Inspect that source. */
export function installMainWindowF12(contents: WebContents, openActiveSource: () => boolean): void {
  installF12DevTools(contents, () => {
    if (!openActiveSource()) openDetachedDevTools(contents);
  });
}
