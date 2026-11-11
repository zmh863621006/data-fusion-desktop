import { webcrypto } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { ReadableStream, WritableStream, TransformStream } from 'node:stream/web';
import { Blob } from 'node:buffer';

/** Loaded only by the Electron 22 build before application modules execute. */
export function installLegacyGlobals(http: Record<string, unknown>): void {
  const target = globalThis as unknown as Record<string, unknown>;
  const values: Record<string, unknown> = { ...http, crypto: webcrypto, Blob, ReadableStream, WritableStream, TransformStream,
    structuredClone: (value: unknown) => deserialize(serialize(value)) };
  for (const name of ['fetch', 'Headers', 'Request', 'Response', 'FormData', 'File', 'crypto', 'Blob', 'ReadableStream', 'WritableStream', 'TransformStream', 'structuredClone']) {
    if (target[name] === undefined && values[name] !== undefined) Object.defineProperty(target, name, { value: values[name], configurable: true, writable: true });
  }
  if (!AbortSignal.any) Object.defineProperty(AbortSignal, 'any', { configurable: true, writable: true,
    value: (signals: Iterable<AbortSignal>): AbortSignal => {
      const controller = new AbortController();
      const listeners: Array<[AbortSignal, () => void]> = [];
      const cleanup = () => { for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener); };
      controller.signal.addEventListener('abort', cleanup, { once: true });
      for (const signal of signals) {
        if (signal.aborted) { controller.abort(signal.reason); break; }
        const listener = () => controller.abort(signal.reason);
        signal.addEventListener('abort', listener, { once: true }); listeners.push([signal, listener]);
      }
      return controller.signal;
    } });
}
