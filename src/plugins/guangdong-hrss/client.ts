import { session } from 'electron';
import { AppError } from '../../core/errors/app-error';
import { RequestGate } from '../../core/network/request-policy';
import { businessRequestUserAgent } from '../../core/network/user-agent';
import { HRSS_MATTER_DEFINITIONS, HRSS_ORIGIN, HRSS_PARTITION, type HrssListSource } from './catalog';

export type HrssFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface HrssCredential { accessToken?: string; rawCookie?: string; observedAt?: number; /** Legacy snapshot metadata; never treated as a known server TTL. */ expiresAt?: number }
export interface HrssClientOptions { fetcher?: HrssFetch; now?: () => number; minimumIntervalMs?: number }
export interface HrssListPage { rows: Record<string, unknown>[]; total: number }
const validCredential = (value: unknown): value is string => typeof value==='string' && value.trim().length>0 && value.length<=65_536 && !/[\r\n]/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value==='object' && !Array.isArray(value);
const failure = (message: string) => new AppError('REMOTE_REQUEST_FAILED', message, {retryable:false});

/** Only documented list envelopes are accepted. Java's outer HttpParameterEntity wrapper is optional. */
export function decodeHrssList(value: unknown, rowField: 'records'|'rows', countOnly=false,expectedTotal?:number): HrssListPage {
  let cursor=value;
  for(let depth=0;depth<4;depth++) {
    if(!object(cursor)) break;
    const code=cursor.code;
    if(code===401 || code===403 || code==='401' || code==='403') throw new AppError('SESSION_EXPIRED','人社平台会话已失效，请在原站重新登录');
    if(cursor.success===false || cursor.error || (code!==undefined && !/^(?:0+|200|SUCCESS)$/i.test(String(code)))) throw failure('人社平台未返回成功的列表结果');
    const rawTotal=cursor.total;
    const total=typeof rawTotal==='number'?rawTotal:(typeof rawTotal==='string' && /^\d+$/.test(rawTotal)?Number(rawTotal):rawTotal===undefined&&Array.isArray(cursor[rowField])&&expectedTotal!==undefined?expectedTotal:NaN);
    if(Number.isSafeInteger(total) && total>=0 && (countOnly || Array.isArray(cursor[rowField]))) {
      const rows=countOnly?[]:cursor[rowField] as unknown[];
      if(rows.some(row=>!object(row))) throw failure('人社平台列表包含无法识别的记录');
      return {rows:rows as Record<string,unknown>[],total};
    }
    cursor=cursor.data;
  }
  throw failure('人社平台列表结构不完整，未保存本次结果');
}

