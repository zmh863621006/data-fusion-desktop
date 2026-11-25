import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { App as AntApp, ConfigProvider } from 'antd';
import { AdminShell } from './App';
import { ReturnBatchSummary, ReturnRecordData } from './ReturnDataPage';
import { BusinessDistributionNotice, BusinessReleaseDetails } from './BusinessUpdatesPage';
import { downloadReturnBatch, latestReturnRequest, returnApi, returnQuery, type ReturnBatch } from './returns';
import type { BootstrapData } from './types';
import type { BusinessRelease } from './business-releases';

const data: BootstrapData = { user: { id: 'viewer', username: 'viewer', role: 'viewer' }, customers: [], licenses: [], devices: [], systems: [], tools: [], matters: [], updates: [], audits: [] };
const render = (node: React.ReactNode) => renderToStaticMarkup(<ConfigProvider><AntApp>{node}</AntApp></ConfigProvider>);
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const batch: ReturnBatch = { id: 'batch-1', clientBatchId: 'local-batch', customerId: 'customer', customerName: '<script>客户</script>', licenseId: 'license', deviceId: 'a'.repeat(64), systemId: 'government-info', systemName: '政务系统', matterId: 'matter', matterName: '许可', createdAt: 1, startedAt: 1, finishedAt: 2, completedAt: 3, rowCount: 1000, receivedRows: 1000, state: 'completed' };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('authenticated return data requests', () => {
  it('sends the full filter and pagination to a same-origin route, encoding user input', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ rows: [], total: 1400 })); vi.stubGlobal('fetch', fetch);
    const filters = { customerId: '甲&乙', deviceId: 'a'.repeat(64), systemId: 'government-info', matterId: 'permit', keyword: ' <script>& ', from: 100, to: 200, state: 'completed' as const };
    expect(await returnApi.list(filters, { page: 2, pageSize: 50 })).toMatchObject({ total: 1400 });
    const parsed = new URL(fetch.mock.calls[0][0] as string, 'https://government.example.invalid');
    expect(parsed.pathname).toBe('/api/admin/returns');
    expect(Object.fromEntries(parsed.searchParams)).toMatchObject({ page: '2', pageSize: '50', keyword: '<script>&', customerId: '甲&乙', from: '100', to: '200', state: 'completed' });
    expect(returnQuery({}, { page: 1, pageSize: 20 })).toBe('page=1&pageSize=20');
    fetch.mockResolvedValue(response({ batch, rows: [], total: 1000 }));
    await returnApi.detail('batch/encoded', { page: 3, pageSize: 20 });
    expect(fetch.mock.calls[1][0]).toBe('/api/admin/returns/batch%2Fencoded?page=3&pageSize=20');
  });
  it('downloads using cookies without following a server redirect or a remote URL', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ batch, rows: [] })); vi.stubGlobal('fetch', fetch);
    const blob = await downloadReturnBatch('batch/encoded');
    expect(JSON.parse(await blob.text()).batch.id).toBe(batch.id);
    expect(fetch.mock.calls[0][0]).toBe('/api/admin/returns/batch%2Fencoded/export');
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', redirect: 'error', headers: { accept: 'application/json' } });
    fetch.mockResolvedValue(new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));
    await expect(downloadReturnBatch(batch.id)).rejects.toMatchObject({ status: 502 });
  });
  it('reports expired-session exports and never saves the error as business data', async () => {
    const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: '请先登录' }, 401)));
    await expect(downloadReturnBatch(batch.id)).rejects.toMatchObject({ status: 401, message: '请先登录' });
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });
  it('silently cancels a superseded list request instead of showing a false network error', async () => {
    const controller = new AbortController(), dispatchEvent = vi.fn(); controller.abort();
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError')));
    await expect(returnApi.list({}, { page: 1, pageSize: 20 }, controller.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});

describe('batch request isolation', () => {
  it('ignores late success from an old customer or batch even if its transport ignores abort', async () => {
    const guard = latestReturnRequest(), old = deferred<string>(), recent = deferred<string>(), seen: string[] = [];
    let oldSignal: AbortSignal | undefined;
    const first = guard.run(signal => { oldSignal = signal; return old.promise; }, value => seen.push(value), () => seen.push('old error'));
    const second = guard.run(() => recent.promise, value => seen.push(value), () => seen.push('new error'));
    expect(oldSignal?.aborted).toBe(true);
    recent.resolve('new batch'); await second;
    old.resolve('old customer secret'); await first;
    expect(seen).toEqual(['new batch']);
  });
  it('ignores old failures and completion after the drawer closes, while current errors remain visible', async () => {
    const guard = latestReturnRequest(), pending = deferred<string>(), seen = vi.fn(), failed = vi.fn();
    const first = guard.run(() => pending.promise, seen, failed); guard.cancel();
    pending.reject(new Error('old secret')); await first;
    expect(seen).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
    await guard.run(() => Promise.reject(new Error('current failure')), seen, failed);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'current failure' }));
  });
});

describe('return data page and local distribution', () => {
  it('keeps the read-only return page accessible with all business filters', () => {
    vi.stubGlobal('window', { location: { hash: '#/returns', protocol: 'https:', hostname: 'government.example.invalid' }, matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }) });
    const html = render(<AdminShell initialData={data} onLoggedOut={() => {}} />);
    expect(html).toContain('href="#/returns"'); expect(html).toContain('aria-current="page"');
    for (const label of ['回流数据', '所属客户', '设备标识', '业务系统', '业务事项', '上传日期', '上传状态', '批次 / 业务记录关键词']) expect(html).toContain(label);
    expect(html).not.toContain('新增批次'); expect(html).not.toContain('删除批次');
  });
  it('escapes user-owned values and renders complete counts without treating a page as the total', () => {
    const html = render(<><ReturnBatchSummary batch={batch} /><ReturnRecordData record={{ rowNo: 1, recordKey: '<img src=x onerror=alert(1)>', data: { detail: '<script>alert(1)</script>', text: '业务原值' }, firstSeenAt: 1, updatedAt: 2 }} /></>);
    expect(html).toContain('1000 / 1000 条'); expect(html).toContain('业务原值'); expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img src=x'); expect(html).toContain('aria-label="原始业务记录"');
  });
  it('uses内网wording for local mode without exposing OSS instructions', () => {
    const html = render(<BusinessDistributionNotice catalog={{ rows: [], configured: true, feedBase: 'https://government.example.invalid/business-updates/', storageMode: 'local' }} />);
    expect(html).toContain('通过内网发布业务更新'); expect(html).toContain('内网更新入口'); expect(html).not.toContain('OSS');
    const row = { id: 'release', version: '1.1.12', target: { platform: 'win32', arch: 'x64', variant: 'standard', electronMajor: 44 }, fileName: 'business-1.1.12.asar', bytes: 1024, sha256: 'a'.repeat(64), notes: '', enabled: true, status: 'published', publishedAt: 1, createdAt: 1, metadata: null, url: 'https://government.example.invalid/business.asar', feedUrl: 'https://government.example.invalid/latest.json' } satisfies BusinessRelease;
    const details = render(<BusinessReleaseDetails release={row} storageMode="local" />);
    expect(details).toContain('内网更新入口'); expect(details).not.toContain('OSS');
  });
});
