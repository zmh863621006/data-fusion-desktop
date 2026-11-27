import { session } from 'electron';
import { AppError } from '../../core/errors/app-error';
import { RequestGate } from '../../core/network/request-policy';
import { normalizeHousingCode } from '../../core/housing-binding/code';
import { HOUSING_HOME_URL, HOUSING_LOGIN_URL, HOUSING_ORIGIN, HOUSING_PARTITION, HOUSING_RPC_URL } from './catalog';
import {
  housingArea, housingAreaPrefix, housingAcceptancePrefix, housingExpired, housingFailure, housingIdentifier, housingInput,
  housingObject, housingRows, housingRpcRequest, housingSearch, housingText, parseHousingRpc,
  type HousingSearchParameter,
} from './protocol';
import type { HousingBindingClient, HousingBindingHouse, HousingBindingTarget } from './types';
export type { HousingBindingClient, HousingBindingHouse, HousingBindingTarget } from './types';

export interface HousingRentalClientOptions {
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  observeBrowser?: boolean;
  minimumIntervalMs?: number;
  timeoutMs?: number;
}

/** Scoped LEAP client. All raw credentials and RPC data remain in the main process. */
export class HousingRentalClient implements HousingBindingClient {
  private sid = '';
  private revision = 0;
  private expired = false;
  private loginVisible = false;
  private userArea = '';
  private userContext = '';
  private initialized = false;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly fetcher: NonNullable<HousingRentalClientOptions['fetcher']>;
  private readonly reads: RequestGate;
  private readonly writes: RequestGate;
  private readonly targets = new WeakMap<HousingBindingTarget, number>();
  private readonly houses = new WeakMap<HousingBindingHouse, { revision: number; propertyId: string }>();

  constructor(private readonly options: HousingRentalClientOptions = {}) {
    this.fetcher = options.fetcher ?? ((url, init) => session.fromPartition(HOUSING_PARTITION).fetch(url, init));
    const policy = { timeoutMs: options.timeoutMs ?? 30_000, minimumIntervalMs: options.minimumIntervalMs ?? 100,
      maxAttempts: 2, retryDelayMs: 250 };
    this.reads = new RequestGate(policy);
    // A response timeout cannot establish that a write did not reach the source.
    this.writes = new RequestGate({ ...policy, maxAttempts: 1 });
  }

