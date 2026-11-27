import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { installF12DevTools, installMainWindowF12, openDetachedDevTools } from './devtools';

function contents() {
  const value = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false), isDevToolsOpened: vi.fn(() => false), openDevTools: vi.fn(),
    devToolsWebContents: { isDestroyed: vi.fn(() => false), focus: vi.fn() },
  });
  return { value, typed: value as unknown as WebContents };
}

describe('F12 detached developer tools', () => {
  it('opens on key-down only, suppresses auto-repeat and unrelated keyboard shortcuts', () => {
    const { value, typed } = contents(), event = { preventDefault: vi.fn() };
    installF12DevTools(typed);
    value.emit('before-input-event', event, { type: 'keyUp', key: 'F12' });
    value.emit('before-input-event', event, { type: 'keyDown', key: 'F11' });
    expect(value.openDevTools).not.toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled();
    value.emit('before-input-event', event, { type: 'keyDown', key: 'F12' });
    value.emit('before-input-event', event, { type: 'keyDown', key: 'F12', isAutoRepeat: true });
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(value.openDevTools).toHaveBeenCalledExactlyOnceWith({ mode: 'detach', activate: true });
  });

  it('focuses an opened inspector and avoids re-opening while the first window is still being created', () => {
    const { value, typed } = contents();
    expect(openDetachedDevTools(typed)).toBe(true);
    expect(openDetachedDevTools(typed)).toBe(true);
    expect(value.openDevTools).toHaveBeenCalledOnce();
    value.isDevToolsOpened.mockReturnValue(true); value.emit('devtools-opened');
    expect(openDetachedDevTools(typed)).toBe(true);
    expect(value.openDevTools).toHaveBeenCalledOnce(); expect(value.devToolsWebContents.focus).toHaveBeenCalledTimes(2);
    value.isDevToolsOpened.mockReturnValue(false); value.emit('devtools-closed');
    expect(openDetachedDevTools(typed)).toBe(true); expect(value.openDevTools).toHaveBeenCalledTimes(2);
  });

  it('routes a focused app toolbar to the displayed source, then to the workbench when no source is active', () => {
    const { value, typed } = contents(), source = vi.fn(() => true), event = { preventDefault: vi.fn() };
    installMainWindowF12(typed, source);
    value.emit('before-input-event', event, { type: 'keyDown', key: 'F12' });
    expect(source).toHaveBeenCalledOnce(); expect(value.openDevTools).not.toHaveBeenCalled();
    source.mockReturnValue(false);
    value.emit('before-input-event', event, { type: 'keyDown', key: 'F12' });
    expect(value.openDevTools).toHaveBeenCalledExactlyOnceWith({ mode: 'detach', activate: true });
  });

  it('does not open destroyed contents and releases a failed or cancelled creation for retry', () => {
    const { value, typed } = contents();
    value.isDestroyed.mockReturnValue(true); expect(openDetachedDevTools(typed)).toBe(false);
    value.isDestroyed.mockReturnValue(false); value.openDevTools.mockImplementationOnce(() => { throw Error('closed'); });
    expect(openDetachedDevTools(typed)).toBe(false); expect(openDetachedDevTools(typed)).toBe(true);
    value.emit('devtools-closed'); expect(openDetachedDevTools(typed)).toBe(true);
    expect(value.openDevTools).toHaveBeenCalledTimes(3);
  });
});
