import { session } from 'electron';
import { AppError } from '../../core/errors/app-error';
import { RequestGate } from '../../core/network/request-policy';
import {
  DEFAULT_EQUIPMENT_CITY, EQUIPMENT_API, EQUIPMENT_HOME_URL, EQUIPMENT_PARTITION, EQUIPMENT_SYSTEM_NAME,
  equipmentDate, equipmentHomeRoute,
} from './catalog';

export type EquipmentRow = Record<string, unknown>;
export type EquipmentReadKind = 'registration' | 'personnel';
export interface EquipmentClientOptions {
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  minimumIntervalMs?: number;
}

const MAX_ROWS = 50_000;
const record = (value: unknown): value is EquipmentRow => !!value && typeof value === 'object' && !Array.isArray(value);
export const sourceText = (value: unknown) => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
  ? String(value).trim() : '';
export const sourceFailure = (message: string) => new AppError('REMOTE_REQUEST_FAILED', message, { retryable: false });
const expired = () => new AppError('SESSION_EXPIRED', '特种设备系统会话已失效，请在原系统重新登录');
const LIST_PATHS: Record<EquipmentReadKind, string> = {
  registration: 'registerPreserve/queryMultipleTask',
  personnel: 'exam/queryMultipleTask',
};

function listFilters(kind: EquipmentReadKind, date: string, city: string): EquipmentRow {
  return kind === 'registration'
    ? { startDecisionTime: date, endDecisionTime: date, equLocateCityValue: city }
    : { startDecideTime: date, endDecideTime: date, equLocateCityValue: city, isDisclosure: '1' };
}

function rows(value: unknown): EquipmentRow[] {
  if (!Array.isArray(value) || !value.every(record)) throw sourceFailure('特种设备系统返回的列表格式异常');
  return value;
}

function pageData(value: unknown): { rows: EquipmentRow[]; total?: number } {
  if (!record(value)) throw sourceFailure('特种设备系统未返回分页数据');
  if (value.total == null) return { rows: rows(value.rows) };
  const rawTotal = sourceText(value.total);
  const total = Number(rawTotal);
  if (!/^\d+$/.test(rawTotal) || !Number.isSafeInteger(total)) throw sourceFailure('特种设备系统返回的记录总数无效');
  return { rows: rows(value.rows), total };
}

function identifier(row: EquipmentRow, key: string): string {
  const value = sourceText(row[key]);
  if (!value || value.length > 160 || /[\x00-\x1f/\\]/.test(value) || value === '.' || value === '..') {
    throw sourceFailure('特种设备记录缺少有效的业务标识，请在原系统核对');
  }
  return value;
}

const validToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 16384 && /^[\x21-\x7e]+$/.test(value) && !/^(?:null|undefined)$/i.test(value);

export class SpecialEquipmentClient {
  private token = '';
  private home?: string;
  private probeKind: EquipmentReadKind = 'registration';
  private revision = 0;
  private rejected = false;
  private loginVisible = false;
  private readonly now: () => number;
  private readonly fetcher: NonNullable<EquipmentClientOptions['fetcher']>;
  private readonly gate: RequestGate;