  apiCredentials() { return { revision: this.revision, status: this.sid && !this.loginVisible ? 'present' as const : this.expired ? 'expired' as const : 'missing' as const }; }
  snapshot(): Record<string, unknown> | null { return this.sid && !this.expired ? { sid: this.sid } : null; }
  restore(value: Record<string, unknown>): void { if (typeof value.sid === 'string') this.acceptSid(value.sid); }
  homeUrl(): string { return HOUSING_HOME_URL; }
  clear(expired = false): void { this.sid = ''; this.userArea = ''; this.userContext = ''; this.expired = expired; this.revision++; }
  setLoginVisible(visible: boolean): void { if (visible && !this.loginVisible) this.clear(Boolean(this.sid) || this.expired); this.loginVisible = visible; }
  noteNavigation(value: string): void {
    try { const url = new URL(value); if (url.origin === HOUSING_ORIGIN && url.pathname === new URL(HOUSING_LOGIN_URL).pathname) this.setLoginVisible(true); }
    catch { /* An incomplete source navigation is not an authentication result. */ }
  }
  acceptSid(value: string): void {
    if (!/^[a-z\d_-]{16,256}$/i.test(value)) return;
    if (this.sid !== value || this.expired) { this.sid = value; this.userArea = ''; this.userContext = ''; this.revision++; }
    this.expired = false; this.loginVisible = false;
  }
  acceptRequestHeaders(headers: Record<string, string | string[]>): void {
    const value = Object.entries(headers).find(([key]) => key.toLowerCase() === 'qs')?.[1];
    if (typeof value !== 'string') return;
    const qs = new URLSearchParams(value), sid = qs.get('sid');
    if (qs.get('method') && sid) this.acceptSid(sid);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return; this.initialized = true;
    if (this.options.observeBrowser === false || this.options.fetcher && this.options.observeBrowser !== true) return;
    const browser = session.fromPartition(HOUSING_PARTITION), filter = { urls: [HOUSING_RPC_URL + '*'] };
    const candidates = new Map<number, { headers: Record<string, string | string[]>; revision: number }>();
    browser.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      candidates.set(details.id, { headers: { ...details.requestHeaders }, revision: this.revision });
      callback({ requestHeaders: details.requestHeaders });
    });
    browser.webRequest.onCompleted(filter, details => {
      const candidate = candidates.get(details.id); candidates.delete(details.id);
      if (!candidate || candidate.revision !== this.revision) return;
      if (details.statusCode === 401 || details.statusCode === 403) { this.clear(true); return; }
      const contentType = Object.entries(details.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1]?.join('') ?? '';
      if (details.statusCode >= 200 && details.statusCode < 300 && /text\/plain|json/i.test(contentType)) this.acceptRequestHeaders(candidate.headers);
    });
    browser.webRequest.onBeforeRedirect(filter, details => { candidates.delete(details.id); });
    browser.webRequest.onErrorOccurred(filter, details => { candidates.delete(details.id); });
  }

  private assertSession(revision?: number): void {
    if (!this.sid || this.loginVisible || this.expired || revision !== undefined && revision !== this.revision) throw housingExpired();
  }

  private async rpc(method: string, parameters: string[], type: '14' | '16', signal?: AbortSignal, write = false, allowEmpty = false): Promise<unknown> {
    const work = async () => {
      this.assertSession(); const revision = this.revision;
      return (write ? this.writes : this.reads).execute(async requestSignal => {
        this.assertSession(revision);
        let response: Response;
        try { response = await this.fetcher(HOUSING_RPC_URL, { ...housingRpcRequest(this.sid, method, parameters, type), signal: requestSignal }); }
        catch {
          if (requestSignal.aborted) throw new AppError('REMOTE_TIMEOUT', '房屋租赁请求超时');
          throw new AppError('REMOTE_REQUEST_FAILED', '房屋租赁系统暂时无法连接');
        }
        this.assertSession(revision);
        if ([301,302,303,307,308,401,403].includes(response.status)) { this.clear(true); throw housingExpired(); }
        if (!response.ok) throw new AppError('REMOTE_REQUEST_FAILED', `房屋租赁系统请求失败（${response.status}）`, { retryable: !write && (response.status === 408 || response.status === 429 || response.status >= 500) });
        try {
          const value = parseHousingRpc(await response.text(), allowEmpty);
          this.assertSession(revision);
          return value;
        } catch (error) { if (error instanceof AppError && error.code === 'SESSION_EXPIRED') this.clear(true); throw error; }
      }, signal);
    };
    const result = this.tail.then(work); this.tail = result.catch(() => undefined); return result;
  }

  async validateSession(signal?: AbortSignal): Promise<{ displayName: string }> {
    const value = await this.rpc('app_getLogicModuleOperations', ['ZLindex2','true','true'], '14', signal);
    if (!housingObject(value) || value.name !== 'ZLindex2' || !housingObject(value.userinfo)
      || !housingText(value.userinfo.userid) || !/^\d{18}$/.test(housingText(value.userinfo.areaid))) {
      this.clear(true); throw housingExpired();
    }
    const userinfo = value.userinfo;
    const context = JSON.stringify(['userid','areaid','positionid','orgid'].map(key => housingText(userinfo[key])));
    if (this.userContext && this.userContext !== context) this.revision++;
    this.userContext = context;
    this.userArea = housingArea(value.userinfo.areaid);
    return { displayName: '房屋租赁系统会话' };
  }

  private async search(name: string, parameters: HousingSearchParameter[], signal?: AbortSignal, size = 2) {
    const value = await this.rpc('DynaSearch', [JSON.stringify(housingSearch(name, parameters, size))], '16', signal, false, true);
    if (value === null) await this.validateSession(signal); // The source also uses an empty body for a valid empty list.
    return housingRows(value);
  }

  async resolveTarget(acceptanceNumber: string, certificateNumber: string, signal?: AbortSignal): Promise<HousingBindingTarget> {
    const acceptance = housingInput(acceptanceNumber, '受理编号'), certificate = housingInput(certificateNumber, '产权证号');
    await this.validateSession(signal); const revision = this.revision;
    const prefix = housingAreaPrefix(this.userArea), acceptancePrefix = housingAcceptancePrefix(this.userArea), scope: HousingSearchParameter[] = [
      { name: 'acceptareaid', value: acceptancePrefix.padEnd(18, '0'), flag: 16 }, { name: 'acceptareaid', value: acceptancePrefix.padEnd(18, '9'), flag: 17 },
    ];
    // For the source acceptance list this is a business-state marker, not the property tables' deletion marker.
    const cases = await this.search('tysl_transactor', [{ name: 'transactno', value: acceptance, flag: 11 }, ...scope, { name: 'delmark', value: 2, flag: 11 }], signal);
    if (cases.total !== 1 || cases.rows.length !== 1 || housingText(cases.rows[0].transactno) !== acceptance) throw new AppError('QUERY_INVALID', cases.total ? '受理编号未唯一匹配，请核对后重试' : '原系统合同受理列表中未找到该受理编号，请核对受理编号、列表入口及办理状态');
    if (housingText(cases.rows[0].delmark) !== '2') throw new AppError('QUERY_INVALID', '该办件不在原系统合同受理状态，请先核对办理状态');
    if (!housingArea(cases.rows[0].acceptareaid).startsWith(acceptancePrefix)) throw new AppError('QUERY_INVALID', '该办件不在当前账号管理范围内');
    const acceptanceId = housingIdentifier(cases.rows[0].id);
    const related = await this.search('tysl_contractproperty', [
      { name: 'TYSL_TRANSACTOR_ID', value: acceptanceId, flag: 11 }, { name: 'housecertification', value: certificate, flag: 11 },
    ], signal);
    if (related.total !== 1 || related.rows.length !== 1 || housingText(related.rows[0].housecertification) !== certificate
      || housingText(related.rows[0].tysl_transactor_id) !== acceptanceId) throw new AppError('QUERY_INVALID', related.total ? '该办件中的产权证信息不唯一，请先在原系统核对' : '该产权证不属于当前办件，请先在原系统核对产权资料');
    const certificateType = housingText(related.rows[0].housecertificationid);
    if (!certificateType) throw housingFailure('办件产权证类型缺失，无法确认目标产权');
    const properties = await this.search('property', [{ name: 'delmark', value: '0', flag: 11 },
      { name: 'housecertificationid', value: certificateType, flag: 11 }, { name: 'housecertification', value: certificate, flag: 11 }], signal);
    if (properties.total !== 1 || properties.rows.length !== 1) throw new AppError('QUERY_INVALID', '产权资料未唯一匹配，请先在原系统核对');
    const property = properties.rows[0], areaId = housingArea(property.areaid);
    if (housingText(property.housecertification) !== certificate || housingText(property.housecertificationid) !== certificateType
      || housingText(property.delmark) !== '0' || !areaId.startsWith(prefix)) throw new AppError('QUERY_INVALID', '产权资料与办件或账号管理范围不一致');
    this.assertSession(revision);
    const target: HousingBindingTarget = Object.freeze({ acceptanceId, propertyId: housingIdentifier(property.id), certificateNumber: certificate, areaId, cardId: null });
    // The original CardPropertyNew -> ProprietaryModity route leaves cardid null; it must not be guessed from an owner ID.
    this.targets.set(target, revision); return target;
  }

  private assertTarget(target: HousingBindingTarget): void {
    this.assertSession(this.targets.get(target) ?? -1);
  }
  private assertHouse(target: HousingBindingTarget, house: HousingBindingHouse): void {
    this.assertTarget(target); const found = this.houses.get(house);
    if (!found || found.revision !== this.revision || found.propertyId !== target.propertyId) throw new AppError('QUERY_INVALID', '请重新查询待绑定房屋');
  }

  async findHouse(code: string, target: HousingBindingTarget, signal?: AbortSignal): Promise<HousingBindingHouse | null> {
    code = normalizeHousingCode(code);
    this.assertTarget(target); const prefix = housingAreaPrefix(target.areaId);
    const found = await this.search('viewcodehouse', [{ name: 'code', value: code, flag: 11 },
      { name: 'areaid', value: prefix.padEnd(18, '0'), flag: 16 }, { name: 'areaid', value: prefix.padEnd(18, '9'), flag: 17 },
      { name: 'delmark', value: '0', flag: 11 }, { name: 'isvalid', value: '1', flag: 11 }], signal);
    this.assertTarget(target);
    if (!found.total) return null;
    if (found.total !== 1 || found.rows.length !== 1) throw new AppError('QUERY_INVALID', '房屋编码未唯一匹配，请在原系统核对');
    const row = found.rows[0], areaId = housingArea(row.areaid);
    if (housingText(row.code) !== code || housingText(row.delmark) !== '0' || housingText(row.isvalid) !== '1' || !areaId.startsWith(prefix)) throw new AppError('QUERY_INVALID', '房屋编码、有效状态或管理区域与目标产权不一致');
    const house: HousingBindingHouse = Object.freeze({ id: housingIdentifier(row.id), code, buildingId: housingIdentifier(row.buildingid), address: housingText(row.houseaddress), areaId });
    this.houses.set(house, { revision: this.revision, propertyId: target.propertyId }); return house;
  }

  async isBound(target: HousingBindingTarget, house: HousingBindingHouse, signal?: AbortSignal): Promise<boolean> {
    this.assertHouse(target, house);
    const result = await this.search('propertyhouse', [{ name: 'propertyid', value: target.propertyId, flag: 11 },
      { name: 'houseid', value: house.id, flag: 11 }, { name: 'delmark', value: '0', flag: 11 }], signal);
    this.assertHouse(target, house);
    if (!result.total) return false;
    if (result.total !== 1 || result.rows.length !== 1) throw housingFailure('原系统存在重复的产权房屋关联，请人工核对');
    const row = result.rows[0];
    if (housingText(row.propertyid) !== target.propertyId || housingText(row.houseid) !== house.id || housingText(row.delmark) !== '0') throw housingFailure('原系统返回的产权房屋关联不匹配');
    return true;
  }

  async bindHouse(target: HousingBindingTarget, house: HousingBindingHouse, signal?: AbortSignal): Promise<void> {
    this.assertHouse(target, house);
    // Recheck the source identity before each write: a portal can change roles without rotating its SID.
    await this.validateSession(signal);
    this.assertHouse(target, house);
    const rows = [[{ beanname: 'propertyhouse', propertyid: target.propertyId, houseid: house.id, housecode: house.code,
      buildingid: house.buildingId, delmark: '0', cardid: target.cardId }]];
    const result = await this.rpc('insertOrupdatePropertyHouse', [JSON.stringify(rows)], '16', signal, true);
    // Source JS tests the returned value for truthiness; accept only an explicit positive scalar.
    if (result !== true && result !== 1) throw housingFailure('原系统未明确确认挂接结果，请回查关联后再处理');
  }
}
