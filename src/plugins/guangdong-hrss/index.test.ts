import { describe,expect,it,vi } from 'vitest';
vi.mock('electron',()=>({session:{fromPartition:vi.fn()}}));
vi.mock('../../main/browser-auth',()=>({observeBrowserAuthMany:vi.fn()}));
import { observeBrowserAuthMany } from '../../main/browser-auth';
import { validatePluginContract } from '../../core/plugins/types';
import { createGuangdongHrssPlugin,HRSS_MATTER_DEFINITIONS } from './index';
import { validateFilters } from '../../core/query/validation';
import { session } from 'electron';

it('opens the SSO entry for login and restores the full portal instead of a single business page',()=>{
  const plugin=createGuangdongHrssPlugin();
  expect(plugin.loginPage?.url).toBe('https://hrss.gdgov.cn/sso/login.html');
  expect(plugin.loginPage?.allowedOrigin).toBe('https://hrss.gdgov.cn');
  expect(plugin.sessionRecovery?.homeUrl()).toBe('https://hrss.gdgov.cn/portal/template/system.html');
});

describe('人社登录验证及浏览器凭据代次',()=>{
  const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

  it('does not mark an unverified token or an independent cookie as authenticated',async()=>{
    const fetcher=vi.fn(async()=>response({}));const plugin=createGuangdongHrssPlugin({fetcher,minimumIntervalMs:0});
    await plugin.sessionRecovery!.restore({accessToken:'fixture-unverified'});
    expect((await plugin.getSessionState()).status).toBe('unverified');expect((await plugin.auth.getState()).status).toBe('unverified');
    await plugin.sessionRecovery!.restore({rawCookie:'WGBT_SESSION=fixture'});const saved=await plugin.sessionRecovery!.snapshot();
    expect((await plugin.getSessionState()).status).toBe('unverified');
    await expect(plugin.sessionRecovery!.validate(new AbortController().signal)).rejects.toMatchObject({code:'SYSTEM_LOGIN_REQUIRED',details:{reason:'HRSS_EMPLOYMENT_NOT_READY'}});
    expect(await plugin.sessionRecovery!.snapshot()).toEqual(saved);
    expect(plugin.sessionRecovery?.apiCredentials).toBeUndefined();
  });

  it('requires an actual successful probe before returning authenticated',async()=>{
    const fetcher=vi.fn(async(_url:string,_init:RequestInit)=>response({data:{total:0}}));const plugin=createGuangdongHrssPlugin({fetcher,minimumIntervalMs:0});
    expect((await plugin.getSessionState()).status).toBe('logged-out');expect(fetcher).not.toHaveBeenCalled();
    await plugin.sessionRecovery!.restore({accessToken:'fixture-access'});expect((await plugin.getSessionState()).status).toBe('authenticated');expect(fetcher).toHaveBeenCalledOnce();
    expect(new URL(fetcher.mock.calls[0]?.[0] as string).pathname).toContain('/employment/main/rest/');
  });

  it('uses a successful navigation to the known SSO login route to clear credentials and stop stale observation',async()=>{
    const plugin=createGuangdongHrssPlugin();await plugin.initialize();await plugin.sessionRecovery!.restore({accessToken:'fixture-access',rawCookie:'WGBT_SESSION=fixture'});
    const rules=vi.mocked(observeBrowserAuthMany).mock.calls.at(-1)![1];
    expect(rules.every(rule=>typeof rule.credentialGeneration==='function')).toBe(true);
    plugin.loginPage!.onLoginPageChange!(true);expect(await plugin.sessionRecovery!.snapshot()).toBeNull();expect(rules.every(rule=>rule.credentialGeneration?.()===null)).toBe(true);
    rules[0].accept('fixture-late-token');expect(await plugin.sessionRecovery!.snapshot()).toBeNull();
    plugin.loginPage!.onLoginPageChange!(false);rules[0].accept('fixture-new-token');expect(await plugin.sessionRecovery!.snapshot()).toMatchObject({accessToken:'fixture-new-token'});
  });

  it('drops late browser 401 and successful observations after a new token is captured',async()=>{
    const plugin=createGuangdongHrssPlugin();await plugin.initialize();
    const rules=vi.mocked(observeBrowserAuthMany).mock.calls.at(-1)![1];
    const hooks={onBeforeSendHeaders:vi.fn(),onCompleted:vi.fn(),onBeforeRedirect:vi.fn(),onErrorOccurred:vi.fn()};
    vi.mocked(session.fromPartition).mockReturnValue({webRequest:hooks} as unknown as ReturnType<typeof session.fromPartition>);
    const actual=await vi.importActual<typeof import('../../main/browser-auth')>('../../main/browser-auth');actual.observeBrowserAuthMany('persist:guangdong-hrss',rules);
    const before=hooks.onBeforeSendHeaders.mock.calls[0][1],completed=hooks.onCompleted.mock.calls[0][1],url='https://hrss.gdgov.cn/employment/main/rest/fixture';
    before({id:1,url,requestHeaders:{'Access-Token':'fixture-old'}},()=>{});before({id:2,url,requestHeaders:{'Access-Token':'fixture-old'}},()=>{});
    rules[0].accept('fixture-new');
    completed({id:1,url,statusCode:401,responseHeaders:{'content-type':['application/json']}});
    completed({id:2,url,statusCode:200,responseHeaders:{'content-type':['application/json']}});
    expect(await plugin.sessionRecovery!.snapshot()).toMatchObject({accessToken:'fixture-new'});
  });

  it('keeps new employment credentials when an independent WGBT observation fails',async()=>{
    const plugin=createGuangdongHrssPlugin();await plugin.initialize();
    const rules=vi.mocked(observeBrowserAuthMany).mock.calls.at(-1)![1];rules.find(rule=>rule.urlPattern.includes('/WGBT/'))!.accept('WGBT_SESSION=fixture');rules.find(rule=>rule.urlPattern.includes('/ZXZJ/'))!.accept('hz_zxzj=fixture');
    const hooks={onBeforeSendHeaders:vi.fn(),onCompleted:vi.fn(),onBeforeRedirect:vi.fn(),onErrorOccurred:vi.fn()};
    vi.mocked(session.fromPartition).mockReturnValue({webRequest:hooks} as unknown as ReturnType<typeof session.fromPartition>);
    const actual=await vi.importActual<typeof import('../../main/browser-auth')>('../../main/browser-auth');actual.observeBrowserAuthMany('persist:guangdong-hrss',rules);
    const before=hooks.onBeforeSendHeaders.mock.calls[0][1],completed=hooks.onCompleted.mock.calls[0][1],url='https://hrss.gdgov.cn/WGBT/fixture';
    before({id:1,url,requestHeaders:{Cookie:'WGBT_SESSION=fixture'}},()=>{});rules[0].accept('fixture-new');
    completed({id:1,url,statusCode:401,responseHeaders:{'content-type':['application/json']}});
    expect(await plugin.sessionRecovery!.snapshot()).toMatchObject({accessToken:'fixture-new',trainingCookie:'hz_zxzj=fixture'});
    expect(await plugin.sessionRecovery!.snapshot()).not.toHaveProperty('rawCookie');
  });

  it('preserves observed employment credentials on forbidden responses while still clearing a confirmed unauthorized login',async()=>{
    const plugin=createGuangdongHrssPlugin();await plugin.initialize();
    const rules=vi.mocked(observeBrowserAuthMany).mock.calls.at(-1)![1];rules[0].accept('fixture-access');
    expect(rules[0].sessionRejected?.({statusCode:403} as any)).toBe(false);
    expect(rules[0].sessionRejected?.({statusCode:401} as any)).toBe(true);
  });
});

