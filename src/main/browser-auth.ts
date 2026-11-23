import { session, type OnCompletedListenerDetails } from 'electron';

/** Read credentials only from this partition's successful business requests. */
export interface BrowserAuthObservation {
  urlPattern: string;
  header: 'token' | 'authorization' | 'cookie' | 'access-token';
  /** Drop observations from an earlier session. Null pauses credential observation. */
  credentialGeneration?(): number | null;
  acceptsResponse?(details: OnCompletedListenerDetails, contentType: string): boolean;
  accept(value: string, sourceUrl?: string): void;
  clear(): void;
}

export function observeBrowserAuth(options: BrowserAuthObservation & { partition: string }): void {
  observeBrowserAuthMany(options.partition, [options]);
}

/** Electron supports one listener per event: install all rules for a partition together. */
export function observeBrowserAuthMany(partition: string, observations: BrowserAuthObservation[]): void {
  const browserSession = session.fromPartition(partition);
  const rules = observations.map(options => ({ options,
    pattern: new RegExp('^' + options.urlPattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$') }));
  const candidates = new Map<number, Array<{ options: BrowserAuthObservation; value: string; generation?: number | null }>>();
  const filter = { urls: [...new Set(observations.map(options => options.urlPattern))] };
  browserSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const matches = rules.filter(rule => !details.url || rule.pattern.test(details.url))
      .map(({ options }) => ({ options, value: headers[options.header], generation: options.credentialGeneration?.() }))
      .filter(item => item.value && item.generation !== null);
    if (matches.length) candidates.set(details.id, matches); else candidates.delete(details.id);
    callback({ requestHeaders: details.requestHeaders });
  });
  browserSession.webRequest.onCompleted(filter, (details) => {
    const matches = candidates.get(details.id) ?? [];
    candidates.delete(details.id);
    const contentType = Object.entries(details.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1]?.join('') ?? '';
    for (const { options, value, generation } of matches) {
      if (options.credentialGeneration?.() !== generation) continue;
      if (details.statusCode === 401 || details.statusCode === 403) { options.clear(); continue; }
      const accepted = options.acceptsResponse?.(details, contentType) ?? /json/i.test(contentType);
      if (details.statusCode >= 200 && details.statusCode < 300 && accepted) options.accept(value, details.url);
    }
  });
  browserSession.webRequest.onBeforeRedirect(filter, (details) => { candidates.delete(details.id); });
  browserSession.webRequest.onErrorOccurred(filter, (details) => { candidates.delete(details.id); });
}

export async function clearBrowserAuth(partition: string): Promise<void> {
  await session.fromPartition(partition).clearStorageData();
}
