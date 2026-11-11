import { describe,expect,it,vi } from 'vitest';
import { HRSS_MATTER_BY_ID, HRSS_MATTER_DEFINITIONS, type HrssListSource } from './catalog';
import { buildHrssListParameters,projectHrssListRecord,queryHrssLedger } from './query';

const now=Date.parse('2026-11-04T04:05:06Z');
const definition=(id:string)=>HRSS_MATTER_BY_ID.get(id)!;
const context={page:1,pageSize:200,filters:{}};
const raw=(id:string)=>({bce097:id,aab004:'测试单位',aac147:'TEST-ID',aac003:'列表姓名',bce076:id,cdc151:id,bdzz77:id,CCD002:id,aab998:'UNIT',bae062:'2026-01-01'});

describe('广东人社台账目录和列表投影',()=>{
  it('covers the 18 ledgers with Chinese labels, privacy flags and no detail-only education fields',()=>{
    expect(HRSS_MATTER_DEFINITIONS).toHaveLength(18);
    expect(new Set(HRSS_MATTER_DEFINITIONS.map(m=>m.id)).size).toBe(18);
    for(const matter of HRSS_MATTER_DEFINITIONS){
      expect(new Set(matter.columns.map(c=>c.key)).size).toBe(matter.columns.length);
      expect(matter.columns.every(c=>/[\u3400-\u9fff]/.test(c.label))).toBe(true);
      expect(matter.columns.some(c=>c.key==='recordKey')).toBe(false);
      expect(matter.sources.every(s=>!/(detail|queryPerson|jysyxxtj)/i.test(s.path))).toBe(true);
      for(const column of matter.columns.filter(c=>['name','cardNumber','phone'].includes(c.key))) expect(column.sensitive).toBe(true);
      if(matter.id!=='youth-internship-agreement') expect(matter.columns.some(c=>c.key==='xueli')).toBe(false);
    }
  });
  it('projects only whitelisted scalar fields and retains zero amounts without scaling',()=>{
    const matter=definition('startup-employment-subsidy');
    const result=projectHrssListRecord(matter,matter.sources[0],{...raw('APPLY-1'),money:0,passMoney:'100.50',adminToken:'not-business-data',attachments:[{content:'detail'}],unknown:'discard',aac003:{nested:'discard'}});
    expect(result).toMatchObject({applyBh:'APPLY-1',applyAmount:'0',currentSuccessAmount:'100.50',unitName:'测试单位'});
    expect(result).not.toHaveProperty('adminToken'); expect(result).not.toHaveProperty('attachments');expect(result).not.toHaveProperty('unknown');
    expect(Object.keys(result).sort()).toEqual([...matter.columns.map(c=>c.key),'recordKey'].sort());
  });
  it('does not substitute a unit address for internship person name',()=>{
    const matter=definition('youth-internship-agreement');
    const result=projectHrssListRecord(matter,matter.sources[1],{...raw('APPLY-1'),aac003:'本人姓名',aab078Name:'单位地址',aac011Name:'大学本科'});
    expect(result.name).toBe('本人姓名');expect(result.unitAddress).toBe('单位地址');expect(result.xueli).toBe('大学本科');
  });
  it('rejects missing/masked business keys instead of producing unstable indexes',()=>{
    const matter=definition('poverty-alleviation-personnel');
    expect(()=>projectHrssListRecord(matter,matter.sources[0],{aac147:'4403********1234'})).toThrow('稳定识别');
    expect(()=>projectHrssListRecord(matter,matter.sources[0],{})).toThrow('稳定识别');
  });
});

describe('广东人社原列表参数',()=>{
  it('keeps both flexible employment category codes and the fixed area',()=>{
    expect(buildHrssListParameters(definition('graduate-flexible-employment-subsidy').sources[0],2,now)).toEqual({adc953:'LHJYBT_20',current:2,size:200});
    expect(buildHrssListParameters(definition('difficult-flexible-employment-subsidy').sources[0],1,now).adc953).toBe('LHJYBT_10');
    expect(buildHrssListParameters(definition('employment-difficulty-recognition').sources[0],1,now)).toMatchObject({cdc135:'163374'});
  });
  it('uses a Shanghai calendar month only for unemployed tracking',()=>{
    expect(buildHrssListParameters(definition('unemployment-tracking-service').sources[0],2,now)).toMatchObject({pagenum:2,pagesize:200,bdca42:'103',bae003:['2026-11-01 00:00:00','2026-11-04 12:05:06'],bdzz27List:['01','02','03']});
    expect(buildHrssListParameters(definition('graduate-tracking-service').sources[0],1,now).bae003).toEqual([null,null]);
  });
  it('keeps WGBT page-number semantics and its original opaque list filter separate',()=>{
    const params=buildHrssListParameters(definition('one-time-job-expansion-subsidy').sources[0],3,now);
    expect(params).toMatchObject({confid:'bxfh_ycxkgbz_jdcx_bljbcx_blywjdcxjglb',rowstart:3,pageSize:200});
    expect(typeof params.whereCls).toBe('string');expect(String(params.whereCls).length).toBeGreaterThan(100);
  });
});

