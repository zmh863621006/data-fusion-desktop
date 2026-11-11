import { session, type Session } from 'electron';
import { AppError } from '../../core/errors/app-error';
import { RequestGate } from '../../core/network/request-policy';
import {
  downloadApprovalWorkbook,
  GOVERNMENT_INFO_BASE_URL,
  requestApprovalExportPath,
  type GovernmentInfoCredentials,
  type GovernmentInfoFetch,
} from './approval-export';
import { selectEcsSid } from './session-credentials';
import {
  buildAttachmentUrl, downloadApprovalAttachment, getRunningApprovalData,
  searchApprovalByPrimaryKey, searchApprovalEntry, checkGovernmentSession,
} from './approval-detail';
import { parseApprovalDocument } from './document-parser';
import { enrichGovernmentRecord } from './enrichment';

export { GOVERNMENT_INFO_BASE_URL } from './approval-export';
export const GOVERNMENT_INFO_LOGIN_URL = `${GOVERNMENT_INFO_BASE_URL}/ECS/LEAP/Login/440305/ECS2/Login.html`;
export const GOVERNMENT_INFO_PARTITION = 'persist:government-info';

export class GovernmentInfoClient {
  private readonly requestGate = new RequestGate({
    timeoutMs: 90_000,
    maxAttempts: 2,
    retryDelayMs: 1_000,
    minimumIntervalMs: 500,
  });
  private browserSession?: Session;
  private lid = '';
  private loadLid?: () => Promise<string | null>;
  private saveLid?: (lid: string) => Promise<void>;
  private clearLid?: () => Promise<void>;
  private observedSid = '';
  private networkDiagnosticsEnabled = false;
  private sessionDiagnosticLogged = false;

  configureSessionPersistence(options: {
    load: () => Promise<string | null>;
    save: (lid: string) => Promise<void>;
    clear: () => Promise<void>;
  }): void {
    this.loadLid = options.load;
    this.saveLid = options.save;
    this.clearLid = options.clear;
  }

  async initialize(): Promise<void> {
    this.browserSession = session.fromPartition(GOVERNMENT_INFO_PARTITION);
    this.lid = (await this.loadLid?.().catch(() => null))?.trim() ?? '';
    this.enableNetworkDiagnostics();
  }

  get session(): Session {
    if (!this.browserSession) throw new Error('政务综合信息平台客户端尚未初始化');
    return this.browserSession;
  }

