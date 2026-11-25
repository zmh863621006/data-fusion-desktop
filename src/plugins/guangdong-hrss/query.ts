import { createHash } from 'node:crypto';
import { AppError } from '../../core/errors/app-error';
import type { QueryContext, QueryPage } from '../../core/query/types';
import type { HrssClient } from './client';
import type { HrssListSource, HrssMatterDefinition } from './catalog';
import { WGBT_LIST_CONDITION } from './wgbt-condition';
import { hrssDefaultDateFilters, validateHrssDateFilters } from '../../core/hrss/date-filters';
import { hrssListDateParameters } from './date-fields';
import { enrichHrssStreetRecord, HRSS_STREET_PROFILES, type HrssStreetHandlingClient } from './street';
import { buildTrainingListParameters, enrichTrainingRecord, projectTrainingListRecord } from './training';
import { isExhaustedHrssTimeout } from './request-gate';

const PAGE_SIZE=200;
const MAX_ROWS=200_000;
const MAX_PAGES=10_000;
const checkCancelled=(signal?:AbortSignal)=>{if(signal?.aborted) throw new AppError('TASK_CANCELLED','回流任务已取消');};
const invalid=(message:string)=>new AppError('QUERY_INVALID',message);
const completeness=(message:string)=>new AppError('REMOTE_REQUEST_FAILED',`${message}，未保存本次结果`,{retryable:false});
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
export function hrssLocalDate(now:number):string {return new Date(now+8*60*60_000).toISOString().slice(0,10);}
function validDate(value:unknown):value is string {if(typeof value!=='string'||!datePattern.test(value)) return false;const d=new Date(`${value}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;}
function text(value:unknown):string {return typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):typeof value==='boolean'?String(value):'';}
function stripMarkup(value:string):string {return value.replace(/<[^>]*>/g,'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').trim();}

/** No raw record spread: undeclared fields, attachments, server tokens and nested objects are excluded. */
export function projectHrssListRecord(definition:HrssMatterDefinition,source:HrssListSource,raw:Record<string,unknown>):Record<string,unknown> {
  const result:Record<string,unknown>={};
  for(const column of definition.columns) {
    if(column.key==='listSource') continue;
    const candidate=column.sources.find(key=>text(raw[key])!=='');
    result[column.key]=candidate?stripMarkup(text(raw[candidate])):'';
  }
  if(source.pagination==='wgbt' && typeof raw.ACTION==='string' && !text(raw.AAB004) && !text(raw.unitName)) {
    // Original ACTION contains display HTML; keep its visible unit text, never links/scripts.
    result.unitName=stripMarkup(raw.ACTION).replace(/[\r\n\t]+/g,' ').trim();
  }
  const identity=source.identity.find(keys=>keys.every(key=>text(result[key])!=='' && !/[*＊]/.test(text(result[key]))));
  if(!identity) throw completeness('列表记录缺少可稳定识别的业务编号');
  result.recordKey=createHash('sha256').update(JSON.stringify([source.id,...identity.map(key=>[key,text(result[key])])])).digest('hex');
  result.listSource=source.id==='review'?'审核列表':source.id==='registration'?'查询列表':source.id==='training-progress'?'办理进度列表':source.id==='training-completed'?'已办业务列表':'业务列表';
  return result;
}

export function buildHrssListParameters(source:HrssListSource,page:number,now:number,overrides:Record<string,unknown>={}):Record<string,unknown> {
  if(source.pagination==='training') throw invalid('创业培训列表需要独立会话与原站加密查询条件');
  if(source.pagination==='wgbt') return {confid:'bxfh_ycxkgbz_jdcx_bljbcx_blywjdcxjglb',whereCls:WGBT_LIST_CONDITION,rowstart:page,pageSize:PAGE_SIZE};
  if(source.pagination==='tracking') {
    const today=hrssLocalDate(now);
    return {...source.params,bae003:source.params?.bdca42==='103'?[`${today.slice(0,7)}-01 00:00:00`,new Date(now+8*60*60_000).toISOString().slice(0,19).replace('T',' ')]:[null,null],...overrides,pagenum:page,pagesize:PAGE_SIZE};
  }
  return {...source.params,...overrides,current:page,size:PAGE_SIZE};
}

type HrssQueryClient=Pick<HrssClient,'request'> & Partial<HrssStreetHandlingClient> & Partial<Pick<HrssClient,'prepareTrainingSession'|'requestTrainingList'>>;
export async function queryHrssLedger(client:HrssQueryClient,definition:HrssMatterDefinition,context:QueryContext,now=Date.now()):Promise<QueryPage> {
  if(context.page!==1) throw invalid('人社台账一次完整回流，请从第一页开始');
  validateHrssDateFilters(context.filters);
  checkCancelled(context.signal);
  const dates = { ...hrssDefaultDateFilters(definition.id,now), ...context.filters };
  const isTraining=definition.id==='startup-training';
  if(isTraining && (!client.prepareTrainingSession || !client.requestTrainingList)) throw invalid('创业培训独立会话查询尚未初始化');
  const trainingClient={requestTrainingList:(params:Record<string,unknown>,signal?:AbortSignal)=>client.requestTrainingList!(params,signal)};
  const result=new Map<string,Record<string,unknown>>();
  const isStreet=Object.hasOwn(HRSS_STREET_PROFILES,definition.id);
  const hasHandling=isStreet||isTraining;
  let fetched=0,requests=0,duplicates=0,skipped=0,timeoutSkipped=0;
  const notify=(message:string,total?:number)=>context.onProgress?.({current:fetched,total,message});
  const skipTimeout=(error:unknown,label:string)=>{
    checkCancelled(context.signal);
    if(!isExhaustedHrssTimeout(error)) throw error;
    timeoutSkipped++;
    notify(`${label}：请求尝试 5 次仍超时，已跳过，继续回流`);
    console.warn('人社回流跳过超时请求',{matterId:definition.id,scope:label,attempts:5});
  };
  const finish=():QueryPage=>{
    checkCancelled(context.signal);
    const rows=[...result.values()];
    const note=definition.id==='unemployment'?`（实际获取 ${fetched} 条，合并重复 ${duplicates} 条${skipped?`，跳过空受理编号 ${skipped} 条`:''}）`:'';
    const ending=timeoutSkipped?'回流结束':`${hasHandling?'列表及办理记录':'列表'}回流完成`;
    const warning=timeoutSkipped?`；超时请求已尝试 5 次后跳过 ${timeoutSkipped} 项，本批次结果含缺项`:'';
    context.onProgress?.({current:rows.length,total:rows.length,message:`${definition.name}：${ending}，共 ${rows.length} 条${note}${warning}`});
    return {rows,page:1,pageSize:Math.max(rows.length,1),total:rows.length,...(timeoutSkipped?{skippedRequestCount:timeoutSkipped}:{})};
  };
  let trainingSession:Awaited<ReturnType<HrssClient['prepareTrainingSession']>>|undefined;
  if(isTraining) {
    try {trainingSession=await client.prepareTrainingSession!(context.signal);checkCancelled(context.signal);}
    catch(error) {skipTimeout(error,`${definition.name}：读取查询页面`);return finish();}
  }
  const countSource=async(source:HrssListSource,overrides:Record<string,unknown>,label:string)=>{
    checkCancelled(context.signal);
    if(++requests>MAX_PAGES) throw completeness('回流超过最大分页保护限制');
    notify(`${label}：正在查询记录总数`);
    const count=await client.request(source,overrides,context.signal,true);
    checkCancelled(context.signal);
    if(count.total>MAX_ROWS) throw completeness('回流超过最大记录保护限制');
    return count.total;
  };
  const processSource=async(source:HrssListSource,overrides:Record<string,unknown>={})=>{
    checkCancelled(context.signal);
    const label=definition.name;
    let expected:number|undefined;
    if(source.countPath) {
      try {expected=await countSource(source,overrides,label);}
      catch(error) {skipTimeout(error,`${label}：查询总数`);return;}
    }
    if(expected===0) {notify(`${label}：该日期无列表记录`);return;}
    let sourceFetched=0;
    const pageFingerprints=new Set<string>();
    const sourceKeys=new Set<string>();
    for(let page=1;page<=MAX_PAGES;page++) {
      checkCancelled(context.signal);
      if(++requests>MAX_PAGES) throw completeness('回流超过最大分页保护限制');
      notify(`${label}：正在获取第 ${page} 页，已获取 ${fetched} 条`);
      let response:{rows:Record<string,unknown>[];total:number};
      try {
        response=source.pagination==='training' && trainingSession
          ? await trainingClient.requestTrainingList(buildTrainingListParameters(source,page,String(dates.startDate),String(dates.endDate),trainingSession),context.signal)
          : await client.request(source,buildHrssListParameters(source,page,now,overrides),context.signal,false,expected);
      } catch(error) {
        skipTimeout(error,`${label}：第 ${page} 页`);
        // Without the first page's total, only this source can be skipped. Known pages still
        // advance their offset so a timed-out middle page does not corrupt later length checks.
        if(expected===undefined) return;
        sourceFetched+=Math.min(PAGE_SIZE,expected-sourceFetched);
        if(sourceFetched===expected) break;
        continue;
      }
      checkCancelled(context.signal);
      if(expected===undefined) expected=response.total;
      if(response.total!==expected) throw completeness('回流期间列表总数发生变化，请重新回流');
      if(expected>MAX_ROWS || fetched+response.rows.length>MAX_ROWS) throw completeness('回流超过最大记录保护限制');
      const expectedLength=Math.min(PAGE_SIZE,expected-sourceFetched);
      if(response.rows.length!==expectedLength) throw completeness('列表分页条数与总数不一致');
      const rows=response.rows.map(raw=>projectHrssListRecord(definition,source,source.pagination==='training'?projectTrainingListRecord(source,raw):raw));
      const fingerprint=JSON.stringify(rows.map(row=>row.recordKey));
      if(rows.length && pageFingerprints.has(fingerprint)) throw completeness(`${label}第 ${page} 页：远端返回重复分页`);
      pageFingerprints.add(fingerprint);
      for(const row of rows) {
        const key=String(row.recordKey);
        if(sourceKeys.has(key)) throw completeness(`${label}第 ${page} 页：列表包含重复业务编号，无法确认完整性`);
        sourceKeys.add(key);
        const previous=result.get(key);
        if(previous && JSON.stringify(previous)!==JSON.stringify(row)) throw completeness(`${label}第 ${page} 页：同一业务编号出现冲突记录`);
      }
      // Retain pending cases as business rows with no handling requests; validate every list row.
      for(let index=0;index<rows.length;index++) {
        const row=rows[index];
        if(hasHandling) {
          let handling;
          try {
            handling=isTraining && trainingSession
              ? await enrichTrainingRecord(trainingClient,source,response.rows[index],trainingSession,context.signal)
              : await enrichHrssStreetRecord({requestHandlingRecords:(params,signal)=>{
              if(!client.requestHandlingRecords) throw invalid('街道办办理记录查询尚未初始化');
              return client.requestHandlingRecords(params,signal);
            }},response.rows[index],context.signal);
          } catch(error) {
            // A missing history skips that case; it must not overwrite a saved complete history
            // with a fabricated empty log, or prevent later cases from being processed.
            skipTimeout(error,`${label}：办理记录`);
            continue;
          }
          checkCancelled(context.signal);
          Object.assign(row,handling);
        }
        result.set(String(row.recordKey),row);
      }
      sourceFetched+=rows.length; fetched+=rows.length;
      notify(`${label}：已获取 ${fetched} 条${hasHandling?`，已保留 ${result.size} 条办件`:''}`);
      if(sourceFetched===expected) break;
      if(page===MAX_PAGES) throw completeness('列表尚未获取完整');
    }
  };
  if(definition.id==='unemployment') {
    const start=dates.startDate;
    const end=dates.endDate;
    if(!validDate(start)||!validDate(end)||start>end) throw invalid('失业登记查询日期范围无效');
    const from=Date.parse(`${start}T00:00:00Z`),to=Date.parse(`${end}T00:00:00Z`);
    if((to-from)/86_400_000>3_660) throw invalid('查询日期范围超过十年，请缩小范围');
    for(let day=from;day<=to;day+=86_400_000) {
      const date=new Date(day).toISOString().slice(0,10);
      const source=definition.sources[0],label=`${definition.name}（${date}）`;
      const params={bce089Start:date,bce089End:date,aac004:'',bae085:'01',bae001:'163374',bbd068:'01'};
      let referenceTotal:number;
      try {referenceTotal=await countSource(source,params,label);}
      catch(error) {skipTimeout(error,`${label}：查询总数`);continue;}
      // Legacy count only plans the day's pages. Unstable ordering, short pages and duplicate
      // acceptance numbers do not make a successful list response fail the whole date range.
      const pages=Math.ceil(referenceTotal/PAGE_SIZE);
      if(pages===0) notify(`${label}：该日期无列表记录`);
      for(let page=1;page<=pages;page++) {
        checkCancelled(context.signal);
        if(++requests>MAX_PAGES) throw completeness('回流超过最大分页保护限制');
        notify(`${label}：正在获取第 ${page}/${pages} 页，已获取 ${fetched} 条`);
        let response:{rows:Record<string,unknown>[];total:number};
        try {response=await client.request(source,buildHrssListParameters(source,page,now,params),context.signal,false,referenceTotal);}
        catch(error) {skipTimeout(error,`${label}：第 ${page} 页`);continue;}
        checkCancelled(context.signal);
        if(response.rows.length>PAGE_SIZE || fetched+response.rows.length>MAX_ROWS) throw completeness('回流超过最大记录保护限制');
        fetched+=response.rows.length;
        for(const raw of response.rows) {
          // RSAsync.syDataDeal skips blank acceptance numbers; repeated numbers update the row.
          if(!text(raw.bce076)) {skipped++;continue;}
          const row=projectHrssListRecord(definition,source,raw),key=String(row.recordKey);
          if(result.has(key)) duplicates++;
          result.set(key,row);
        }
        notify(`${label}：已获取 ${fetched} 条，按受理编号合并后 ${result.size} 条`);
      }
    }
  } else for(const source of definition.sources) await processSource(source,hrssListDateParameters(definition.id,source.id,String(dates.startDate),String(dates.endDate)));
  return finish();
}
