import { net, session, type Session } from 'electron';

/** Electron 22 net.request retains partition cookies, proxy settings and TLS
 * verification. It never forwards source credentials to a Node-only fetch jar. */
function fetchInSession(browser: Session, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const source = new Request(input, init);
  if (!['http:', 'https:'].includes(new URL(source.url).protocol)) return Promise.reject(new TypeError('不支持的原系统请求协议'));
  return new Promise<Response>((resolve, reject) => {
    let resolved = false, finished = false, redirects = 0, currentUrl = source.url;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const request = net.request({ url: source.url, method: source.method, session: browser, redirect: 'manual',
      useSessionCookies: source.credentials !== 'omit', credentials: source.credentials });
    const cleanup = () => source.signal.removeEventListener('abort', abort);
    const fail = (error: Error) => {
      if (finished) return;
      finished = true; cleanup();
      if (resolved) controller?.error(error); else reject(error);
    };
    const abort = () => { fail(source.signal.reason instanceof Error ? source.signal.reason : new Error('原系统请求已取消')); request.abort(); };
    const metadata = (response: Response) => {
      Object.defineProperties(response, { url: { value: currentUrl }, redirected: { value: redirects > 0 } });
      return response;
    };
    source.signal.addEventListener('abort', abort, { once: true });
    if (source.signal.aborted) { abort(); return; }
    for (const [name, value] of source.headers) request.setHeader(name, value);
    request.on('error', () => fail(new TypeError('原系统网络请求失败')));
    request.on('redirect', (status, _method, target, rawHeaders) => {
      if (source.redirect === 'error' || ++redirects > 20) { fail(new TypeError('原系统请求不允许重定向')); request.abort(); return; }
      if (source.redirect === 'manual') {
        const headers = new Headers();
        for (const [name, values] of Object.entries(rawHeaders)) for (const value of Array.isArray(values) ? values : [values]) headers.append(name, String(value));
        headers.set('location', target);
        resolved = true; finished = true; cleanup(); resolve(metadata(new Response(null, { status, headers }))); request.abort();
      } else { currentUrl = target; request.followRedirect(); }
    });
    request.on('response', incoming => {
      if (finished) return;
      const headers = new Headers();
      for (const [name, values] of Object.entries(incoming.headers)) for (const value of Array.isArray(values) ? values : [values]) headers.append(name, String(value));
      const empty = source.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
      const flow = incoming as typeof incoming & { pause?(): void; resume?(): void };
      const body = empty ? null : new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        pull() { flow.resume?.(); },
        cancel() { finished = true; cleanup(); request.abort(); },
      });
      incoming.on('data', (value: Buffer) => { if (!finished && controller) { controller.enqueue(new Uint8Array(value)); if ((controller.desiredSize ?? 1) <= 0) flow.pause?.(); } });
      incoming.on('end', () => { if (!finished) { finished = true; cleanup(); controller?.close(); } });
      incoming.on('error', () => fail(new TypeError('原系统响应读取失败')));
      resolved = true; resolve(metadata(new Response(body, { status: incoming.statusCode, statusText: incoming.statusMessage, headers })));
    });
    void (async () => {
      const body = source.body ? Buffer.from(await source.arrayBuffer()) : undefined;
      if (finished) return;
      request.end(body);
    })().catch(() => { fail(new TypeError('原系统请求体读取失败')); request.abort(); });
  });
}

export function installLegacySessionFetch(): void {
  const prototype = Object.getPrototypeOf(session.defaultSession) as Session;
  if (typeof prototype.fetch === 'function') return;
  Object.defineProperty(prototype, 'fetch', { configurable: true, value(this: Session, input: RequestInfo | URL, init?: RequestInit) {
    return fetchInSession(this, input, init);
  } });
}
