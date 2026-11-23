import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  webRequest: { onBeforeSendHeaders: vi.fn(), onCompleted: vi.fn(), onErrorOccurred: vi.fn(), onBeforeRedirect: vi.fn() },
  clearStorageData: vi.fn(async () => {}), fromPartition: vi.fn(),
}));
vi.mock('electron', () => ({ session: { fromPartition: mocks.fromPartition } }));
import { clearBrowserAuth, observeBrowserAuth, observeBrowserAuthMany } from './browser-auth';

describe('browser session to API session bridge', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.fromPartition.mockReturnValue({ webRequest: mocks.webRequest, clearStorageData: mocks.clearStorageData }); });
  function setup() {
    const accept = vi.fn(); const clear = vi.fn();
    observeBrowserAuth({ partition: 'persist:test-system', urlPattern: 'https://test.example/api/*', header: 'authorization', accept, clear });
    return { accept, clear, before: mocks.webRequest.onBeforeSendHeaders.mock.calls[0][1], completed: mocks.webRequest.onCompleted.mock.calls[0][1],
      failed: mocks.webRequest.onErrorOccurred.mock.calls[0][1], redirected: mocks.webRequest.onBeforeRedirect.mock.calls[0][1] };
  }
  const response = { id: 1, url: 'https://test.example/api/list', statusCode: 200, responseHeaders: { 'Content-Type': ['application/json'] } };
  it('reads only the configured partition and accepts a successful API request without modifying it', () => {
    const api = setup(); const callback = vi.fn(); const requestHeaders = { Authorization: 'Bearer test-token' };
    api.before({ id: 1, requestHeaders }, callback); expect(api.accept).not.toHaveBeenCalled(); api.completed(response);
    expect(mocks.fromPartition).toHaveBeenCalledWith('persist:test-system');
    expect(callback).toHaveBeenCalledWith({ requestHeaders });
    expect(api.accept).toHaveBeenCalledWith('Bearer test-token', response.url);
    api.completed(response); expect(api.accept).toHaveBeenCalledTimes(1);
  });
  it('does not mistake HTML login pages or server failures for authenticated APIs', () => {
    const api = setup();
    for (const result of [{ ...response, responseHeaders: { 'Content-Type': ['text/html'] } }, { ...response, statusCode: 500 }]) {
      api.before({ id: 1, requestHeaders: { authorization: 'Bearer test-token' } }, vi.fn()); api.completed(result);
    }
    expect(api.accept).not.toHaveBeenCalled();
  });
  it('clears expired sessions and removes candidates on failure or redirect', () => {
    const api = setup();
    api.before({ id: 1, requestHeaders: { authorization: 'Bearer test-token' } }, vi.fn()); api.completed({ ...response, statusCode: 401 });
    expect(api.clear).toHaveBeenCalledOnce();
    for (const cleanup of [api.failed, api.redirected]) {
      api.before({ id: 1, requestHeaders: { authorization: 'Bearer test-token' } }, vi.fn()); cleanup({ id: 1 }); api.completed(response);
    }
    expect(api.accept).not.toHaveBeenCalled();
  });
  it('does not carry credentials across a reused request with no auth header', () => {
    const api = setup();
    api.before({ id: 1, requestHeaders: { authorization: 'Bearer test-token' } }, vi.fn());
    api.before({ id: 1, requestHeaders: {} }, vi.fn()); api.completed(response);
    expect(api.accept).not.toHaveBeenCalled();
  });
  it('ignores responses from before and during browser sign-out', () => {
    let generation: number | null = 1;
    const accept = vi.fn(), clear = vi.fn();
    observeBrowserAuth({ partition: 'persist:test', urlPattern: 'https://test.example/api/*', header: 'token', accept, clear,
      credentialGeneration: () => generation });
    const before = mocks.webRequest.onBeforeSendHeaders.mock.calls[0][1], completed = mocks.webRequest.onCompleted.mock.calls[0][1];
    before({ id: 1, requestHeaders: { Token: 'old' } }, vi.fn());
    before({ id: 2, requestHeaders: { Token: 'old' } }, vi.fn());
    generation = null;
    before({ id: 3, requestHeaders: { Token: 'old' } }, vi.fn());
    generation = 2;
    completed(response);
    completed({ ...response, id: 2, statusCode: 401 });
    completed({ ...response, id: 3 });
    expect(accept).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
    before({ id: 4, requestHeaders: { Token: 'fresh' } }, vi.fn());
    completed({ ...response, id: 4 });
    expect(accept).toHaveBeenCalledExactlyOnceWith('fresh', response.url);
  });
  it('allows a system-specific authenticated landing page predicate', () => {
    const accept = vi.fn();
    observeBrowserAuth({ partition: 'persist:test', urlPattern: 'https://test.example/*', header: 'cookie', accept, clear: vi.fn(),
      acceptsResponse: details => details.url === 'https://test.example/index' });
    const before = mocks.webRequest.onBeforeSendHeaders.mock.calls[0][1]; const completed = mocks.webRequest.onCompleted.mock.calls[0][1];
    for (const path of ['login', 'index']) {
      before({ id: 1, requestHeaders: { Cookie: 'JSESSIONID=test' } }, vi.fn());
      completed({ ...response, url: `https://test.example/${path}`, responseHeaders: { 'Content-Type': ['text/html'] } });
    }
    expect(accept).toHaveBeenCalledExactlyOnceWith('JSESSIONID=test', 'https://test.example/index');
  });
  it('clears only the requested browser partition on logout', async () => {
    await clearBrowserAuth('persist:test-system');
    expect(mocks.fromPartition).toHaveBeenCalledExactlyOnceWith('persist:test-system'); expect(mocks.clearStorageData).toHaveBeenCalledOnce();
  });
  it('keeps portal tokens and independent WGBT cookies isolated within one Electron observer', () => {
    const token = vi.fn(), cookie = vi.fn(), clearToken = vi.fn(), clearCookie = vi.fn();
    observeBrowserAuthMany('persist:hrss', [
      { urlPattern: 'https://hrss.example/employment/*', header: 'access-token', accept: token, clear: clearToken },
      { urlPattern: 'https://hrss.example/WGBT/*', header: 'cookie', accept: cookie, clear: clearCookie },
    ]);
    expect(mocks.webRequest.onBeforeSendHeaders).toHaveBeenCalledOnce();
    const before = mocks.webRequest.onBeforeSendHeaders.mock.calls[0][1], completed = mocks.webRequest.onCompleted.mock.calls[0][1];
    before({ id: 1, url: 'https://hrss.example/employment/list', requestHeaders: { 'Access-Token': 'portal-test', Cookie: 'other=cookie' } }, vi.fn());
    completed({ ...response, url: 'https://hrss.example/employment/list' });
    expect(token).toHaveBeenCalledExactlyOnceWith('portal-test', 'https://hrss.example/employment/list'); expect(cookie).not.toHaveBeenCalled();
    before({ id: 2, url: 'https://hrss.example/WGBT/list', requestHeaders: { Cookie: 'wgbt=independent', 'Access-Token': 'ignored' } }, vi.fn());
    completed({ ...response, id: 2, url: 'https://hrss.example/WGBT/list' });
    expect(cookie).toHaveBeenCalledExactlyOnceWith('wgbt=independent', 'https://hrss.example/WGBT/list');
    before({ id: 3, url: 'https://hrss.example/WGBT/list', requestHeaders: { Cookie: 'wgbt=expired' } }, vi.fn());
    completed({ ...response, id: 3, statusCode: 401 });
    expect(clearCookie).toHaveBeenCalledOnce(); expect(clearToken).not.toHaveBeenCalled();
  });
});