/** Credentials remain in the main-process instance; snapshots are consumed only by encrypted session recovery. */
export class HrssClient {
  private credential: HrssCredential = {};
  private readonly now: () => number;
  private readonly fetcher: HrssFetch;
  private readonly gate: RequestGate;
  private readonly allowed = new Map(HRSS_MATTER_DEFINITIONS.flatMap(m=>m.sources.flatMap(s=>[[s.path,s.method],...(s.countPath?[[s.countPath,'GET']]:[])] as [string,string][])));
  constructor(options: HrssClientOptions={}) {
    this.now=options.now??Date.now;
    this.fetcher=options.fetcher??((url,init)=>{
      const browser=session.fromPartition(HRSS_PARTITION);
      const headers=new Headers(init.headers);
      // The source server returns HTTP 500 for Electron's Chinese application product name.
      headers.set('User-Agent',businessRequestUserAgent(browser.getUserAgent()));
      return browser.fetch(url,{...init,headers});
    });
    this.gate=new RequestGate({timeoutMs:60_000,maxAttempts:2,retryDelayMs:500,minimumIntervalMs:options.minimumIntervalMs??200});
  }
  acceptBrowserAccessToken(value: string): void {
    if(validCredential(value)) this.credential={...this.credential,accessToken:value.trim(),observedAt:this.now()};
  }
  acceptBrowserCookie(value: string): void {
    if(validCredential(value) && /^[^=;\s]+=/.test(value)) this.credential={...this.credential,rawCookie:value.trim(),observedAt:this.now()};
  }
  clearAccessToken(): void { delete this.credential.accessToken; }
  clearCookie(): void { delete this.credential.rawCookie; }
  clearSession(): void { this.credential={}; }
  hasAccessToken(): boolean { return !!this.credential.accessToken; }
  hasCookie(): boolean { return !!this.credential.rawCookie; }
  hasSession(): boolean { return this.hasAccessToken()||this.hasCookie(); }
  // Original backend cached credentials for eight hours; that is not evidence of the server's token TTL.
  sessionExpiresAt(): undefined { return undefined; }
  exportSession(): Record<string,unknown>|null { return this.hasSession()?{...this.credential}:null; }
  restoreSession(value: Record<string,unknown>): void {
    const restored: HrssCredential={};
    if(validCredential(value.accessToken)) restored.accessToken=value.accessToken.trim();
    if(validCredential(value.rawCookie) && /^[^=;\s]+=/.test(value.rawCookie)) restored.rawCookie=value.rawCookie.trim();
    if(typeof value.observedAt==='number' && Number.isFinite(value.observedAt)) restored.observedAt=value.observedAt;
    // Main-process sessionRecovery.validate performs the real read-only server check after restore.
    this.credential=restored;
  }
  async clearBrowserSession(): Promise<void> { this.clearSession(); await session.fromPartition(HRSS_PARTITION).clearStorageData(); }
  async request(source: HrssListSource,params: Record<string,unknown>,signal?:AbortSignal,countOnly=false,expectedTotal?:number): Promise<HrssListPage> {
    const path=countOnly?source.countPath:source.path;
    const method=countOnly?'GET':source.method;
    if(!path || this.allowed.get(path)!==method) throw new AppError('QUERY_INVALID','该接口不属于已登记的人社列表接口');
    const isWgbt=source.pagination==='wgbt';
    if(isWgbt?!this.hasCookie():!this.hasAccessToken()) throw new AppError('SESSION_EXPIRED',isWgbt?'请先在原站打开一次性扩岗业务，获取该业务独立会话':'请先在原站完成人社登录并打开就业业务');
    const headers: Record<string,string>={Accept:'application/json'};
    if(isWgbt) headers.Cookie=this.credential.rawCookie!;
    else headers['Access-Token']=this.credential.accessToken!;
    const url=new URL(path,HRSS_ORIGIN);
    if(url.origin!==HRSS_ORIGIN) throw new AppError('QUERY_INVALID','人社接口地址无效');
    const init: RequestInit={method,headers,redirect:'error'};
    const encoded=new URLSearchParams();
    for(const [key,value] of Object.entries(params)) if(value!==undefined && value!==null) encoded.set(key,Array.isArray(value)?JSON.stringify(value):String(value));
    if(method==='GET') url.search=encoded.toString();
    else if(isWgbt) { headers['Content-Type']='application/x-www-form-urlencoded;charset=UTF-8'; init.body=encoded.toString(); }
    else { headers['Content-Type']='application/json'; init.body=JSON.stringify(params); }
    return this.gate.execute(async gateSignal=>{
      let response:Response;
      try { response=await this.fetcher(url.href,{...init,signal:gateSignal}); }
      catch(error) { if(gateSignal.aborted) throw error; throw new AppError('REMOTE_REQUEST_FAILED','连接人社平台失败，请检查网络和原站登录状态'); }
      if(response.status===401 || response.status===403) {
        if(isWgbt) this.clearCookie(); else this.clearAccessToken();
        throw new AppError('SESSION_EXPIRED','人社平台会话已失效，请在原站重新登录');
      }
      if(!response.ok) throw new AppError('REMOTE_REQUEST_FAILED',`人社列表请求失败（HTTP ${response.status}）`);
      if(/text\/html/i.test(response.headers.get('content-type')??'')) {if(isWgbt) this.clearCookie();else this.clearAccessToken();throw new AppError('SESSION_EXPIRED','人社平台返回登录页面，请在原站重新登录');}
      let body:unknown;
      try { body=await response.json(); } catch { throw failure('人社平台未返回有效的列表数据'); }
      if(gateSignal.aborted) throw new AppError('TASK_CANCELLED','回流任务已取消');
      try { return decodeHrssList(body,isWgbt?'rows':'records',countOnly,source.countPath?expectedTotal:undefined); }
      catch(error) { if(error instanceof AppError && error.code==='SESSION_EXPIRED') { if(isWgbt) this.clearCookie(); else this.clearAccessToken(); } throw error; }
    },signal);
  }
  async validateSession(signal:AbortSignal):Promise<{displayName:string}> {
    if(!this.hasAccessToken()) throw new AppError('SESSION_EXPIRED','请在原站登录人社就业业务后重试');
    const source=HRSS_MATTER_DEFINITIONS.find(m=>m.id==='unemployment')!.sources[0];
    const today=new Date(this.now()+8*60*60_000).toISOString().slice(0,10);
    // Read-only session validation from original RSRZServiceImpl, never a dashboard statistics request.
    await this.request(source,{bce089Start:today,bce089End:today,aac004:'1',bae085:'01',bae001:'163374',bbd068:'01'},signal,true);
    return {displayName:'广东人社门户会话'};
  }
}
