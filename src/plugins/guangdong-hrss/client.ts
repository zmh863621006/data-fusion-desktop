import { session } from 'electron';
import { load } from 'cheerio';
import { AppError } from '../../core/errors/app-error';
import { HrssRequestGate, isHrssRequestTimeout } from './request-gate';
import { businessRequestUserAgent } from '../../core/network/user-agent';
import { HRSS_MATTER_DEFINITIONS, HRSS_ORIGIN, HRSS_PARTITION, type HrssListSource } from './catalog';
import { HRSS_HANDLING_RECORD_PATH } from './street';

export type HrssFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface HrssCredential { accessToken?: string; rawCookie?: string; trainingCookie?: string; observedAt?: number; /** Legacy snapshot metadata; never treated as a known server TTL. */ expiresAt?: number }
export interface HrssTrainingSession { organizationId: string; whereKey: string; csrfToken: string }
const TRAINING_PAGE='/ZXZJ/jycyzjgl/web/cypxbt/cxjd/cxjd.do';
export interface HrssClientOptions { fetcher?: HrssFetch; now?: () => number; minimumIntervalMs?: number; readTrainingCookie?:()=>Promise<string|undefined> }
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
    let total=typeof rawTotal==='number'?rawTotal:(typeof rawTotal==='string' && /^\d+$/.test(rawTotal)?Number(rawTotal):rawTotal===undefined&&Array.isArray(cursor[rowField])&&expectedTotal!==undefined?expectedTotal:NaN);
    // The unemployment page omits counting (total=0); its separate count endpoint is authoritative.
    // Keep a nonzero page/count disagreement visible so real concurrent changes still fail completeness checks.
    if(!countOnly && total===0 && expectedTotal!==undefined) total=expectedTotal;
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
  private trainingSession?: HrssTrainingSession;
  private readonly now: () => number;
  private readonly fetcher: HrssFetch;
  private readonly gate: HrssRequestGate;
  private readonly readTrainingCookie?:()=>Promise<string|undefined>;
  private readonly allowed = new Map([...HRSS_MATTER_DEFINITIONS.flatMap(m=>m.sources.flatMap(s=>[[s.path,s.method],...(s.countPath?[[s.countPath,'GET']]:[])] as [string,string][])),[HRSS_HANDLING_RECORD_PATH,'POST'] as [string,string]]);
  constructor(options: HrssClientOptions={}) {
    this.now=options.now??Date.now;
    this.readTrainingCookie=options.readTrainingCookie??(options.fetcher?undefined:async()=>{
      const cookies=await session.fromPartition(HRSS_PARTITION).cookies.get({url:new URL(TRAINING_PAGE,HRSS_ORIGIN).href});
      return cookies.some(cookie=>cookie.name==='hz_zxzj')?cookies.sort((a,b)=>(b.path?.length??0)-(a.path?.length??0)).map(cookie=>`${cookie.name}=${cookie.value}`).join('; '):undefined;
    });
    this.fetcher=options.fetcher??((url,init)=>{
      const browser=session.fromPartition(HRSS_PARTITION);
      const headers=new Headers(init.headers);
      // The source server returns HTTP 500 for Electron's Chinese application product name.
      headers.set('User-Agent',businessRequestUserAgent(browser.getUserAgent()));
      return browser.fetch(url,{...init,headers});
    });
    this.gate=new HrssRequestGate(options.minimumIntervalMs);
  }
  acceptBrowserAccessToken(value: string): void {
    if(validCredential(value) && value.trim()!==this.credential.accessToken) this.credential={...this.credential,accessToken:value.trim(),observedAt:this.now()};
  }
  acceptBrowserCookie(value: string): void {
    if(validCredential(value) && /^[^=;\s]+=/.test(value) && value.trim()!==this.credential.rawCookie) this.credential={...this.credential,rawCookie:value.trim(),observedAt:this.now()};
  }
  acceptTrainingCookie(value:string):void {
    if(validCredential(value) && /^[^=;\s]+=/.test(value) && value.trim()!==this.credential.trainingCookie) {
      this.credential={...this.credential,trainingCookie:value.trim(),observedAt:this.now()}; this.trainingSession=undefined;
    }
  }
  clearTrainingCookie():void {delete this.credential.trainingCookie;this.trainingSession=undefined;}
  clearAccessToken(): void { delete this.credential.accessToken; }
  clearCookie(): void { delete this.credential.rawCookie; }
  clearSession(): void { this.credential={}; this.trainingSession=undefined; }
  hasAccessToken(): boolean { return !!this.credential.accessToken; }
  hasCookie(): boolean { return !!this.credential.rawCookie; }
  hasSession(): boolean { return this.hasAccessToken()||this.hasCookie()||!!this.credential.trainingCookie; }
  // Original backend cached credentials for eight hours; that is not evidence of the server's token TTL.
  sessionExpiresAt(): undefined { return undefined; }
  exportSession(): Record<string,unknown>|null { return this.hasSession()?{...this.credential}:null; }
  restoreSession(value: Record<string,unknown>): void {
    const restored: HrssCredential={};
    if(validCredential(value.accessToken)) restored.accessToken=value.accessToken.trim();
    if(validCredential(value.rawCookie) && /^[^=;\s]+=/.test(value.rawCookie)) restored.rawCookie=value.rawCookie.trim();
    if(validCredential(value.trainingCookie) && /^[^=;\s]+=/.test(value.trainingCookie)) restored.trainingCookie=value.trainingCookie.trim();
    if(typeof value.observedAt==='number' && Number.isFinite(value.observedAt)) restored.observedAt=value.observedAt;
    // Main-process sessionRecovery.validate performs the real read-only server check after restore.
    this.credential=restored;
    this.trainingSession=undefined;
  }
  async requestHandlingRecords(params:Record<string,unknown>,signal?:AbortSignal):Promise<HrssListPage> {
    return this.request({id:'street-handling',path:HRSS_HANDLING_RECORD_PATH,method:'POST',identity:[]},params,signal);
  }
  async prepareTrainingSession(signal?:AbortSignal):Promise<HrssTrainingSession> {
    if(signal?.aborted)throw new AppError('TASK_CANCELLED','回流任务已取消');
    if(!this.credential.trainingCookie && this.readTrainingCookie){const value=await this.readTrainingCookie();if(value)this.acceptTrainingCookie(value);}
    if(!this.credential.trainingCookie) throw new AppError('SESSION_EXPIRED','请先在原站打开创业培训补贴查询页面，获取该业务独立会话');
    if(this.trainingSession) return this.trainingSession;
    return this.gate.execute(TRAINING_PAGE,async gateSignal=>{
      const response=await this.fetcher(new URL(TRAINING_PAGE,HRSS_ORIGIN).href,{method:'GET',headers:{Cookie:this.credential.trainingCookie!,Accept:'text/html'},redirect:'error',signal:gateSignal});
      if(!response.ok) throw failure(`创业培训查询页面读取失败（HTTP ${response.status}）`);
      const $=load(await response.text());
      const organizationId=$('form[name="editform"] input[name="BAE001"]').attr('value')??'';
      const scripts=$('script:not([src])').map((_index,node)=>$(node).text()).get().join('\n');
      const whereKey=/\bWHEREKEY\s*=\s*["']([^"'\r\n]+)["']/.exec(scripts)?.[1]??'';
      const header=/\bheadtoken\s*=\s*["']([^"'\r\n]+)["']/.exec(scripts)?.[1];
      const csrfToken=this.credential.trainingCookie!.split(';').map(pair=>pair.trim()).find(pair=>pair.startsWith('hz_zxzj='))?.slice(8)??'';
      if(!/^[A-Za-z0-9_-]{1,64}$/.test(organizationId) || !whereKey || whereKey.length>64 || header!=='hz_zxzj' || !validCredential(csrfToken)) {
        this.clearTrainingCookie(); throw new AppError('SESSION_EXPIRED','创业培训独立会话或查询页面不完整，请在原站重新打开该业务');
      }
      if(gateSignal.aborted) throw new AppError('TASK_CANCELLED','回流任务已取消');
      this.trainingSession={organizationId,whereKey,csrfToken};return this.trainingSession;
    },signal);
  }
  async requestTrainingList(params:Record<string,unknown>,signal?:AbortSignal):Promise<HrssListPage> {
    const training=await this.prepareTrainingSession(signal);
    const configs=new Set(['jycyzjgl_cypxbt_cxjd_bljdcxjglb','jycyzjgl_cypxbt_cxjd_bjywcxjglb','jycyzjgl_cypxbt_cxjd_jbjlgshwzjzhd']);
    if(!configs.has(String(params.confid))) throw new AppError('QUERY_INVALID','该查询不属于已登记的创业培训列表或办理记录');
    return this.gate.execute('/ZXZJ/gltPage.do',async gateSignal=>{
      const encoded=new URLSearchParams();for(const [key,value]of Object.entries(params))if(value!==undefined&&value!==null)encoded.set(key,String(value));
      const response=await this.fetcher(new URL('/ZXZJ/gltPage.do',HRSS_ORIGIN).href,{method:'POST',headers:{Accept:'application/json',Cookie:this.credential.trainingCookie!,'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8',hz_zxzj:training.csrfToken},body:encoded.toString(),redirect:'error',signal:gateSignal});
      if(response.status===401 || response.status===403) {this.clearTrainingCookie();throw new AppError('SESSION_EXPIRED','创业培训会话已失效，请在原站重新打开该业务');}
      if(!response.ok) throw failure(`创业培训列表请求失败（HTTP ${response.status}）`);
      // This legacy controller serves valid JSON as text/html. Validate the envelope before deciding it is a login page.
      let body:unknown;try{body=await response.json();}catch(error){
        if(gateSignal.aborted || isHrssRequestTimeout(error)) throw error;
        if(/text\/html/i.test(response.headers.get('content-type')??'')){this.clearTrainingCookie();throw new AppError('SESSION_EXPIRED','创业培训返回登录页面，请在原站重新打开该业务');}
        throw failure('创业培训未返回有效的列表数据');
      }
      if(gateSignal.aborted)throw new AppError('TASK_CANCELLED','回流任务已取消');
      if(object(body) && (body.FHZ==='CSRF'||body.FHZ==='-1')) {this.clearTrainingCookie();throw new AppError('SESSION_EXPIRED','创业培训会话校验失败，请在原站重新打开该业务');}
      if(object(body) && body.FHZ!==undefined && String(body.FHZ)!=='1')throw failure('创业培训未返回成功的列表结果');
      if(object(body) && validCredential(body.hz_zxzj)) training.csrfToken=body.hz_zxzj;
      return decodeHrssList(body,'rows');
    },signal);
  }
  async clearBrowserSession(): Promise<void> { this.clearSession(); await session.fromPartition(HRSS_PARTITION).clearStorageData(); }
  async request(source: HrssListSource,params: Record<string,unknown>,signal?:AbortSignal,countOnly=false,expectedTotal?:number): Promise<HrssListPage> {
    if(source.pagination==='training')throw new AppError('QUERY_INVALID','创业培训必须使用其独立会话查询');
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
    return this.gate.execute(path,async gateSignal=>{
      let response:Response;
      try { response=await this.fetcher(url.href,{...init,signal:gateSignal}); }
      catch(error) { if(gateSignal.aborted || isHrssRequestTimeout(error)) throw error; throw new AppError('REMOTE_REQUEST_FAILED','连接人社平台失败，请检查网络和原站登录状态'); }
      if(response.status===401 || response.status===403) {
        if(isWgbt) this.clearCookie(); else this.clearAccessToken();
        throw new AppError('SESSION_EXPIRED','人社平台会话已失效，请在原站重新登录');
      }
      if(!response.ok) throw new AppError('REMOTE_REQUEST_FAILED',`人社列表请求失败（HTTP ${response.status}）`);
      if(/text\/html/i.test(response.headers.get('content-type')??'')) {if(isWgbt) this.clearCookie();else this.clearAccessToken();throw new AppError('SESSION_EXPIRED','人社平台返回登录页面，请在原站重新登录');}
      let body:unknown;
      try { body=await response.json(); } catch(error) { if(gateSignal.aborted || isHrssRequestTimeout(error)) throw error; throw failure('人社平台未返回有效的列表数据'); }
      if(gateSignal.aborted) throw new AppError('TASK_CANCELLED','回流任务已取消');
      try { return decodeHrssList(body,isWgbt?'rows':'records',countOnly,source.countPath?expectedTotal:undefined); }
      catch(error) { if(error instanceof AppError && error.code==='SESSION_EXPIRED') { if(isWgbt) this.clearCookie(); else this.clearAccessToken(); } throw error; }
    },signal);
  }
  async validateSession(signal:AbortSignal):Promise<{displayName:string}> {
    if(!this.hasAccessToken()) throw new AppError('SESSION_EXPIRED','请在原站登录人社就业业务后重试');
    const source=HRSS_MATTER_DEFINITIONS.find(m=>m.id==='unemployment')!.sources[0];
    const today=new Date(this.now()+8*60*60_000).toISOString().slice(0,10);
    // Read-only legacy count checks this session without reading people or dashboard statistics.
    await this.request(source,{bce089Start:today,bce089End:today,aac004:'1',bae085:'01',bae001:'163374',bbd068:'01'},signal,true);
    return {displayName:'广东人社门户会话'};
  }
}