  constructor(options: EquipmentClientOptions = {}) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? ((url, init) => session.fromPartition(EQUIPMENT_PARTITION).fetch(url, init));
    this.gate = new RequestGate({ timeoutMs: 20_000, maxAttempts: 2, retryDelayMs: 600, minimumIntervalMs: options.minimumIntervalMs ?? 250 });
  }

  apiCredentials() {
    return { revision: this.revision, status: this.rejected ? 'expired' : this.token ? 'present' : 'missing' } as const;
  }

  browserAuthGeneration(): number | null { return this.loginVisible ? null : this.revision; }

  acceptToken(value: string, requestUrl?: string): void {
    if (this.loginVisible || !validToken(value)) return;
    if (value !== this.token) {
      this.token = value;
      this.revision++;
      this.rejected = false;
      this.probeKind = 'registration';
    }
    if (this.rejected) return;
    if (requestUrl?.startsWith(EQUIPMENT_API + 'exam/')) this.probeKind = 'personnel';
    if (requestUrl?.startsWith(EQUIPMENT_API + 'registerPreserve/')) this.probeKind = 'registration';
  }

  setLoginVisible(visible: boolean): void {
    this.loginVisible = visible;
    if (visible) this.clear();
  }

  noteNavigation(url: string): void {
    const home = equipmentHomeRoute(url);
    if (home) this.home = home;
  }

  homeUrl(): string { return this.home ?? EQUIPMENT_HOME_URL; }

  snapshot(): EquipmentRow | null {
    return this.token && !this.rejected ? { token: this.token, home: this.homeUrl(), probeKind: this.probeKind } : null;
  }

  restore(value: EquipmentRow): void {
    if (!validToken(value.token)) return;
    this.acceptToken(value.token);
    this.home = equipmentHomeRoute(value.home);
    this.probeKind = value.probeKind === 'personnel' ? 'personnel' : 'registration';
  }

  clear(): void {
    this.revision++;
    this.token = '';
    this.rejected = false;
    this.home = undefined;
    this.probeKind = 'registration';
  }

  assertSession(revision: number): void {
    if (revision !== this.revision || !this.token || this.rejected) throw expired();
  }

  private rejectToken(revision: number): never {
    this.assertSession(revision);
    this.expireToken();
    throw expired();
  }

  expireToken(): void {
    if (!this.token || this.rejected) return;
    this.revision++;
    this.rejected = true;
  }

  async validateSession(signal?: AbortSignal): Promise<{ displayName: string }> {
    const date = equipmentDate(this.now());
    const kind = this.probeKind;
    const reply = await this.request(this.revision, LIST_PATHS[kind] + '/1/1', listFilters(kind, date, DEFAULT_EQUIPMENT_CITY), signal);
    pageData(reply);
    return { displayName: `${EQUIPMENT_SYSTEM_NAME}会话` };
  }

  applications(revision: number, kind: EquipmentReadKind, date: string, city: string, signal?: AbortSignal) {
    const params = listFilters(kind, date, city);
    const key = kind === 'registration' ? 'businessId' : 'id';
    return this.readPages(revision, LIST_PATHS[kind], params, 200, row => identifier(row, key), signal);
  }

  equipment(revision: number, application: EquipmentRow, signal?: AbortSignal) {
    const params = new URLSearchParams({
      applyType: identifier(application, 'applyType'), businessId: identifier(application, 'businessId'),
    });
    return this.readPages(revision, 'registerPreserveEqu/showEquInfo', {}, 10,
      row => sourceText(row.id) || sourceText(row.equCode) || sourceText(row.certCode), signal, '?' + params);
  }

  async registrationDocuments(revision: number, application: EquipmentRow, signal?: AbortSignal) {
    const params = new URLSearchParams({ businessId: identifier(application, 'businessId'), status: '归档' });
    return rows(await this.request(revision, 'registerDocumentAttachment/findAttachmentList?' + params, {}, signal));
  }

  async personnelDetails(revision: number, application: EquipmentRow, signal?: AbortSignal) {
    const id = encodeURIComponent(identifier(application, 'id'));
    const value = await this.request(revision, 'exam/findApplicationById/' + id, undefined, signal);
    if (!record(value)) throw sourceFailure('特种设备作业人员考核详情格式异常');
    return value;
  }

  async personnelDocuments(revision: number, application: EquipmentRow, signal?: AbortSignal) {
    const id = encodeURIComponent(identifier(application, 'id'));
    return rows(await this.request(revision, 'exam/findFile/' + id, undefined, signal));
  }

  private async readPages(revision: number, path: string, params: EquipmentRow, pageSize: number,
    identity: (row: EquipmentRow) => string, signal?: AbortSignal, suffix = ''): Promise<EquipmentRow[]> {
    const all: EquipmentRow[] = [], seen = new Set<string>();
    let expected: number | undefined;
    for (let page = 1; page <= Math.floor(MAX_ROWS / pageSize) + 1; page++) {
      const result = pageData(await this.request(revision, `${path}/${page}/${pageSize}${suffix}`, params, signal));
      if (result.total !== undefined) {
        if (result.total > MAX_ROWS) throw sourceFailure('特种设备记录超过 50000 条，请缩小日期范围');
        if (expected !== undefined && expected !== result.total) throw sourceFailure('特种设备列表总数发生变化，请重新回流');
        expected = result.total;
      }
      for (const row of result.rows) {
        const key = identity(row);
        if (!key || seen.has(key)) throw sourceFailure('特种设备列表缺少唯一标识或分页重复，请在原系统核对');
        seen.add(key);
        all.push(row);
      }
      if (result.rows.length > pageSize || all.length > MAX_ROWS || (expected !== undefined && all.length > expected)) {
        throw sourceFailure('特种设备列表分页数量异常，请缩小日期范围后重试');
      }
      if (expected === undefined ? result.rows.length < pageSize : all.length === expected) return all;
      if (!result.rows.length) throw sourceFailure('特种设备列表分页不完整，请重新回流');
    }
    throw sourceFailure('特种设备列表超出分页上限，请缩小日期范围');
  }

  private async request(revision: number, path: string, params?: EquipmentRow, outerSignal?: AbortSignal) {
    return this.gate.execute(async (signal) => {
      this.assertSession(revision);
      let response: Response;
      try {
        response = await this.fetcher(EQUIPMENT_API + path, {
          method: params ? 'POST' : 'GET', headers: {
            Accept: 'application/json', Token: this.token, ...(params ? { 'Content-Type': 'application/json' } : {}),
          }, body: params ? JSON.stringify(params) : undefined, redirect: 'manual', signal,
        });
      } catch { throw new AppError('REMOTE_REQUEST_FAILED', '连接特种设备系统失败，请检查网络'); }
      this.assertSession(revision);
      if ([401, 403].includes(response.status)) this.rejectToken(revision);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location && new URL(location, EQUIPMENT_API).pathname.startsWith('/zwrz/login')) this.rejectToken(revision);
        throw sourceFailure('特种设备接口跳转到其他页面，请在原系统核对登录状态');
      }
      if (!response.ok) throw new AppError('REMOTE_REQUEST_FAILED', `特种设备接口请求失败（HTTP ${response.status}）`, { retryable: response.status >= 500 });
      let reply: unknown;
      try { reply = await response.json(); }
      catch { throw sourceFailure('特种设备接口未返回有效 JSON，请在原系统核对登录状态'); }
      this.assertSession(revision);
      if (!record(reply)) throw sourceFailure('特种设备系统返回的数据格式异常');
      if (['401', '403'].includes(sourceText(reply.code))) this.rejectToken(revision);
      if (!Object.hasOwn(reply, 'data') || reply.success === false) throw sourceFailure('特种设备系统未返回有效业务数据');
      return reply.data;
    }, outerSignal);
  }
}
