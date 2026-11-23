import { describe,expect,it,vi } from 'vitest';
vi.mock('electron',()=>({session:{fromPartition:vi.fn()}}));
vi.mock('../../main/browser-auth',()=>({observeBrowserAuthMany:vi.fn()}));
import { observeBrowserAuthMany } from '../../main/browser-auth';
import { validatePluginContract } from '../../core/plugins/types';
import { createGuangdongHrssPlugin,HRSS_MATTER_DEFINITIONS } from './index';
import { validateFilters } from '../../core/query/validation';

it('opens the confirmed SSO login page and keeps the authenticated employment workspace separate',()=>{
  const plugin=createGuangdongHrssPlugin();
  expect(plugin.loginPage?.url).toBe('https://hrss.gdgov.cn/sso/login.html');
  expect(plugin.loginPage?.allowedOrigin).toBe('https://hrss.gdgov.cn');
  expect(plugin.sessionRecovery?.homeUrl()).toBe('https://hrss.gdgov.cn/employment/main/#/jysydj/jydj/jysyxxcx?_modulePartId_=1000000000002420304');
});

describe('广东人社插件',()=>{
  it('exposes two date controls for all 22 matters and keeps existing date semantics',()=>{
    const plugin=createGuangdongHrssPlugin({now:()=>Date.parse('2026-11-05T01:00:00Z')});
    for(const matter of plugin.matters){
      expect(matter.querySchema.map(field=>[field.key,field.type,field.required])).toEqual([['startDate','date',true],['endDate','date',true]]);
      expect(()=>validateFilters(matter.querySchema,matter.createDefaultContext!().filters)).not.toThrow();
      expect(matter.dateFilter?.mode).toBe(matter.queryAvailable === false ? undefined : matter.id==='unemployment'?'applied':'pending');
    }
    expect(plugin.matters.filter(matter=>matter.dateFilter?.mode==='pending')).toHaveLength(17);
  });
  it('exposes 18 connected matters and four street-office matters with one browser listener registration',async()=>{
    const plugin=createGuangdongHrssPlugin();expect(()=>validatePluginContract(plugin)).not.toThrow();
    expect(plugin.id).toBe('guangdong-hrss');expect(plugin.workspaceMode).toBe('list-ledger');expect(plugin.matters).toHaveLength(22);
    expect(plugin.matters.filter(matter=>matter.queryAvailable===false).map(matter=>[matter.departmentName,matter.name])).toEqual([
      ['街道办','企业招用困难人员补贴'],['街道办','企业招用困难人员岗位补贴'],['街道办','创业培训'],['街道办','吸纳退役军人就业补贴'],
    ]);
    expect(plugin.matters.every(m=>m.getDetail===undefined)).toBe(true);
    expect(plugin.matters.every(m=>m.uniqueKey[0]==='recordKey')).toBe(true);
    expect(plugin.matters.every(m=>m.listColumns?.every(c=>c.key!=='recordKey'))).toBe(true);
    await plugin.initialize();await plugin.initialize();
    expect(observeBrowserAuthMany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(observeBrowserAuthMany).mock.calls[0][1].map(o=>o.header)).toEqual(['access-token','access-token','access-token','cookie']);
  });
  it('all 18 ledgers only invoke their catalogued list/count endpoints without enrichment',async()=>{
    const now=()=>Date.parse('2025-05-01T04:00:00Z');
    const fetcher=vi.fn(async(url:string)=>new Response(JSON.stringify(url.includes('/WGBT/')?{total:0,rows:[]}:{data:{total:0,records:[]}}),{headers:{'content-type':'application/json'}}));
    const plugin=createGuangdongHrssPlugin({fetcher,now,minimumIntervalMs:0});
    await plugin.sessionRecovery!.restore({accessToken:'fixture-access',rawCookie:'fixture-session=value',expiresAt:now()+60_000});
    for(const matter of plugin.matters.filter(item=>item.queryAvailable!==false)){const result=await matter.query(matter.createDefaultContext!());expect(result.total).toBe(0);}
    const before = fetcher.mock.calls.length;
    for(const matter of plugin.matters.filter(item=>item.queryAvailable===false)){
      await expect(matter.query(matter.createDefaultContext!())).rejects.toThrow('当前事项暂时无法回流');
    }
    expect(fetcher).toHaveBeenCalledTimes(before);
    const allowed=new Set(HRSS_MATTER_DEFINITIONS.flatMap(m=>m.sources.flatMap(s=>[s.path,...(s.countPath?[s.countPath]:[])])));
    expect(fetcher.mock.calls.every(([url])=>allowed.has(new URL(url).pathname))).toBe(true);
    expect(fetcher.mock.calls.some(([url])=>/detail|queryPerson|jysyxxtj|getsydjdetail/i.test(url))).toBe(false);
    const requestSession=await plugin.auth.getSessionForRequest();
    expect(requestSession).not.toHaveProperty('accessToken');expect(requestSession).not.toHaveProperty('cookies');
  });
});