describe('完整分页、稳定键与取消',()=>{
  it('records new date selections without adding them to any of the 17 deferred source queries',async()=>{
    for(const matter of HRSS_MATTER_DEFINITIONS.filter(m=>m.id!=='unemployment')){
      const request=vi.fn(async()=>({total:0,rows:[]}));
      await queryHrssLedger({request},matter,{...context,filters:{startDate:'2020-01-01',endDate:'2020-01-31'}},now);
      const first=request.mock.calls.map(call=>call.slice(0,2));
      request.mockClear();
      await queryHrssLedger({request},matter,{...context,filters:{startDate:'2024-07-01',endDate:'2024-07-31'}},now);
      expect(request.mock.calls.map(call=>call.slice(0,2))).toEqual(first);
    }
  });
  it('collects every page and reports progress, preserving stable keys across reruns',async()=>{
    const request=vi.fn(async(_source,params)=>({total:201,rows:params.current===1?Array.from({length:200},(_,i)=>raw(`A-${i}`)):[raw('A-200')]}));
    const progress=vi.fn();const matter=definition('job-seeking-startup-subsidy');
    const first=await queryHrssLedger({request},matter,{...context,onProgress:progress},now);
    const second=await queryHrssLedger({request},matter,context,now);
    expect(first.rows).toHaveLength(201);expect(first.total).toBe(201);expect(first.pageSize).toBe(201);
    expect(first.rows.map(r=>r.recordKey)).toEqual(second.rows.map(r=>r.recordKey));
    expect(first.rows.every(r=>/^[a-f0-9]{64}$/.test(String(r.recordKey)))).toBe(true);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({current:201,total:201}));
  });
  it('fails the complete query if any page is short or totals change',async()=>{
    const matter=definition('job-seeking-startup-subsidy');
    await expect(queryHrssLedger({request:vi.fn(async()=>({total:201,rows:[raw('A')]}))},matter,context,now)).rejects.toThrow('分页条数');
    const request=vi.fn().mockResolvedValueOnce({total:201,rows:Array.from({length:200},(_,i)=>raw(`A-${i}`))}).mockResolvedValueOnce({total:202,rows:[raw('B')]});
    await expect(queryHrssLedger({request},matter,context,now)).rejects.toThrow('总数发生变化');
  });
  it('rejects repeated pages and conflicting business identifiers',async()=>{
    const matter=definition('job-seeking-startup-subsidy');const records=Array.from({length:200},(_,i)=>raw(`A-${i}`));
    await expect(queryHrssLedger({request:vi.fn(async()=>({total:400,rows:records}))},matter,context,now)).rejects.toThrow('重复分页');
    await expect(queryHrssLedger({request:vi.fn(async()=>({total:2,rows:[raw('A'),{...raw('A'),aab004:'另一单位'}]}))},matter,context,now)).rejects.toThrow('重复业务编号');
  });
  it('rejects a duplicated key on a different, otherwise new page',async()=>{
    const first=Array.from({length:200},(_,i)=>raw(`A-${i}`));
    const request=vi.fn().mockResolvedValueOnce({total:201,rows:first}).mockResolvedValueOnce({total:201,rows:[raw('A-10')]});
    await expect(queryHrssLedger({request},definition('job-seeking-startup-subsidy'),context,now)).rejects.toThrow('重复业务编号');
  });
  it('checks cancellation before a request and after every response',async()=>{
    const controller=new AbortController();controller.abort();const request=vi.fn();
    await expect(queryHrssLedger({request},definition('job-seeking-startup-subsidy'),{...context,signal:controller.signal},now)).rejects.toMatchObject({code:'TASK_CANCELLED'});
    expect(request).not.toHaveBeenCalled();
    const second=new AbortController();const cancelDuringRequest=vi.fn(async()=>{second.abort();return {total:0,rows:[]};});
    await expect(queryHrssLedger({request:cancelDuringRequest},definition('job-seeking-startup-subsidy'),{...context,signal:second.signal},now)).rejects.toMatchObject({code:'TASK_CANCELLED'});
  });
  it('queries unemployment per day with original parameters and only count/list routes',async()=>{
    const request=vi.fn(async(_source,_params,_signal,countOnly)=>({total:countOnly?1:1,rows:countOnly?[]:[raw('SAME-ACCEPTANCE')]}));
    const result=await queryHrssLedger({request},definition('unemployment'),{...context,filters:{startDate:'2026-11-03',endDate:'2026-11-04'}},now);
    expect(request).toHaveBeenCalledTimes(4);expect(result.rows).toHaveLength(1);
    expect(request.mock.calls[0][1]).toEqual({bce089Start:'2026-11-03',bce089End:'2026-11-03',aac004:'',bae085:'01',bae001:'163374',bbd068:'01'});
    expect(request.mock.calls[2][1].bce089Start).toBe('2026-11-04');
    expect(request.mock.calls.every(c=>c[0].path.endsWith('/syxx/page'))).toBe(true);
  });
  it('does not request an unemployment list page when its date count is zero',async()=>{
    const request=vi.fn(async(_source:HrssListSource,_params:Record<string,unknown>,_signal?:AbortSignal,_countOnly?:boolean)=>({total:0,rows:[]}));
    const result=await queryHrssLedger({request},definition('unemployment'),{...context,filters:{startDate:'2026-11-04',endDate:'2026-11-04'}},now);
    expect(result.total).toBe(0);expect(request).toHaveBeenCalledTimes(1);expect(request.mock.calls[0]).toHaveLength(4);expect(request.mock.calls[0][3]).toBe(true);
  });
  it('keeps unit review and registration records separate rather than counting one twice as the same row',async()=>{
    const request=vi.fn(async()=>({total:1,rows:[raw('A')]}));const matter=definition('youth-internship-unit');
    const result=await queryHrssLedger({request},matter,context,now);
    expect(request).toHaveBeenCalledTimes(2);expect(result.rows).toHaveLength(2);
    expect(new Set(result.rows.map(r=>r.recordKey)).size).toBe(2);
    expect(result.rows.map(r=>r.listSource)).toEqual(['审核列表','查询列表']);
  });
});
