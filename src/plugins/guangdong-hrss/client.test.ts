import { afterEach,describe,expect,it,vi } from 'vitest';
vi.mock('electron',()=>({session:{fromPartition:vi.fn()}}));
import { session } from 'electron';
import { HrssClient,decodeHrssList } from './client';
import { HRSS_MATTER_BY_ID } from './catalog';
import { isExhaustedHrssTimeout } from './request-gate';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
const now=()=>1_800_000_000_000;
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const source=HRSS_MATTER_BY_ID.get('job-seeking-startup-subsidy')!.sources[0];
const wgbt=HRSS_MATTER_BY_ID.get('one-time-job-expansion-subsidy')!.sources[0];

describe('人社列表响应',()=>{
  it('accepts native and original Java-wrapped envelopes while rejecting fake empty successes',()=>{
    expect(decodeHrssList({code:200,data:{total:'0',records:[]}},'records')).toEqual({total:0,rows:[]});
    expect(decodeHrssList({data:{code:0,data:{total:1,records:[{bce097:'A'}]}}},'records').rows).toHaveLength(1);
    expect(decodeHrssList({total:1,rows:[{CCD002:'A'}]},'rows').rows).toHaveLength(1);
    expect(()=>decodeHrssList({code:200,data:{}},'records')).toThrow('结构不完整');
    expect(()=>decodeHrssList({success:false,data:{total:0,records:[]}},'records')).toThrow('成功的列表');
    expect(()=>decodeHrssList({code:401,data:{total:0,records:[]}},'records')).toThrow('会话已失效');
    expect(()=>decodeHrssList({data:{total:1,records:[null]}},'records')).toThrow('无法识别');
  });
  it('uses the independent count for a missing or zero count while preserving a nonzero mismatch',()=>{
    expect(decodeHrssList({data:{records:[{bce076:'A'}]}},'records',false,1)).toEqual({rows:[{bce076:'A'}],total:1});
    expect(decodeHrssList({data:{total:2,records:[{bce076:'A'}]}},'records',false,1).total).toBe(2);
    expect(decodeHrssList({data:{total:0,records:[{bce076:'A'}]}},'records',false,129)).toEqual({rows:[{bce076:'A'}],total:129});
    expect(decodeHrssList({data:{total:0,records:[{bce076:'A'}]}},'records').total).toBe(0);
    expect(()=>decodeHrssList({data:{total:'invalid',records:[]}},'records',false,1)).toThrow('结构不完整');
    expect(()=>decodeHrssList({data:{records:[]}},'records')).toThrow('结构不完整');
  });
});

