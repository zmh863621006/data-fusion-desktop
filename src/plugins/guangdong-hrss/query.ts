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
  // Refuse the unverified source before a request, rather than silently fetching its entire ledger.
  if(definition.id==='poverty-alleviation-personnel') hrssListDateParameters(definition.id,definition.sources[0].id,String(dates.startDate),String(dates.endDate));
  const isTraining=definition.id==='startup-training';
  if(isTraining && (!client.prepareTrainingSession || !client.requestTrainingList)) throw invalid('创业培训独立会话查询尚未初始化');
  const trainingSession=isTraining?await client.prepareTrainingSession!(context.signal):undefined;
  checkCancelled(context.signal);
  const trainingClient={requestTrainingList:(params:Record<string,unknown>,signal?:AbortSignal)=>client.requestTrainingList!(params,signal)};
  const result=new Map<string,Record<string,unknown>>();
  const isStreet=Object.hasOwn(HRSS_STREET_PROFILES,definition.id);
  const hasHandling=isStreet||isTraining;
  let fetched=0,requests=0;
  const notify=(message:string,total?:number)=>context.onProgress?.({current:fetched,total,message});
  const processSource=async(source:HrssListSource,overrides:Record<string,unknown>={})=>{
    checkCancelled(context.signal);
    let expected:number|undefined;
    if(source.countPath) {
      const count=await client.request(source,overrides,context.signal,true); expected=count.total; requests++;
      checkCancelled(context.signal);
      if(expected===0) {notify(`${definition.name}：该日期无列表记录`);return;}
    }
    let sourceFetched=0;
    const pageFingerprints=new Set<string>();
    const sourceKeys=new Set<string>();
    for(let page=1;page<=MAX_PAGES;page++) {
      checkCancelled(context.signal);
      if(++requests>MAX_PAGES) throw completeness('回流超过最大分页保护限制');
      const response=source.pagination==='training' && trainingSession
        ? await trainingClient.requestTrainingList(buildTrainingListParameters(source,page,String(dates.startDate),String(dates.endDate),trainingSession),context.signal)
        : await client.request(source,buildHrssListParameters(source,page,now,overrides),context.signal,false,expected);
      checkCancelled(context.signal);
      if(expected===undefined) expected=response.total;
      if(response.total!==expected) throw completeness('回流期间列表总数发生变化，请重新回流');
      if(expected>MAX_ROWS || fetched+response.rows.length>MAX_ROWS) throw completeness('回流超过最大记录保护限制');
      const expectedLength=Math.min(PAGE_SIZE,expected-sourceFetched);
      if(response.rows.length!==expectedLength) throw completeness('列表分页条数与总数不一致');
      const rows=response.rows.map(raw=>projectHrssListRecord(definition,source,source.pagination==='training'?projectTrainingListRecord(source,raw):raw));
      const fingerprint=JSON.stringify(rows.map(row=>row.recordKey));
      if(rows.length && pageFingerprints.has(fingerprint)) throw completeness('远端返回重复分页');
      pageFingerprints.add(fingerprint);
      for(const row of rows) {
        const key=String(row.recordKey);
        if(sourceKeys.has(key)) throw completeness('列表包含重复业务编号，无法确认完整性');
        sourceKeys.add(key);
        const previous=result.get(key);
        if(previous && JSON.stringify(previous)!==JSON.stringify(row)) throw completeness('同一业务编号出现冲突记录');
      }
      // Validate every original list row, including excluded pending cases, before reading handling records.
      for(let index=0;index<rows.length;index++) {
        const row=rows[index];
        if(hasHandling) {
          const handling=isTraining && trainingSession
            ? await enrichTrainingRecord(trainingClient,source,response.rows[index],trainingSession,context.signal)
            : await enrichHrssStreetRecord({requestHandlingRecords:(params,signal)=>{
            if(!client.requestHandlingRecords) throw invalid('街道办办理记录查询尚未初始化');
            return client.requestHandlingRecords(params,signal);
          }},response.rows[index],context.signal);
          checkCancelled(context.signal);
          if(!handling) continue;
          Object.assign(row,handling);
        }
        // Identical natural keys across date partitions are harmless; the stable key never includes query dates.
        result.set(String(row.recordKey),row);
      }
      sourceFetched+=rows.length; fetched+=rows.length;
      notify(`${definition.name}：已获取 ${fetched} 条${hasHandling?`，已保留 ${result.size} 条非待受理办件`:''}`);
      if(sourceFetched===expected) break;
      if(page===MAX_PAGES) throw completeness('列表尚未获取完整');
    }
  };
  if(definition.id==='unemployment') {
    const start=context.filters.startDate??'2025-05-01';
    const end=context.filters.endDate??hrssLocalDate(now);
    if(!validDate(start)||!validDate(end)||start>end) throw invalid('失业登记查询日期范围无效');
    const from=Date.parse(`${start}T00:00:00Z`),to=Date.parse(`${end}T00:00:00Z`);
    if((to-from)/86_400_000>3_660) throw invalid('查询日期范围超过十年，请缩小范围');
    for(let day=from;day<=to;day+=86_400_000) {
      const date=new Date(day).toISOString().slice(0,10);
      await processSource(definition.sources[0],{bce089Start:date,bce089End:date,aac004:'',bae085:'01',bae001:'163374',bbd068:'01'});
    }
  } else for(const source of definition.sources) await processSource(source,hrssListDateParameters(definition.id,source.id,String(dates.startDate),String(dates.endDate)));
  checkCancelled(context.signal);
  const rows=[...result.values()];
  context.onProgress?.({current:rows.length,total:rows.length,message:`${definition.name}：${hasHandling?'列表及办理记录':'列表'}回流完成，共 ${rows.length} 条`});
  return {rows,page:1,pageSize:Math.max(rows.length,1),total:rows.length};
}
