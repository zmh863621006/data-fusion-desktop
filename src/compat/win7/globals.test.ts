import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLegacyGlobals } from './globals';
const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
afterEach(() => { vi.unstubAllGlobals(); Object.defineProperty(AbortSignal, 'any', descriptor); });

describe('Node 16 compatibility globals', () => {
  it('fills missing APIs without replacing supported native implementations', () => {
    const nativeFetch = globalThis.fetch;
    installLegacyGlobals({ fetch: () => {} }); expect(globalThis.fetch).toBe(nativeFetch);
    vi.stubGlobal('structuredClone', undefined); vi.stubGlobal('fetch', undefined);
    const fetcher = vi.fn(); installLegacyGlobals({ fetch: fetcher });
    expect(globalThis.fetch).toBe(fetcher);
    const source = { date: new Date(2026, 10, 10), values: new Map([['a', 1n]]) };
    const clone = structuredClone(source); expect(clone).toEqual(source); expect(clone).not.toBe(source);
  });
  it('propagates the first abort reason and removes listeners from the other signals', () => {
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true, writable: true }); installLegacyGlobals({});
    const first = new AbortController(), second = new AbortController(); const removed = vi.spyOn(second.signal, 'removeEventListener');
    const signal = AbortSignal.any([first.signal, second.signal]); const reason = new Error('cancel fixture'); first.abort(reason);
    expect(signal.aborted).toBe(true); expect(signal.reason).toBe(reason); expect(removed).toHaveBeenCalled();
    expect(AbortSignal.any([first.signal]).reason).toBe(reason);
  });
});
