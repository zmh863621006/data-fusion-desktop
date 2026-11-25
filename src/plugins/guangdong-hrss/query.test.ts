import { describe,expect,it,vi } from 'vitest';
import { HRSS_MATTER_BY_ID, HRSS_MATTER_DEFINITIONS, type HrssListSource } from './catalog';
import { buildHrssListParameters,projectHrssListRecord,queryHrssLedger } from './query';
import { MemoryLocalRepository } from '../../core/storage/memory-repository';
import { DefaultLocalSyncEngine } from '../../core/sync/engine';
import { AppError } from '../../core/errors/app-error';
import { HRSS_STREET_PROFILES } from './street';
import { buildTrainingListParameters, HRSS_TRAINING_HANDLING_CONFIG } from './training';

const now=Date.parse('2026-11-04T04:05:06Z');
const definition=(id:string)=>HRSS_MATTER_BY_ID.get(id)!;
const context={page:1,pageSize:200,filters:{}};
const raw=(id:string)=>({bce097:id,aab004:'测试单位',aac147:'TEST-ID',aac003:'列表姓名',bce076:id,bce324:id,cdc151:id,bdzz77:id,CCD002:id,aab998:'UNIT',bae062:'2026-01-01'});
const originalMatters=()=>HRSS_MATTER_DEFINITIONS.filter(m=>m.departmentId!=='subdistrict-office');

