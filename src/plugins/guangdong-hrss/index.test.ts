import { describe,expect,it,vi } from 'vitest';
vi.mock('electron',()=>({session:{fromPartition:vi.fn()}}));
vi.mock('../../main/browser-auth',()=>({observeBrowserAuthMany:vi.fn()}));
import { observeBrowserAuthMany } from '../../main/browser-auth';
import { validatePluginContract } from '../../core/plugins/types';
import { createGuangdongHrssPlugin,HRSS_MATTER_DEFINITIONS } from './index';
import { validateFilters } from '../../core/query/validation';

it('opens the SSO entry for login and restores the full portal instead of a single business page',()=>{
  const plugin=createGuangdongHrssPlugin();
  expect(plugin.loginPage?.url).toBe('https://hrss.gdgov.cn/sso/login.html');
  expect(plugin.loginPage?.allowedOrigin).toBe('https://hrss.gdgov.cn');
  expect(plugin.sessionRecovery?.homeUrl()).toBe('https://hrss.gdgov.cn/portal/template/system.html');
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
    expect(vi.mocked(observeBrowserAuthMany).mock.calls[0][1].map(o=>o.header)).toEqual(['access-token','access-token','access-token','cookie','cookie']);
  });
  it('only invokes catalogued list/count endpoints for empty lists and preserves independent training login requirements',async()=>{
    const now=()=>Date.parse('2025-05-01T04:00:00Z');
    const fetcher=vi.fn(async(url:string)=>new Response(JSON.stringify(url.includes('/WGBT/')?{total:0,rows:[]}:{data:{total:0,records:[]}}),{headers:{'content-type':'application/json'}}));
    const plugin=createGuangdongHrssPlugin({fetcher,now,minimumIntervalMs:0});
    await plugin.sessionRecovery!.restore({accessToken:'fixture-access',rawCookie:'fixture-session=value',expiresAt:now()+60_000});
    for(const matter of plugin.matters.filter(item=>!['poverty-alleviation-personnel','startup-training'].includes(item.id))){const result=await matter.query(matter.createDefaultContext!());expect(result.total).toBe(0);}
    const before = fetcher.mock.calls.length;
    const poverty=plugin.matters.find(m=>m.id==='poverty-alleviation-personnel')!;
    await expect(poverty.query(poverty.createDefaultContext!())).rejects.toThrow('原站列表未提供日期条件');
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
