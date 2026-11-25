import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeSqliteDriver } from '../core/storage/database';
import { SqliteLocalRepository } from '../core/storage/sqlite-repository';
import { SqlitePlatformStore } from '../core/storage/platform-store';
import { TaskEngine, type RuntimeTask } from '../core/tasks/engine';
import type { BusinessSystemPlugin } from '../core/plugins/types';
import type { LicenseGrant } from '../core/license/types';
import { assertSystemLicensed } from '../core/license/gate';
import { AppError } from '../core/errors/app-error';
import { ReturnBatchService, parseReturnBatchInput } from './return-batch-service';

const systemId='guangdong-hrss';
const input=()=>({matterIds:['first','second'],startDate:'2026-11-01',endDate:'2026-11-25'});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean|Promise<boolean>) {for(let i=0;i<100;i++){if(await check())return;await tick();}throw new Error('Fixture did not settle');}

describe('batch return registration and authorization',()=>{
  let db:NodeSqliteDriver,store:SqlitePlatformStore,tasks:TaskEngine,service:ReturnBatchService,plugin:BusinessSystemPlugin,grant:LicenseGrant;
  let loggedIn=true;
  const execute=vi.fn();
  const releases:Array<()=>void>=[];
  const hold=()=>new Promise<void>(resolve=>releases.push(resolve));
  beforeEach(async()=>{
    vi.clearAllMocks();loggedIn=true;
    db=new NodeSqliteDriver(':memory:');await new SqliteLocalRepository(db).initialize();store=new SqlitePlatformStore(db);await store.initialize();tasks=new TaskEngine(store,2);
    grant={licenseId:'fixture',expiresAt:Date.now()+60_000,allowedSystems:[systemId],allowedMatters:{[systemId]:['first','second','third']}};
    plugin={id:systemId,name:'示例系统',version:'1.0.0',initialize:async()=>{},getSessionState:async()=>({systemId,status:loggedIn?'authenticated':'logged-out'}),
      auth:{getState:async()=>({systemId,status:'authenticated'}),login:async()=>({systemId,status:'authenticated'}),logout:async()=>{},getSessionForRequest:async()=>({})},
      matters:['first','second','third'].map((id,index)=>({id,name:['业务甲','业务乙','业务丙'][index],executionMode:'one-click-return',uniqueKey:['id'],
        querySchema:[{key:'startDate',label:'开始日期',type:'date',required:true},{key:'endDate',label:'结束日期',type:'date',required:true},{key:'kind',label:'分类',type:'select',required:true,options:[{value:'a',label:'甲'},{value:'b',label:'乙'}]}],
        createDefaultContext:()=>({page:1,pageSize:200,filters:{startDate:'2020-01-01',endDate:'2020-01-02',kind:index===0?'a':'b'}}),query:async()=>({rows:[],total:0,page:1,pageSize:200})}))};
    execute.mockResolvedValue({total:0});
    service=new ReturnBatchService({plugin:id=>id===systemId?plugin:undefined,requireLicense:async(id,matter)=>{assertSystemLicensed(grant,id,matter);return grant;},tasks:()=>tasks,
      storedTasks:(id,batch)=>store.returnBatchTasks(id,batch),execute});
  });
  afterEach(async()=>{for(const release of releases.splice(0))release();for(const task of tasks.list())if(task.status==='queued')tasks.cancel(task.id);await until(()=>tasks.list().every(task=>!['queued','running'].includes(task.status)));await tick();await tick();await db.close();vi.restoreAllMocks();});

  it('persists every child before starting and returns immediately with frozen dates and independent conditions',async()=>{
    const first=hold();execute.mockImplementation(async(_system,matter,_context,query)=>{if(matter==='first')await first;return {kind:query.filters.kind};});
    const selected={...input(),filtersByMatter:{first:{kind:'b'}}};
    const result=await service.submit(systemId,selected);
    expect(result.count).toBe(2);expect(result.taskIds).toHaveLength(2);await until(()=>execute.mock.calls.length===1);expect(execute).toHaveBeenCalledTimes(1);
    const stored=await store.returnBatchTasks(systemId,result.batchId);expect(stored).toHaveLength(2);
    expect(stored.map(task=>(task.details?.returnContext as any).filters)).toEqual([
      {startDate:'2026-11-01',endDate:'2026-11-25',kind:'b'},{startDate:'2026-11-01',endDate:'2026-11-25',kind:'b'}]);
    selected.startDate='2030-01-01';selected.filtersByMatter.first.kind='a';
    expect(tasks.get(result.taskIds[1])?.status).toBe('queued');releases.shift()!();await until(()=>execute.mock.calls.length===2);
    expect(execute.mock.calls[1][3].filters.startDate).toBe('2026-11-01');
    expect(execute.mock.calls[0][3].filters.kind).toBe('b');
  });

  it('rejects an unavailable or invalid selected matter before registering any child',async()=>{
    plugin.matters[1].queryAvailable=false;
    await expect(service.submit(systemId,input())).rejects.toThrow('业务乙');expect(tasks.list()).toEqual([]);expect(execute).not.toHaveBeenCalled();
    plugin.matters[1].queryAvailable=undefined;
    await expect(service.submit(systemId,{...input(),filtersByMatter:{second:{kind:''}}})).rejects.toThrow('分类不能为空');
    expect(await db.get<{n:number}>('SELECT COUNT(*) n FROM runtime_tasks')).toEqual({n:0});
  });

  it('validates the entire permission scope and source session before creating tasks',async()=>{
    grant.allowedMatters={[systemId]:['first']};
    await expect(service.submit(systemId,input())).rejects.toThrow();expect(tasks.list()).toHaveLength(0);
    grant.allowedMatters=undefined;loggedIn=false;
    await expect(service.submit(systemId,input())).rejects.toMatchObject({code:'SYSTEM_LOGIN_REQUIRED'});expect(execute).not.toHaveBeenCalled();
  });

  it('prevents duplicate active submissions including concurrent clicks while allowing a new date range',async()=>{
    const pending=hold();execute.mockImplementation(async()=>pending);
    const results=await Promise.allSettled([service.submit(systemId,input()),service.submit(systemId,input())]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
    expect(tasks.list()).toHaveLength(2);
    const next=await service.submit(systemId,{matterIds:['first'],startDate:'2026-10-01',endDate:'2026-10-31'});expect(next.count).toBe(1);
  });

  it('filters batch reads and cancellations by current matter grants and ignores forged system/batch scope',async()=>{
    const pending=hold();execute.mockImplementation(async()=>pending);
    const result=await service.submit(systemId,{...input(),matterIds:['first','second','third']});
    grant.allowedMatters={[systemId]:['first','second']};
    const state=await service.get(systemId,result.batchId);expect(state.tasks.map(task=>task.matterId)).toEqual(['first','second']);expect(state.counts).toMatchObject({total:2,running:1,queued:1});
    expect(await service.cancelPending(systemId,result.batchId)).toEqual({cancelled:1});expect(tasks.get(result.taskIds[2])?.status).toBe('queued');
    await expect(service.get('another-system',result.batchId)).rejects.toThrow();
    await expect(service.get(systemId,'forged-batch')).rejects.toThrow('不存在');
  });

  it('retries only failed children using their original filters and retains the original audit history',async()=>{
    const pending=hold();let fail=true;
    execute.mockImplementation(async(_system,matter)=>{if(matter==='first')await pending;if(matter==='second'&&fail)throw new Error('fixture failure');return {total:0};});
    const first=await service.submit(systemId,{...input(),matterIds:['first','second','third'],filtersByMatter:{second:{kind:'a'}}});
    tasks.cancel(first.taskIds[2]);releases.shift()!();await until(()=>tasks.get(first.taskIds[1])?.status==='failed');await tick();
    fail=false;const retry=await service.retryFailed(systemId,first.batchId);expect(retry.count).toBe(1);expect(retry.batchId).not.toBe(first.batchId);
    expect(tasks.get(retry.taskIds[0])?.details?.returnContext).toMatchObject({filters:{startDate:'2026-11-01',endDate:'2026-11-25',kind:'a'}});
    expect((await service.get(systemId,first.batchId)).counts).toMatchObject({completed:1,failed:1,cancelled:1});
    expect(execute.mock.calls.filter(call=>call[1]==='first')).toHaveLength(1);
  });

  it('pauses only the expired source and resumes pending work after authentication',async()=>{
    execute.mockImplementationOnce(async()=>{loggedIn=false;throw new AppError('SESSION_EXPIRED','会话失效');});
    const result=await service.submit(systemId,input());await until(()=>tasks.get(result.taskIds[0])?.status==='failed');
    expect(tasks.get(result.taskIds[1])?.status).toBe('queued');expect(execute).toHaveBeenCalledTimes(1);
    expect((await tasks.run('其他系统',async()=>true,{type:'data-return',systemId:'other'})).status).toBe('completed');
    loggedIn=true;service.onSessionState(systemId,'authenticated');await until(()=>execute.mock.calls.length===2);
  });

  it('rolls back an initial batch storage failure and never starts a partially registered batch',async()=>{
    const save=store.save.bind(store);let calls=0;
    vi.spyOn(store,'save').mockImplementation(async task=>{if(++calls===2)throw new Error('fixture write failure');await save(task);});
    await expect(service.submit(systemId,input())).rejects.toThrow('fixture write failure');
    expect(await db.get<{n:number}>('SELECT COUNT(*) n FROM runtime_tasks')).toEqual({n:0});expect(tasks.list()).toEqual([]);expect(execute).not.toHaveBeenCalled();
  });

  it('rejects unknown query fields and never stores supplied credentials',async()=>{
    await expect(service.submit(systemId,{...input(),filtersByMatter:{first:{token:'PRIVATE-FIXTURE'}}})).rejects.toThrow('不支持的查询字段');
    expect(await db.get<{n:number}>('SELECT COUNT(*) n FROM runtime_tasks')).toEqual({n:0});
  });
  it('shows a final state-write failure as a failed child rather than a completed batch',async()=>{
    const save=store.save.bind(store);let failed=false;
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    vi.spyOn(store,'save').mockImplementation(async task=>{if(task.status==='completed'&&!failed){failed=true;throw new Error('fixture final write failure');}await save(task);});
    const result=await service.submit(systemId,{...input(),matterIds:['first']});
    await until(()=>tasks.get(result.taskIds[0])?.status==='failed');await tick();
    expect((await service.get(systemId,result.batchId)).counts).toMatchObject({failed:1,completed:0});
    await until(async()=> (await store.getTask(result.taskIds[0]))?.status==='failed');
    expect(tasks.get(result.taskIds[0])?.error).toContain('任务状态保存失败');
    expect(JSON.stringify(warn.mock.calls)).toContain('状态未能完整保存');
  });
});

it.each([
  {},{matterIds:[],startDate:'2026-11-01',endDate:'2026-11-02'},
  {matterIds:['first','first'],startDate:'2026-11-01',endDate:'2026-11-02'},
  {matterIds:['first'],startDate:'2026-02-30',endDate:'2026-03-01'},
  {matterIds:['first'],startDate:'2026-11-02',endDate:'2026-11-01'},
  {matterIds:['first'],startDate:'2026-11-01',endDate:'2026-11-02',filtersByMatter:{second:{}}},
  {matterIds:['first'],startDate:'2026-11-01',endDate:'2026-11-02',sid:'PRIVATE-FIXTURE'},
])('rejects malformed batch descriptors: %j',value=>{expect(()=>parseReturnBatchInput(value)).toThrow();});
