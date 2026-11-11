import { describe,expect,it,vi } from 'vitest';
vi.mock('electron',()=>({session:{fromPartition:vi.fn()}}));
import { HrssClient,decodeHrssList } from './client';
import { HRSS_MATTER_BY_ID } from './catalog';
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
  it('uses an independently read list count only for a list envelope without its own total',()=>{
    expect(decodeHrssList({data:{records:[{bce076:'A'}]}},'records',false,1)).toEqual({rows:[{bce076:'A'}],total:1});
    expect(decodeHrssList({data:{total:2,records:[{bce076:'A'}]}},'records',false,1).total).toBe(2);
    expect(()=>decodeHrssList({data:{total:'invalid',records:[]}},'records',false,1)).toThrow('结构不完整');
    expect(()=>decodeHrssList({data:{records:[]}},'records')).toThrow('结构不完整');
  });
});

describe('人社访问凭据与接口边界',()=>{
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