describe('广东人社台账目录和列表投影',()=>{
  it('covers the 18 ledgers with Chinese labels, privacy flags and no detail-only education fields',()=>{
    expect(originalMatters()).toHaveLength(18);
    expect(new Set(originalMatters().map(m=>m.id)).size).toBe(18);
    for(const matter of originalMatters()){
      expect(new Set(matter.columns.map(c=>c.key)).size).toBe(matter.columns.length);
      expect(matter.columns.every(c=>/[\u3400-\u9fff]/.test(c.label))).toBe(true);
      expect(matter.columns.some(c=>c.key==='recordKey')).toBe(false);
      expect(matter.sources.every(s=>!/(detail|queryPerson|jysyxxtj)/i.test(s.path))).toBe(true);
      if(matter.id==='unemployment') expect(matter.sources[0]).toMatchObject({path:'/employment/main/rest/e/v1/jygl/jysyxxcx/syxx/page',countPath:'/employment/main/rest/e/v1/jygl/jysyxxcx/syxx/page/cnt',identity:[['slbh']]});
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
  it('uses the legacy unemployment acceptance number for a stable upsert key regardless of the source row id',()=>{
    const matter=definition('unemployment'),source=matter.sources[0];
    const first=projectHrssListRecord(matter,source,{...raw('SAME-ACCEPTANCE'),bce324:'REGISTRATION-1',boe017Name:'新办'});
    const second=projectHrssListRecord(matter,source,{...raw('SAME-ACCEPTANCE'),bce324:'REGISTRATION-2',boe017Name:'注销'});
    expect(first.slbh).toBe(second.slbh);expect(first.recordKey).toBe(second.recordKey);
    expect(projectHrssListRecord(matter,source,{...raw('DIFFERENT-ACCEPTANCE'),bce324:'REGISTRATION-1'}).recordKey).not.toBe(first.recordKey);
    expect(projectHrssListRecord(matter,source,{...raw('SAME-ACCEPTANCE'),bce324:undefined,aac003:'更正姓名'}).recordKey).toBe(first.recordKey);
    expect(Object.keys(first).sort()).toEqual([...matter.columns.map(c=>c.key),'recordKey'].sort());
    expect(first).not.toHaveProperty('bce324');
  });
});

describe('街道办列表筛选与办理记录回流',()=>{
  const matter=()=>({...definition('job-seeking-startup-subsidy'),id:'enterprise-hiring-difficult-personnel-subsidy',name:'企业招用困难人员补贴',departmentId:'subdistrict-office',...HRSS_STREET_PROFILES['enterprise-hiring-difficult-personnel-subsidy']});
  const selected={...context,filters:{startDate:'2026-11-01',endDate:'2026-11-02'}};
  const pending=(id:string)=>({...raw(id),bbe955:'02',bbe955Name:'待受理'});
  const active=(id:string)=>({...raw(id),bbe955:'03',bbe955Name:'待审核',bzd417:`FLOW-${id}`,adminToken:'discard'});
  const handling=(id:string,date='2026-11-20')=>({bcea9j:id,bzd408Name:'受理',bae045Name:'提交',bee071:'同意',bcbpjb:date,bae046Name:'经办甲',bab019Name:'街道办',adminToken:'discard'});

  it('uses application dates for the cases and retains every handling entry even outside that interval',async()=>{
    const request=vi.fn(async()=>({total:2,rows:[pending('P'),active('A')]}));
    const requestHandlingRecords=vi.fn(async()=>({total:2,rows:[handling('LOG-1','2026-10-31'),handling('LOG-2','2026-11-20')]}));
    const result=await queryHrssLedger({request,requestHandlingRecords},matter(),selected,now);
    expect(result.total).toBe(2);expect(result.rows[0]).toMatchObject({applyBh:'P',currentLink:'待受理',handlingRecordCount:0,handlingRecordStatus:'skipped-pending',handlingRecords:[]});
    expect(result.rows[1]).toMatchObject({applyBh:'A',handlingRecordCount:2,handlingRecordStatus:'collected',handlingRecords:[{handledAt:'2026-10-31'},{handledAt:'2026-11-20'}]});
    expect(request).toHaveBeenCalledWith(matter().sources[0],expect.objectContaining({adc705Begin:'2026-11-01',adc705End:'2026-11-02'}),undefined,false,undefined);
    expect(requestHandlingRecords).toHaveBeenCalledTimes(1);
    expect(requestHandlingRecords).toHaveBeenCalledWith({current:1,size:200,bzd417:'FLOW-A',aaa025:'02'},undefined);
    expect(result.rows.every(row=>!Object.hasOwn(row,'bzd417')&&!Object.hasOwn(row,'adminToken'))).toBe(true);
    expect((result.rows[1].handlingRecords as any[])[0]).not.toHaveProperty('adminToken');
  });
  it.each(Object.keys(HRSS_STREET_PROFILES))('saves pending applications for %s without requesting handling history',async id=>{
    const request=vi.fn(async()=>({total:1,rows:[pending('P')]})),requestHandlingRecords=vi.fn();
    const result=await queryHrssLedger({request,requestHandlingRecords},definition(id),selected,now);
    expect(result.total).toBe(1);expect(result.rows[0]).toMatchObject({applyBh:'P',currentLink:'待受理',handlingRecordCount:0,handlingRecordStatus:'skipped-pending',handlingRecords:[]});
    expect(requestHandlingRecords).not.toHaveBeenCalled();
  });
  it('saves an entire page of pending cases and then continues to later accepted cases',async()=>{
    const request=vi.fn(async(_source,params)=>({total:201,rows:params.current===1?Array.from({length:200},(_,i)=>pending(`P-${i}`)):[active('A')]}));
    const requestHandlingRecords=vi.fn(async()=>({total:0,rows:[]}));
    const result=await queryHrssLedger({request,requestHandlingRecords},matter(),selected,now);
    expect(request).toHaveBeenCalledTimes(2);expect(result.total).toBe(201);expect(result.rows.slice(0,200).every(row=>row.handlingRecordStatus==='skipped-pending'&&row.handlingRecordCount===0)).toBe(true);
    expect(result.rows[200]).toMatchObject({applyBh:'A',handlingRecordCount:0,handlingRecordStatus:'collected'});
    expect(requestHandlingRecords).toHaveBeenCalledTimes(1);
  });
  it('still rejects duplicate pending business keys',async()=>{
    const request=vi.fn(async()=>({total:2,rows:[pending('P'),pending('P')]}));
    const requestHandlingRecords=vi.fn();
    await expect(queryHrssLedger({request,requestHandlingRecords},matter(),selected,now)).rejects.toThrow('重复业务编号');
    expect(requestHandlingRecords).not.toHaveBeenCalled();
  });
  it('does not treat a failed or partial handling query as a successful batch',async()=>{
    const request=vi.fn(async()=>({total:2,rows:[active('A'),active('B')]}));
    const failed=vi.fn().mockResolvedValueOnce({total:1,rows:[handling('L1')]}).mockRejectedValueOnce(new Error('源系统办理记录暂不可用'));
    await expect(queryHrssLedger({request,requestHandlingRecords:failed},matter(),selected,now)).rejects.toThrow('源系统办理记录暂不可用');
    await expect(queryHrssLedger({request,requestHandlingRecords:vi.fn(async()=>({total:2,rows:[handling('L1')]}))},matter(),selected,now)).rejects.toThrow('办理记录分页条数');
  });
  it('checks cancellation immediately after a handling response',async()=>{
    const controller=new AbortController();
    const request=vi.fn(async()=>({total:1,rows:[active('A')]}));
    const requestHandlingRecords=vi.fn(async()=>{controller.abort();return {total:0,rows:[]};});
    await expect(queryHrssLedger({request,requestHandlingRecords},matter(),{...selected,signal:controller.signal},now)).rejects.toMatchObject({code:'TASK_CANCELLED'});
  });
  it('keeps every existing business list-only, even when it contains nonempty rows',async()=>{
    const requestHandlingRecords=vi.fn(async()=>{throw new Error('不应读取办理记录');});
    for(const original of originalMatters().filter(m=>m.id!=='poverty-alleviation-personnel')) {
      const request=vi.fn(async(_source,_params,_signal,countOnly)=>({total:1,rows:countOnly?[]:[active('A')]}));
      const result=await queryHrssLedger({request,requestHandlingRecords},original,{...context,filters:{startDate:'2026-11-01',endDate:'2026-11-01'}},now);
      expect(result.rows.length).toBeGreaterThan(0);expect(result.rows.every(row=>!Object.hasOwn(row,'handlingRecords'))).toBe(true);
    }
    expect(requestHandlingRecords).not.toHaveBeenCalled();
  });
});

describe('创业培训独立会话和旧版列表集成',()=>{
  const session={organizationId:'163374',whereKey:'fixture-key',csrfToken:'fixture-csrf'};
  const selected={...context,filters:{startDate:'2026-11-01',endDate:'2026-11-02'}};
  const progress=(id:string,stage:string)=>({CDB041:id,BHEA81:stage,AAB004:'培训单位',CCD002:`APPLY-${id}`,BCE089:'2026-11-01',adminToken:'discard'});
  const completed=(id:string)=>({CDB041:id,AAB004:'已办单位',CCD002:`APPLY-${id}`,BCE089:'2026-11-02',BJRQ:'2026-11-10'});
  const log={RN:'1',_DIC_CDB042:'审核',BFE086:'通过',CFE006:'同意',JBR:'经办甲',JBRQ:'2026-11-25',JBJG:'街道办'};

  it('queries both application-date lists, retains pending receipt and keeps later handling entries',async()=>{
    const matter=definition('startup-training');
    const request=vi.fn();const requestHandlingRecords=vi.fn();
    const prepareTrainingSession=vi.fn(async()=>session);
    const requestTrainingList=vi.fn(async(params:Record<string,unknown>)=>{
      if(params.confid===HRSS_TRAINING_HANDLING_CONFIG) return {total:1,rows:[log]};
      return String(params.confid).includes('bljdcxjglb')?{total:2,rows:[progress('P','BT_SL'),progress('A','BT_SH')]}:{total:1,rows:[completed('C')]};
    });
    const result=await queryHrssLedger({request,requestHandlingRecords,prepareTrainingSession,requestTrainingList},matter,selected,now);
    expect(prepareTrainingSession).toHaveBeenCalledTimes(1);expect(request).not.toHaveBeenCalled();expect(requestHandlingRecords).not.toHaveBeenCalled();
    expect(requestTrainingList).toHaveBeenCalledWith(buildTrainingListParameters(matter.sources[0],1,'2026-11-01','2026-11-02',session),undefined);
    expect(requestTrainingList).toHaveBeenCalledWith(buildTrainingListParameters(matter.sources[1],1,'2026-11-01','2026-11-02',session),undefined);
    expect(requestTrainingList.mock.calls.filter(([params])=>params.confid===HRSS_TRAINING_HANDLING_CONFIG)).toHaveLength(2);
    expect(result.total).toBe(3);expect(result.rows.map(row=>row.caseId)).toEqual(['P','A','C']);
    expect(result.rows.map(row=>row.listSource)).toEqual(['办理进度列表','办理进度列表','已办业务列表']);
    expect(result.rows[0]).toMatchObject({currentLink:'待受理',handlingRecordCount:0,handlingRecordStatus:'skipped-pending',handlingRecords:[]});
    expect(result.rows.slice(1).every(row=>row.handlingRecordCount===1 && (row.handlingRecords as any[])[0].handledAt==='2026-11-25')).toBe(true);
    expect(result.rows[0]).not.toHaveProperty('adminToken');
  });
  it('retains an all-pending training list and does not call its handling grid',async()=>{
    const requestTrainingList=vi.fn(async(params:Record<string,unknown>)=>String(params.confid).includes('bljdcxjglb')?{total:1,rows:[progress('P','BT_SL')]}:{total:0,rows:[]});
    const result=await queryHrssLedger({request:vi.fn(),prepareTrainingSession:vi.fn(async()=>session),requestTrainingList},definition('startup-training'),selected,now);
    expect(result.rows).toEqual([expect.objectContaining({caseId:'P',applyBh:'APPLY-P',currentLink:'待受理',handlingRecordCount:0,handlingRecordStatus:'skipped-pending',handlingRecords:[]})]);
    expect(requestTrainingList).toHaveBeenCalledTimes(2);expect(requestTrainingList.mock.calls.every(([params])=>params.confid!==HRSS_TRAINING_HANDLING_CONFIG)).toBe(true);
  });
  it('aborts before list reads if cancellation occurs while preparing the independent session',async()=>{
    const controller=new AbortController(),request=vi.fn(),requestTrainingList=vi.fn();
    const prepareTrainingSession=vi.fn(async()=>{controller.abort();return session;});
    await expect(queryHrssLedger({request,requestTrainingList,prepareTrainingSession},definition('startup-training'),{...selected,signal:controller.signal},now)).rejects.toMatchObject({code:'TASK_CANCELLED'});
    expect(requestTrainingList).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
  });
  it('does not return a partial batch if the completed list fails after progress records were collected',async()=>{
    const requestTrainingList=vi.fn(async(params:Record<string,unknown>)=>{
      if(params.confid===HRSS_TRAINING_HANDLING_CONFIG) return {total:1,rows:[log]};
      if(String(params.confid).includes('bljdcxjglb')) return {total:1,rows:[progress('A','BT_SH')]};
      throw new Error('已办业务列表读取失败');
    });
    await expect(queryHrssLedger({request:vi.fn(),prepareTrainingSession:vi.fn(async()=>session),requestTrainingList},definition('startup-training'),selected,now)).rejects.toThrow('已办业务列表读取失败');
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
  it('sends the selected dates to all 15 verified original matters and retains their fixed filters',async()=>{
    const expected:Record<string,Record<string,unknown>>={
      'employment-difficulty-recognition':{cdc138Begin:'2020-01-01',cdc138End:'2020-01-31',cdc135:'163374'},
      'graduate-tracking-service':{bae003:['2020-01-01 00:00:00','2020-01-31 23:59:59'],bdca42:'101'},
      'difficult-tracking-service':{bae003:['2020-01-01 00:00:00','2020-01-31 23:59:59'],bdca42:'102'},
      'unemployment-tracking-service':{bae003:['2020-01-01 00:00:00','2020-01-31 23:59:59'],bdca42:'103'},
    };
    const verified=originalMatters().filter(m=>!['unemployment','poverty-alleviation-personnel','one-time-job-expansion-subsidy'].includes(m.id));
    expect(verified).toHaveLength(15);
    for(const matter of verified){
      const request=vi.fn(async()=>({total:0,rows:[]}));
      await queryHrssLedger({request},matter,{...context,filters:{startDate:'2020-01-01',endDate:'2020-01-31'}},now);
      for(const call of request.mock.calls as unknown as [HrssListSource,Record<string,unknown>][]) {
        const [source,params]=call;
        const range=matter.id==='youth-internship-agreement'&&source.id==='registration'
          ? {bae062s:'2020-01-01',bae062e:'2020-01-31',bae001:'163374'}
          : ['youth-internship-agreement','youth-internship-unit'].includes(matter.id)
            ? {cdc111Start:'2020-01-01',cdc111End:'2020-01-31',bae001:'163374'}
            : expected[matter.id]??{adc705Begin:'2020-01-01',adc705End:'2020-01-31'};
        expect(params).toMatchObject({...source.params,...range});
        expect(params).not.toHaveProperty('startDate');expect(params).not.toHaveProperty('endDate');
      }
    }
  });
  it('does not ignore the selected interval for tracking and includes the entire end day',async()=>{
    const request=vi.fn(async()=>({total:0,rows:[]}));
    await queryHrssLedger({request},definition('unemployment-tracking-service'),{...context,filters:{startDate:'2024-02-29',endDate:'2024-02-29'}},now);
    expect((request.mock.calls as any)[0][1]).toMatchObject({bae003:['2024-02-29 00:00:00','2024-02-29 23:59:59'],pagenum:1,pagesize:200});
  });
  it('queries the poverty original list without sending unverified date conditions',async()=>{
    const request=vi.fn(async(_source:HrssListSource,_params:Record<string,unknown>)=>({total:0,rows:[]}));
    const result=await queryHrssLedger({request},definition('poverty-alleviation-personnel'),{...context,filters:{startDate:'2026-11-01',endDate:'2026-11-04'}},now);
    expect(result.total).toBe(0);expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toEqual({current:1,size:200});
  });
  it('uses the same month default when a legacy caller omits date selection',async()=>{
    const request=vi.fn(async()=>({total:0,rows:[]}));
    await queryHrssLedger({request},definition('difficult-flexible-employment-subsidy'),context,now);
    expect((request.mock.calls as any)[0][1]).toMatchObject({adc953:'LHJYBT_10',adc705Begin:'2026-11-01',adc705End:'2026-11-04'});
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
  it('defaults an unemployment query without date selection to this month while still querying one day at a time',async()=>{
    const request=vi.fn(async(_source:HrssListSource,_params:Record<string,unknown>,_signal?:AbortSignal,_countOnly?:boolean)=>({total:0,rows:[]}));
    await queryHrssLedger({request},definition('unemployment'),context,now);
    expect(request.mock.calls.map(c=>c[1])).toEqual(['01','02','03','04'].map(day=>expect.objectContaining({bce089Start:`2026-11-${day}`,bce089End:`2026-11-${day}`})));
    expect(request.mock.calls.every(c=>c[3]===true)).toBe(true);
  });
  it('queries unemployment per day with original parameters and only count/list routes',async()=>{
    const request=vi.fn(async(_source,_params,_signal,countOnly)=>({total:countOnly?1:1,rows:countOnly?[]:[raw('SAME-ACCEPTANCE')]}));
    const result=await queryHrssLedger({request},definition('unemployment'),{...context,filters:{startDate:'2026-11-03',endDate:'2026-11-04'}},now);
    expect(request).toHaveBeenCalledTimes(4);expect(result.rows).toHaveLength(1);
    expect(request.mock.calls[0][1]).toEqual({bce089Start:'2026-11-03',bce089End:'2026-11-03',aac004:'',bae085:'01',bae001:'163374',bbd068:'01'});
    expect(request.mock.calls[2][1].bce089Start).toBe('2026-11-04');
    expect(request.mock.calls.every(c=>c[0].path.endsWith('/jysyxxcx/syxx/page'))).toBe(true);
  });
  it.each([false,true])('upserts repeated acceptance numbers with the last returned fields (across pages: %s)',async(acrossPages)=>{
    const first=acrossPages?Array.from({length:200},(_,i)=>raw('ACCEPTANCE-'+i)):[{...raw('ACCEPTANCE-17'),boe017Name:'新办'}];
    const next={...raw('ACCEPTANCE-17'),bce324:'CHANGED-ROW-ID',boe017Name:'注销'};
    const total=acrossPages?201:2;
    const request=vi.fn(async(_source,params,_signal,countOnly)=>({total,rows:countOnly?[]:acrossPages?(params.current===1?first:[next]):[...first,next]}));
    const result=await queryHrssLedger({request},definition('unemployment'),{...context,filters:{startDate:'2026-11-01',endDate:'2026-11-01'}},now);
    expect(result.total).toBe(acrossPages?200:1);
    expect(result.rows.filter(r=>r.slbh==='ACCEPTANCE-17')).toEqual([expect.objectContaining({applyType:'注销'})]);
    expect(request).toHaveBeenCalledTimes(acrossPages?3:2);
    expect(request.mock.calls.every(c=>c[1].aac004===''&&!Object.hasOwn(c[1],'bcc354'))).toBe(true);
  });
  it('accepts an entirely repeated page and reports the actual deduplicated row count',async()=>{
    const records=Array.from({length:200},(_,i)=>raw('A-'+i));
    const request=vi.fn(async(_source,_params,_signal,countOnly)=>({total:400,rows:countOnly?[]:records}));
    const progress=vi.fn();
    const result=await queryHrssLedger({request},definition('unemployment'),{...context,filters:{startDate:'2026-11-02',endDate:'2026-11-02'},onProgress:progress},now);
    expect(result.total).toBe(200);expect(request).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenLastCalledWith({current:200,total:200,message:expect.stringContaining('实际获取 400 条，合并重复 200 条')});
  });
  it('uses count only to plan pages and does not stop after an unexpectedly short or empty page',async()=>{
    const request=vi.fn(async(_source,params,_signal,countOnly)=>({total:countOnly?401:999,rows:countOnly||params.current===2?[]:[raw('PAGE-'+params.current)]}));
    const result=await queryHrssLedger({request},definition('unemployment'),{...context,filters:{startDate:'2026-11-02',endDate:'2026-11-02'}},now);
    expect(result.total).toBe(2);expect(result.pageSize).toBe(2);
    expect(request.mock.calls.filter(c=>!c[3]).map(c=>c[1].current)).toEqual([1,2,3]);
  });
  it('retains all valid returned rows when count underestimates the actual first page',async()=>{
    const request=vi.fn(async(_source,_params,_signal,countOnly)=>({total:1,rows:countOnly?[]:Array.from({length:200},(_,i)=>raw('A-'+i))}));
    const result=await queryHrssLedger({request},definition('unemployment'),{...context,filters:{startDate:'2026-11-02',endDate:'2026-11-02'}},now);
    expect(result.total).toBe(200);expect(request).toHaveBeenCalledTimes(2);
  });
  it('skips blank acceptance numbers like the legacy collector and reports them without blocking valid rows',async()=>{
    const request=vi.fn(async(_source,_params,_signal,countOnly)=>({total:4,rows:countOnly?[]:[{...raw('BLANK'),bce076:' '},{...raw('MISSING'),bce076:undefined},raw('A'),{...raw('A'),bce324:undefined,boe017Name:'注销'}]}));
    const progress=vi.fn();
    const result=await queryHrssLedger({request},definition('unemployment'),{...context,filters:{startDate:'2026-11-02',endDate:'2026-11-02'},onProgress:progress},now);
    expect(result.rows).toEqual([expect.objectContaining({slbh:'A',applyType:'注销'})]);
    expect(progress).toHaveBeenLastCalledWith({current:1,total:1,message:expect.stringContaining('实际获取 4 条，合并重复 1 条，跳过空受理编号 2 条')});
  });
  it('upserts the same acceptance number across days and repeated local imports instead of inserting another row',async()=>{
    const repository=new MemoryLocalRepository(),engine=new DefaultLocalSyncEngine(repository);
    let revised=false;
    const request=vi.fn(async(_source,params,_signal,countOnly)=>({total:2,rows:countOnly?[]:[{...raw('A'),bce324:'REG-'+params.bce089Start,boe017Name:params.bce089Start==='2026-11-02'||revised?'注销':'新办'},raw('B')]}));
    const selected={...context,filters:{startDate:'2026-11-01',endDate:'2026-11-02'}};
    const first=await queryHrssLedger({request},definition('unemployment'),selected,now);
    expect(first.rows).toHaveLength(2);expect(first.rows.find(r=>r.slbh==='A')?.applyType).toBe('注销');
    const initial=await engine.preview('guangdong-hrss','unemployment',['recordKey'],first.rows);
    expect(initial).toMatchObject({inserted:2});await engine.commit('guangdong-hrss','unemployment',initial);
    revised=true;const repeat=await queryHrssLedger({request},definition('unemployment'),selected,now);
    expect(await engine.preview('guangdong-hrss','unemployment',['recordKey'],repeat.rows)).toMatchObject({total:2,inserted:0,unchanged:2});
    const changed=repeat.rows.map(row=>row.slbh==='A'?{...row,applyType:'更正'}:row);
    const update=await engine.preview('guangdong-hrss','unemployment',['recordKey'],changed);
    expect(update).toMatchObject({inserted:0,updated:1,unchanged:1});
  });
  it('still stops on a real list request failure or cancellation rather than returning a successful partial batch',async()=>{
    const source=definition('unemployment');
    const request=vi.fn(async(_source,_params,_signal,countOnly)=>{if(countOnly)return {total:201,rows:[]};throw new Error('session expired')});
    await expect(queryHrssLedger({request},source,{...context,filters:{startDate:'2026-11-02',endDate:'2026-11-02'}},now)).rejects.toThrow('session expired');
    expect(request).toHaveBeenCalledTimes(2);
    const controller=new AbortController();const cancelled=vi.fn(async(_source,_params,_signal,countOnly)=>{if(!countOnly)controller.abort();return {total:1,rows:countOnly?[]:[raw('A')]}});
    await expect(queryHrssLedger({request:cancelled},source,{...context,filters:{startDate:'2026-11-02',endDate:'2026-11-02'},signal:controller.signal},now)).rejects.toMatchObject({code:'TASK_CANCELLED'});
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


describe('人社超时重试耗尽后继续有效请求',()=>{
  const exhausted=()=>new AppError('REMOTE_TIMEOUT','已尝试5次',{attempts:5,exhausted:true});
  it('skips a timed-out day count and list page, then keeps later days and pages',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try{
      const request=vi.fn(async(_source,params,_signal,countOnly)=>{
        if(params.bce089Start==='2026-11-01'||params.bce089Start==='2026-11-02'&&params.current===2)throw exhausted();
        return {total:params.bce089Start==='2026-11-02'?401:1,rows:countOnly?[]:[raw(params.bce089Start+'-'+params.current)]};
      });
      const progress=vi.fn();const result=await queryHrssLedger({request},definition('unemployment'),{...context,filters:{startDate:'2026-11-01',endDate:'2026-11-03'},onProgress:progress},now);
      expect(result).toMatchObject({total:3,skippedRequestCount:2});
      expect(request.mock.calls.filter(c=>!c[3]).map(c=>[c[1].bce089Start,c[1].current])).toEqual([['2026-11-02',1],['2026-11-02',2],['2026-11-02',3],['2026-11-03',1]]);
      expect(progress.mock.lastCall?.[0].message).toContain('本批次结果含缺项');expect(warn).toHaveBeenCalledTimes(2);
    }finally{warn.mockRestore()}
  });
  it('keeps the expected page offsets after a timed-out middle page in a normal ledger',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try{
      const request=vi.fn(async(_source,params)=>{if(params.current===2)throw exhausted();return {total:601,rows:Array.from({length:params.current===4?1:200},(_,i)=>raw(params.current+'-'+i))}});
      const result=await queryHrssLedger({request},definition('job-seeking-startup-subsidy'),context,now);
      expect(result).toMatchObject({total:401,skippedRequestCount:1});expect(request.mock.calls.map(c=>c[1].current)).toEqual([1,2,3,4]);
    }finally{warn.mockRestore()}
  });
  it('continues a second source when the first list cannot provide a total after five timeouts',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try{
      const request=vi.fn(async(source)=>{if(source.id==='review')throw exhausted();return {total:1,rows:[raw('B')]}});
      const result=await queryHrssLedger({request},definition('youth-internship-unit'),context,now);
      expect(result).toMatchObject({total:1,skippedRequestCount:1});expect(result.rows[0].listSource).toBe('查询列表');expect(request).toHaveBeenCalledTimes(2);
    }finally{warn.mockRestore()}
  });
  it('skips a case with timed-out handling records without blocking later cases or inventing empty histories',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try{
      const request=vi.fn(async()=>({total:2,rows:['A','B'].map(id=>({...raw(id),bbe955:'03',bbe955Name:'待审核',bzd417:'FLOW-'+id}))}));
      const requestHandlingRecords=vi.fn(async(params)=>{if(params.bzd417==='FLOW-A')throw exhausted();return {total:0,rows:[]}});
      const result=await queryHrssLedger({request,requestHandlingRecords},definition('enterprise-hiring-difficult-personnel-subsidy'),context,now);
      expect(result).toMatchObject({total:1,skippedRequestCount:1});expect(result.rows[0]).toMatchObject({applyBh:'B',handlingRecordStatus:'collected',handlingRecordCount:0});
      expect(requestHandlingRecords).toHaveBeenCalledTimes(2);expect(JSON.stringify(warn.mock.calls)).not.toContain('FLOW-A');
    }finally{warn.mockRestore()}
  });
  it('records a training bootstrap timeout and does not issue unauthenticated training list calls',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try{
      const request=vi.fn(),requestTrainingList=vi.fn(),prepareTrainingSession=vi.fn(async()=>{throw exhausted()});
      const result=await queryHrssLedger({request,requestTrainingList,prepareTrainingSession},definition('startup-training'),context,now);
      expect(result).toMatchObject({rows:[],total:0,skippedRequestCount:1});expect(request).not.toHaveBeenCalled();expect(requestTrainingList).not.toHaveBeenCalled();
    }finally{warn.mockRestore()}
  });
  it('does not skip an unexhausted timeout or a real session error',async()=>{
    for(const code of ['REMOTE_TIMEOUT','SESSION_EXPIRED'] as const){
      const error=new AppError(code,'未到重试上限或会话失效');const request=vi.fn(async()=>{throw error});
      await expect(queryHrssLedger({request},definition('unemployment'),{...context,filters:{startDate:'2026-11-02',endDate:'2026-11-02'}},now)).rejects.toBe(error);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
});