describe('人社统一节流与超时重试',()=>{
  const trainingPage='/ZXZJ/jycyzjgl/web/cypxbt/cxjd/cxjd.do';
  const trainingConfig={confid:'jycyzjgl_cypxbt_cxjd_bljdcxjglb',whereCls:'fixture-encrypted',rowstart:1,pageSize:200};
  const html=`<form name="editform"><input name="BAE001" value="163374"></form><script>var WHEREKEY='fixture';var headtoken='hz_zxzj';</script>`;
  const unemployment=HRSS_MATTER_BY_ID.get('unemployment')!.sources[0];
  const response=(path:string)=>path===trainingPage?new Response(html,{headers:{'content-type':'text/html'}}):path==='/ZXZJ/gltPage.do'?json({FHZ:'1',total:0,rows:[]}):path.includes('/WGBT/')?json({total:0,rows:[]}):json({data:{total:0,records:[]}});
  const authenticate=(client:HrssClient)=>{client.acceptBrowserAccessToken('fixture-access');client.acceptBrowserCookie('WGBT_SESSION=fixture');client.acceptTrainingCookie('ZXZJ_SESSION=fixture; hz_zxzj=training-csrf');};

  it('serializes all network routes without imposing a fixed default delay',async()=>{
    vi.useFakeTimers();vi.setSystemTime(0);
    const starts:Array<{path:string;at:number}>=[];
    let active=0,maxActive=0,finishTraining!:()=>void;
    const fetcher=vi.fn(async(url:string)=>{
      const path=new URL(url).pathname;starts.push({path,at:Date.now()});maxActive=Math.max(maxActive,++active);
      try{if(path===trainingPage)await new Promise<void>(resolve=>{finishTraining=resolve;});return response(path);}finally{active--;}
    });
    const client=new HrssClient({fetcher});authenticate(client);
    const trainingReady=client.prepareTrainingSession();
    const pending=[trainingReady,client.request(unemployment,{},undefined,true),client.request(source,{}),client.requestHandlingRecords({bzd417:'fixture'}),client.request(wgbt,{})];
    const trainingList=trainingReady.then(()=>client.requestTrainingList(trainingConfig));
    await vi.advanceTimersByTimeAsync(0);expect(starts.map(row=>row.path)).toEqual([trainingPage]);
    finishTraining();await Promise.all([...pending,trainingList]);
    expect(starts.map(row=>row.path)).toEqual([trainingPage,unemployment.countPath,source.path,'/subsidize/main/rest/subsidy/common/operate-log',wgbt.path,'/ZXZJ/gltPage.do']);
    expect(starts.map(row=>row.at)).toEqual([0,0,0,0,0,0]);expect(maxActive).toBe(1);expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['count','list','handling','training-page','training-list','wgbt'])('retries transport timeouts through the shared gate for %s',async(kind)=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
    const target=kind==='count'?unemployment.countPath!:kind==='list'?source.path:kind==='handling'?'/subsidize/main/rest/subsidy/common/operate-log':kind==='training-page'?trainingPage:kind==='training-list'?'/ZXZJ/gltPage.do':wgbt.path;
    let attempts=0;
    const fetcher=vi.fn(async(url:string)=>{const path=new URL(url).pathname;if(path===target&&++attempts<3)throw new Error('fetch failed',{cause:Object.assign(new Error('transport timeout'),{code:'ETIMEDOUT'})});return response(path);});
    const client=new HrssClient({fetcher,minimumIntervalMs:0});authenticate(client);
    if(kind==='count')await client.request(unemployment,{bce089Start:'2026-11-02'},undefined,true);
    else if(kind==='list')await client.request(source,{});
    else if(kind==='handling')await client.requestHandlingRecords({bzd417:'fixture'});
    else if(kind==='training-page')await client.prepareTrainingSession();
    else if(kind==='training-list')await client.requestTrainingList(trainingConfig);
    else await client.request(wgbt,{});
    expect(attempts).toBe(3);expect(warn).toHaveBeenCalledTimes(2);
    expect(client.hasAccessToken()).toBe(true);
    expect(warn.mock.calls.every(call=>(call[1] as {path:string}).path===target)).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture');
  });

  it.each([false,true])('preserves a response-body timeout instead of treating it as malformed JSON or a training login (training=%s)',async(training)=>{
    vi.spyOn(console,'warn').mockImplementation(()=>undefined);
    let attempts=0;
    const fetcher=vi.fn(async(url:string)=>{
      const path=new URL(url).pathname;if(path===trainingPage)return response(path);
      const result=response(path);
      if(++attempts<3)result.json=async()=>{throw new DOMException('Body timed out','TimeoutError');};
      return result;
    });
    const client=new HrssClient({fetcher,minimumIntervalMs:0});authenticate(client);
    if(training)await client.requestTrainingList(trainingConfig);else await client.request(source,{});
    expect(attempts).toBe(3);expect(client.exportSession()?.trainingCookie).toContain('hz_zxzj=training-csrf');
  });

  it('exposes only an exhausted timeout marker after five attempts without clearing the login',async()=>{
    vi.spyOn(console,'warn').mockImplementation(()=>undefined);
    const fetcher=vi.fn(async()=>{throw new Error('net::ERR_TIMED_OUT');});
    const client=new HrssClient({fetcher,minimumIntervalMs:0});authenticate(client);
    const error=await client.request(source,{}).catch(error=>error);
    expect(isExhaustedHrssTimeout(error)).toBe(true);expect(fetcher).toHaveBeenCalledTimes(5);expect(client.hasAccessToken()).toBe(true);
  });

  it.each([408,504])('treats HTTP %s as a timeout for ordinary requests and both training routes, with recovery and a five-attempt cap',async(status)=>{
    vi.spyOn(console,'warn').mockImplementation(()=>undefined);
    for(const kind of ['ordinary','training-page','training-list']){
      const target=kind==='ordinary'?source.path:kind==='training-page'?trainingPage:'/ZXZJ/gltPage.do';
      const invoke=(client:HrssClient)=>kind==='ordinary'?client.request(source,{}):kind==='training-page'?client.prepareTrainingSession():client.requestTrainingList(trainingConfig);
      for(const exhausted of [false,true]){
        let attempts=0;
        const fetcher=vi.fn(async(url:string)=>{
          const path=new URL(url).pathname;
          if(path===target){attempts++;if(exhausted||attempts===1)return json({},status);}
          return response(path);
        });
        const client=new HrssClient({fetcher});authenticate(client);
        if(exhausted)expect(isExhaustedHrssTimeout(await invoke(client).catch(error=>error))).toBe(true);
        else await invoke(client);
        expect(attempts).toBe(exhausted?5:2);
        expect(client.hasAccessToken()).toBe(true);expect(client.exportSession()?.trainingCookie).toContain('hz_zxzj=training-csrf');
      }
    }
  });

  it('keeps the sixty-second network abort distinct from a user cancellation',async()=>{
    vi.useFakeTimers();vi.spyOn(console,'warn').mockImplementation(()=>undefined);
    const fetcher=vi.fn(async(_url:string,init:RequestInit)=>new Promise<Response>((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})));
    const client=new HrssClient({fetcher,minimumIntervalMs:0});authenticate(client);
    const result=client.request(source,{}).catch(error=>error);
    await vi.advanceTimersByTimeAsync(300000);
    expect(isExhaustedHrssTimeout(await result)).toBe(true);expect(fetcher).toHaveBeenCalledTimes(5);expect(client.hasAccessToken()).toBe(true);
  });

  it.each([401,500,'json'])('does not retry an HTTP/session/JSON failure as a timeout: %s',async(failure)=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
    const fetcher=vi.fn(async()=>typeof failure==='number'?json({},failure):new Response('{invalid',{headers:{'content-type':'application/json'}}));
    const client=new HrssClient({fetcher,minimumIntervalMs:0});authenticate(client);
    await expect(client.request(source,{})).rejects.toMatchObject({code:failure===401?'SESSION_EXPIRED':'REMOTE_REQUEST_FAILED'});
    expect(fetcher).toHaveBeenCalledTimes(1);expect(warn).not.toHaveBeenCalled();
  });
});