  captureLid(url: string): void {
    try {
      const lid = new URL(url).searchParams.get('lid')?.trim();
      if (lid && lid !== this.lid) {
        this.lid = lid;
        void this.saveLid?.(lid).catch((error) => console.warn('政务综合信息平台会话标识保存失败', error));
      }
    } catch {
      // Ignore incomplete navigation URLs.
    }
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.credentials()) !== null;
  }

  async exportSession(): Promise<Record<string, unknown> | null> {
    const value = await this.credentials();
    return value ? { ...value } : null;
  }

  restoreSession(value: Record<string, unknown>): void {
    if (typeof value.lid === 'string' && typeof value.sid === 'string' && value.lid && value.sid) {
      // Navigation/request capture persists LID independently, even if RPC verification
      // failed. A legacy browser snapshot can therefore contain an older LID.
      // Keep the captured value loaded at initialization; still validate the pair remotely.
      this.lid ||= value.lid;
      this.observedSid = value.sid;
    }
  }

  homeUrl(): string {
    return `${GOVERNMENT_INFO_BASE_URL}/ECS/LEAP/Login/440305/ECS2/Index.html?lid=${encodeURIComponent(this.lid)}`;
  }

  async validateSession(signal: AbortSignal): Promise<{ displayName: string }> {
    const credentials = await this.credentials();
    if (!credentials) throw new AppError('SESSION_EXPIRED', '政务综合信息会话不完整');
    // Read-only list query, at most one row. No export, details or business write.
    const response = await checkGovernmentSession((url, init) => this.session.fetch(url, init), credentials, signal);
    if (!Array.isArray(response.result) || response.error || response._error) {
      throw new AppError('REMOTE_REQUEST_FAILED', '政务综合信息会话验证响应无法确认', { reason: 'UNEXPECTED_RESULT' });
    }
    return { displayName: '综合信息平台会话' };
  }

  async clearSession(): Promise<void> {
    this.lid = '';
    this.observedSid = '';
    this.sessionDiagnosticLogged = false;
    await this.clearLid?.().catch((error) => console.warn('政务综合信息平台会话标识清理失败', error));
    await this.session.clearStorageData({ storages: ['cookies', 'localstorage'] });
  }

  async exportApprovalWorkbook(startDate: string, endDate: string, outerSignal?: AbortSignal): Promise<Buffer> {
    const credentials = await this.credentials();
    if (!credentials) throw new AppError('SESSION_EXPIRED', '政务综合信息平台登录已失效，请重新登录');
    const fetcher = this.createFetcher();
    const exportPath = await this.requestGate.execute(async (signal) => {
      return requestApprovalExportPath(fetcher, credentials, startDate, endDate, signal);
    }, outerSignal);

    return this.requestGate.execute(async (signal) => {
      return downloadApprovalWorkbook(fetcher, credentials, exportPath, signal);
    }, outerSignal);
  }

  async enrichApprovalRecord(record: Record<string, unknown>, outerSignal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const credentials = await this.credentials();
    if (!credentials) throw new AppError('SESSION_EXPIRED', '政务综合信息平台登录已失效，请重新登录');
    const fetcher = this.createFetcher();
    return enrichGovernmentRecord({
      searchEntry: (cityLsh, signal) => this.requestGate.execute((gateSignal) => searchApprovalEntry(fetcher, credentials, cityLsh, gateSignal), signal),
      getRunningData: (wfEntryId, signal) => this.requestGate.execute((gateSignal) => getRunningApprovalData(fetcher, credentials, wfEntryId, gateSignal), signal),
      searchByPrimaryKey: (recordId, signal) => this.requestGate.execute((gateSignal) => searchApprovalByPrimaryKey(fetcher, credentials, recordId, gateSignal), signal),
      getDocument: async (primary, signal) => {
        const raw = typeof primary.cgwfj === 'string' ? primary.cgwfj : '';
        const fileInfo = JSON.parse(raw) as { nameedPath?: unknown; name?: unknown };
        if (typeof fileInfo.nameedPath !== 'string' || typeof fileInfo.name !== 'string') throw new Error('运行数据缺少有效的 cgwfj 附件信息');
        const data = await this.requestGate.execute((gateSignal) => downloadApprovalAttachment(fetcher, buildAttachmentUrl({ nameedPath: fileInfo.nameedPath as string, name: fileInfo.name as string }), gateSignal), signal);
        return parseApprovalDocument(data, fileInfo.name as string);
      },
    }, record, outerSignal);
  }

  private createFetcher(): GovernmentInfoFetch {
    return async (url, init) => {
      const startedAt = Date.now();
      let path = url;
      try { path = new URL(url).pathname; } catch { /* keep the supplied path */ }
      const method = init?.method ?? 'GET';
      console.info('政务综合信息平台回流接口请求', { method, path });
      try {
        const response = await this.session.fetch(url, init);
        console.info('政务综合信息平台回流接口响应', {
          method,
          path,
          statusCode: response.status,
          durationMs: Date.now() - startedAt,
        });
        return response;
      } catch (error) {
        console.error('政务综合信息平台回流接口失败', {
          method,
          path,
          durationMs: Date.now() - startedAt,
          error,
        });
        throw error;
      }
    };
  }

  private async credentials(): Promise<GovernmentInfoCredentials | null> {
    if (!this.lid) return null;
    // Query by name instead of the root URL so path-scoped LSID cookies are included as well.
    const cookies = await this.session.cookies.get({ name: 'LSID' });
    const cookieSid = selectEcsSid(
      cookies.filter((cookie) => cookie.name.toUpperCase() === 'LSID').map((cookie) => cookie.value),
    );
    const sid = this.observedSid || cookieSid;
    if (!this.sessionDiagnosticLogged && sid) {
      this.sessionDiagnosticLogged = true;
      console.info('政务综合信息平台会话诊断', {
        lidLength: this.lid.length,
        selectedSidLength: sid.length,
        cookies: cookies.map((cookie) => ({
          domain: cookie.domain,
          path: cookie.path,
          valueLength: cookie.value.length,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
        })),
      });
    }
    return sid ? { sid, lid: this.lid } : null;
  }

  private enableNetworkDiagnostics(): void {
    if (this.networkDiagnosticsEnabled) return;
    this.networkDiagnosticsEnabled = true;
    const filter = { urls: [`${GOVERNMENT_INFO_BASE_URL}/*`] };
    this.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      const headers = Object.fromEntries(
        Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), String(value ?? '')]),
      );
      const headerLid = headers.lid?.trim() ?? '';
      const qs = new URLSearchParams(headers.qs ?? '');
      const qsSid = qs.get('sid')?.trim() ?? '';
      const cookieSid = headers.cookie?.match(/(?:^|;\s*)LSID=([^;]+)/i)?.[1]?.trim() ?? '';
      const observedSid = selectEcsSid([qsSid, cookieSid]);
      if (headerLid) this.captureLid(`${GOVERNMENT_INFO_BASE_URL}/?lid=${encodeURIComponent(headerLid)}`);
      if (observedSid) this.observedSid = observedSid;
      let parsed: URL | null = null;
      try { parsed = new URL(details.url); } catch { /* ignore malformed diagnostic URLs */ }
      console.info('政务综合信息平台浏览器请求', {
        id: details.id,
        method: details.method,
        path: parsed?.pathname ?? details.url,
        queryKeys: parsed ? [...parsed.searchParams.keys()] : [],
        resourceType: details.resourceType,
        lidLength: headerLid.length,
        qsMethod: qs.get('method') ?? '',
        qsSidLength: qsSid.length,
        cookieSidLength: cookieSid.length,
        lidMatchesCurrent: !headerLid || headerLid === this.lid,
        qsSidMatchesCookie: !qsSid || !cookieSid || qsSid === cookieSid,
        dataType: headers['data-type'] ?? '',
        lrqvt: headers.lrqvt ?? '',
        postType: headers['post-type'] ?? '',
        responseType: headers.resptype ?? '',
        origin: headers.origin ?? '',
        refererPath: (() => {
          try { return new URL(headers.referer ?? '').pathname; } catch { return ''; }
        })(),
        contentType: headers['content-type'] ?? '',
        headerNames: Object.keys(headers).sort(),
      });
      callback({ requestHeaders: details.requestHeaders });
    });
    this.session.webRequest.onCompleted(filter, (details) => {
      let path = details.url;
      try { path = new URL(details.url).pathname; } catch { /* keep original diagnostic URL */ }
      console.info('政务综合信息平台浏览器响应', {
        id: details.id,
        method: details.method,
        path,
        statusCode: details.statusCode,
        fromCache: details.fromCache,
      });
    });
  }

}