describe('广东人社插件',()=>{
  it('exposes two date controls for all 22 matters with their verified date semantics',()=>{
    const plugin=createGuangdongHrssPlugin({now:()=>Date.parse('2026-11-05T01:00:00Z')});
    for(const matter of plugin.matters){
      expect(matter.querySchema.map(field=>[field.key,field.type,field.required])).toEqual([['startDate','date',true],['endDate','date',true]]);
      expect(()=>validateFilters(matter.querySchema,matter.createDefaultContext!().filters)).not.toThrow();
      expect(matter.dateFilter?.mode).toBe(['poverty-alleviation-personnel','one-time-job-expansion-subsidy'].includes(matter.id)?'pending':'applied');
    }
    expect(plugin.matters.filter(matter=>matter.dateFilter?.mode==='pending')).toHaveLength(2);
    const poverty=plugin.matters.find(matter=>matter.id==='poverty-alleviation-personnel')!;
    expect(poverty.dateFilter?.message).toBe('');
    expect(poverty.createDefaultContext!().filters).toEqual({startDate:'2026-11-01',endDate:'2026-11-05'});
  });
  it('connects all four street-office matters and registers the independent training session observer once',async()=>{
    const plugin=createGuangdongHrssPlugin();expect(()=>validatePluginContract(plugin)).not.toThrow();
    expect(plugin.id).toBe('guangdong-hrss');expect(plugin.workspaceMode).toBe('list-ledger');expect(plugin.matters).toHaveLength(22);
    expect(plugin.matters.filter(matter=>matter.queryAvailable===false)).toEqual([]);
    expect(plugin.matters.filter(matter=>matter.departmentId==='subdistrict-office').map(matter=>[matter.departmentName,matter.name])).toEqual([
      ['街道办','企业招用困难人员补贴'],['街道办','企业招用困难人员岗位补贴'],['街道办','创业培训'],['街道办','吸纳退役军人就业补贴'],
    ]);
    expect(plugin.matters.every(m=>m.getDetail===undefined)).toBe(true);
    expect(plugin.matters.every(m=>m.uniqueKey[0]==='recordKey')).toBe(true);
    expect(plugin.matters.every(m=>m.listColumns?.every(c=>c.key!=='recordKey'))).toBe(true);
    await plugin.initialize();await plugin.initialize();
    expect(observeBrowserAuthMany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(observeBrowserAuthMany).mock.calls[0][1].map(o=>o.header)).toEqual(['access-token','access-token','access-token','access-token','access-token','cookie','cookie']);
  });
  it('only invokes catalogued list/count endpoints for empty lists and preserves independent training login requirements',async()=>{
    const now=()=>Date.parse('2025-05-01T04:00:00Z');
    const fetcher=vi.fn(async(url:string,_init:RequestInit)=>new Response(JSON.stringify(url.includes('/WGBT/')?{total:0,rows:[]}:{data:{total:0,records:[]}}),{headers:{'content-type':'application/json'}}));
    const plugin=createGuangdongHrssPlugin({fetcher,now,minimumIntervalMs:0});
    await plugin.sessionRecovery!.restore({accessToken:'fixture-access',rawCookie:'fixture-session=value',expiresAt:now()+60_000});
    for(const matter of plugin.matters.filter(item=>item.id!=='startup-training')){const result=await matter.query(matter.createDefaultContext!());expect(result.total).toBe(0);}
    const before = fetcher.mock.calls.length;
    const povertyCalls=fetcher.mock.calls.filter(([url])=>new URL(url).pathname==='/employment/main/rest/e/v1/tprk/tprkdj/list');
    expect(povertyCalls).toHaveLength(1);
    expect(new URL(povertyCalls[0][0]).search).toBe('');
    expect(JSON.parse(String(povertyCalls[0][1].body))).toEqual({current:1,size:200});
    const training=plugin.matters.find(m=>m.id==='startup-training')!;
    await expect(training.query(training.createDefaultContext!())).rejects.toThrow('创业培训');
    expect(fetcher).toHaveBeenCalledTimes(before);
    const allowed=new Set(HRSS_MATTER_DEFINITIONS.flatMap(m=>m.sources.flatMap(s=>[s.path,...(s.countPath?[s.countPath]:[])])));
    expect(fetcher.mock.calls.every(([url])=>allowed.has(new URL(url).pathname))).toBe(true);
    expect(fetcher.mock.calls.some(([url])=>/detail|queryPerson|jysyxxtj|getsydjdetail|operate-log/i.test(url))).toBe(false);
    const requestSession=await plugin.auth.getSessionForRequest();
    expect(requestSession).not.toHaveProperty('accessToken');expect(requestSession).not.toHaveProperty('cookies');
  });
});