describe('人社访问凭据与接口边界',()=>{
  it('does not refresh observation time when the source repeats the same credential',()=>{
    let time=100;const client=new HrssClient({now:()=>time});
    client.acceptBrowserAccessToken('fixture-access');const saved=client.exportSession();
    time=200;client.acceptBrowserAccessToken('fixture-access');expect(client.exportSession()).toEqual(saved);
    client.acceptBrowserAccessToken('fixture-new-access');expect(client.exportSession()?.observedAt).toBe(200);
  });
  it('requests only the registered street handling list with its source association id',async()=>{
    const fetcher=vi.fn(async(_url:string,_init:RequestInit)=>json({data:{records:[],total:0}}));
    const client=new HrssClient({fetcher,minimumIntervalMs:0});client.acceptBrowserAccessToken('fixture-access');
    await client.requestHandlingRecords({bzd417:'fixture-case',aaa025:'02',current:1,size:200});
    expect(new URL(fetcher.mock.calls[0][0]).pathname).toBe('/subsidize/main/rest/subsidy/common/operate-log');
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toEqual({bzd417:'fixture-case',aaa025:'02',current:1,size:200});
  });
  it('keeps the legacy training cookie independent and uses only its three approved list configurations',async()=>{
    const html=`<form name="editform"><input name="BAE001" value="163374"></form><script>var WHEREKEY='fixture';var headtoken='hz_zxzj';</script>`;
    const fetcher=vi.fn(async(url:string,_init:RequestInit)=>url.endsWith('cxjd.do')?new Response(html,{headers:{'content-type':'text/html'}}):new Response(JSON.stringify({FHZ:'1',rows:[],total:0,hz_zxzj:'rotated'}),{headers:{'content-type':'text/html; charset=UTF-8'}}));
    const client=new HrssClient({fetcher,minimumIntervalMs:0});
    client.acceptBrowserCookie('WGBT_SESSION=fixture');
    await expect(client.prepareTrainingSession()).rejects.toThrow('独立会话');expect(fetcher).not.toHaveBeenCalled();
    client.acceptTrainingCookie('ZXZJ_SESSION=fixture; hz_zxzj=training-csrf');
    expect(await client.prepareTrainingSession()).toEqual({organizationId:'163374',whereKey:'fixture',csrfToken:'training-csrf'});
    await client.requestTrainingList({confid:'jycyzjgl_cypxbt_cxjd_bljdcxjglb',whereCls:'encrypted',rowstart:1,pageSize:200});
    const headers=fetcher.mock.calls[1][1].headers as Record<string,string>;
    expect(headers.hz_zxzj).toBe('training-csrf');expect(headers.Cookie).not.toContain('WGBT');expect(headers).not.toHaveProperty('Access-Token');
    expect(await client.prepareTrainingSession()).toMatchObject({csrfToken:'rotated'});
    await expect(client.requestTrainingList({confid:'arbitrary-detail'})).rejects.toMatchObject({code:'QUERY_INVALID'});
    expect(fetcher).toHaveBeenCalledTimes(2);
    const restored=new HrssClient({fetcher,minimumIntervalMs:0});restored.restoreSession(client.exportSession()!);expect(restored.hasSession()).toBe(true);
  });
  it('rejects a training login page and a CSRF failure instead of returning an empty success',async()=>{
    const client=new HrssClient({fetcher:async()=>new Response('<title>登录</title>',{headers:{'content-type':'text/html'}}),minimumIntervalMs:0});
    client.acceptTrainingCookie('ZXZJ_SESSION=fixture; hz_zxzj=csrf');
    await expect(client.prepareTrainingSession()).rejects.toMatchObject({code:'SESSION_EXPIRED'});
    expect(client.exportSession()).toBeNull();
    const fetcher=vi.fn(async(url:string)=>url.endsWith('cxjd.do')?new Response(`<form name="editform"><input name="BAE001" value="163374"></form><script>WHEREKEY='fixture';headtoken='hz_zxzj';</script>`):json({FHZ:'CSRF',rows:[],total:0}));
    const rejected=new HrssClient({fetcher,minimumIntervalMs:0});rejected.acceptTrainingCookie('ZXZJ_SESSION=fixture; hz_zxzj=csrf');
    await expect(rejected.requestTrainingList({confid:'jycyzjgl_cypxbt_cxjd_bljdcxjglb'})).rejects.toMatchObject({code:'SESSION_EXPIRED'});
    expect(rejected.hasSession()).toBe(false);
  });
  it('verifies a real-shaped portal session when the native server rejects a Chinese User-Agent',async()=>{
    const agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) 数据融合助手/1.1.11 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36';
    const nativeFetch=vi.fn(async(_url:string,init:RequestInit)=>{
      const headers=new Headers(init.headers);
      if(headers.get('user-agent')?.includes('数据融合助手'))return new Response(null,{status:500});
      expect(headers.get('user-agent')).toBe(agent.replace('数据融合助手/','DataFusion/'));
      expect(headers.get('access-token')).toBe('fixture-valid-browser-session');
      return json({appcode:'200',success:true,data:{total:0}});
    });
    vi.mocked(session.fromPartition).mockReturnValue({getUserAgent:()=>agent,fetch:nativeFetch} as unknown as ReturnType<typeof session.fromPartition>);
    const client=new HrssClient({now,minimumIntervalMs:0});client.acceptBrowserAccessToken('fixture-valid-browser-session');
    await expect(client.validateSession(AbortSignal.timeout(1000))).resolves.toEqual({displayName:'广东人社门户会话'});
    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(new URL(nativeFetch.mock.calls[0][0]).pathname).toBe('/employment/main/rest/e/v1/jygl/jysyxxcx/syxx/page/cnt');
    expect(client.hasAccessToken()).toBe(true);
  });
  it('sends access credentials to normal lists and WGBT cookies only to WGBT',async()=>{
    const fetcher=vi.fn(async(url:string,_init:RequestInit)=>json(url.includes('/WGBT/')?{total:0,rows:[]}:{data:{total:0,records:[]}}));
    const client=new HrssClient({fetcher,now,minimumIntervalMs:0});client.acceptBrowserAccessToken('test-access');
    await expect(client.request(wgbt,{rowstart:1})).rejects.toThrow('独立会话');
    expect(fetcher).not.toHaveBeenCalled();
    client.acceptBrowserCookie('WGBT_SESSION=test-cookie');
    await client.request(source,{current:1,size:200});await client.request(wgbt,{rowstart:1,pageSize:200});
    expect(fetcher.mock.calls[0][1].headers).toEqual({Accept:'application/json','Access-Token':'test-access'});
    expect(fetcher.mock.calls[1][1].headers).toEqual({Accept:'application/json',Cookie:'WGBT_SESSION=test-cookie','Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'});
    expect(fetcher.mock.calls[1][1].body).toBe('rowstart=1&pageSize=200');
  });
  it('sends POST list parameters as JSON without touching a detail or external URL',async()=>{
    const fetcher=vi.fn(async(_url:string,_init:RequestInit)=>json({data:{total:0,records:[]}}));const client=new HrssClient({fetcher,now,minimumIntervalMs:0});client.acceptBrowserAccessToken('test-access');
    const tracking=HRSS_MATTER_BY_ID.get('graduate-tracking-service')!.sources[0];
    await client.request(tracking,{bdca42:'101',bae003:[null,null]});
    expect(fetcher.mock.calls[0][1].method).toBe('POST');expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toEqual({bdca42:'101',bae003:[null,null]});
    await expect(client.request({...source,path:'https://example.invalid/steal'},{})).rejects.toMatchObject({code:'QUERY_INVALID'});
    await expect(client.request({...source,path:'/employment/business-tracking/rest/v1/servicetrack/service/track/status/input/queryPerson'},{})).rejects.toMatchObject({code:'QUERY_INVALID'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('clears the failed credential family, ignores line injection and does not invent a server TTL',async()=>{
    const client=new HrssClient({fetcher:vi.fn(async()=>json({},401)),now,minimumIntervalMs:0});
    client.acceptBrowserAccessToken('bad\r\nInjected: data');expect(client.hasSession()).toBe(false);
    client.acceptBrowserAccessToken('test-access');client.acceptBrowserCookie('WGBT_SESSION=test-cookie');
    await expect(client.request(source,{})).rejects.toMatchObject({code:'SESSION_EXPIRED'});
    expect(client.hasAccessToken()).toBe(false);expect(client.hasCookie()).toBe(true);
    const saved=client.exportSession()!;const restored=new HrssClient({now});restored.restoreSession(saved);expect(restored.hasCookie()).toBe(true);
    const later=new HrssClient({now:()=>now()+9*60*60_000});later.restoreSession(saved);expect(later.hasCookie()).toBe(true);expect(later.sessionExpiresAt()).toBeUndefined();
  });
  it('passes cancellation to fetch and preserves a business-envelope session failure',async()=>{
    const controller=new AbortController();const fetcher=vi.fn(async(_url:string,init:RequestInit)=>{expect(init.signal).toBeInstanceOf(AbortSignal);return json({code:403});});
    const client=new HrssClient({fetcher,now,minimumIntervalMs:0});client.acceptBrowserAccessToken('test-access');
    await expect(client.request(source,{},controller.signal)).rejects.toMatchObject({code:'SESSION_EXPIRED'});expect(client.hasAccessToken()).toBe(false);expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
