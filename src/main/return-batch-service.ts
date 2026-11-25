import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../core/errors/app-error';
import { parseIdentifier, parseQueryContext } from '../core/ipc/validation';
import type { LicenseGrant } from '../core/license/types';
import type { BusinessSystemPlugin } from '../core/plugins/types';
import type { QueryContext } from '../core/query/types';
import { assertMatterQueryAvailable, validateFilters } from '../core/query/validation';
import { hrssReturnDateDetails } from '../core/hrss/date-filters';
import type { ReturnBatchCreated, ReturnBatchInput, ReturnBatchState } from '../core/query/return-batches';
import type { RuntimeTask, TaskContext, TaskEngine } from '../core/tasks/engine';

interface Dependencies {
  plugin(systemId: string): BusinessSystemPlugin | undefined;
  requireLicense(systemId: string, matterId?: string): Promise<LicenseGrant>;
  tasks(): TaskEngine;
  storedTasks(systemId: string, batchId: string): Promise<RuntimeTask[]>;
  execute(systemId: string, matterId: string, context: TaskContext, query: QueryContext): Promise<unknown>;
  audit?(type: 'sync.committed' | 'query.failed', systemId: string, matterId: string, taskId: string): Promise<void>;
}
const invalid = (message: string) => new AppError('QUERY_INVALID', message);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value) ?? 'null';
export const returnTaskFingerprint = (systemId: string, matterId: string, filters: Record<string,unknown>) => createHash('sha256').update(stable([systemId,matterId,filters])).digest('hex');

export function parseReturnBatchInput(value: unknown): ReturnBatchInput {
  if (!object(value) || Object.keys(value).some(key => !['matterIds','startDate','endDate','filtersByMatter'].includes(key))) throw invalid('批量回流参数格式无效');
  if (!Array.isArray(value.matterIds) || !value.matterIds.length || value.matterIds.length > 100) throw invalid('请选择 1 至 100 个业务事项');
  const matterIds=value.matterIds.map(id => parseIdentifier(id,'事项标识'));
  if (new Set(matterIds).size!==matterIds.length) throw invalid('批量回流包含重复事项');
  if (!validDate(value.startDate) || !validDate(value.endDate) || value.startDate>value.endDate) throw invalid('请选择有效的开始、结束日期');
  const filtersByMatter:Record<string,Record<string,unknown>>={};
  if (value.filtersByMatter!==undefined) {
    if (!object(value.filtersByMatter)) throw invalid('事项附加条件格式无效');
    for (const [id,filters] of Object.entries(value.filtersByMatter)) {
      if (!matterIds.includes(id)) throw invalid('附加条件包含未选择的事项');
      filtersByMatter[id]=parseQueryContext({page:1,pageSize:200,filters}).filters;
    }
  }
  return {matterIds,startDate:value.startDate,endDate:value.endDate,filtersByMatter};
}

/** Only task descriptors and query fields are persisted; cookies and source credentials stay in plugins. */
export class ReturnBatchService {
  private submissionTail:Promise<void>=Promise.resolve();
  constructor(private readonly dependencies:Dependencies) {}

  private async serialized<T>(operation:()=>Promise<T>):Promise<T> {
    const previous=this.submissionTail;
    let release!:()=>void;
    this.submissionTail=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    try {return await operation();} finally {release();}
  }

  async submit(systemInput:unknown,input:unknown):Promise<ReturnBatchCreated> {
    const systemId=parseIdentifier(systemInput,'系统标识'),selection=parseReturnBatchInput(input);
    return this.serialized(async()=>{
      const plugin=this.dependencies.plugin(systemId);
      if (!plugin) throw invalid('业务系统不存在');
      await this.dependencies.requireLicense(systemId);
      const problems:string[]=[];
      const plans:Array<{matterId:string;name:string;query:QueryContext;key:string}>=[];
      for (const matterId of selection.matterIds) {
        await this.dependencies.requireLicense(systemId,matterId);
        const matter=plugin.matters.find(item=>item.id===matterId);
        if (!matter) throw invalid('所选业务事项不存在');
        try {
          assertMatterQueryAvailable(matter);
          if (matter.executionMode!=='one-click-return' || !matter.createDefaultContext || systemId==='shenzhen-one-window') throw invalid('当前事项使用独立回流入口');
          const filters={...matter.createDefaultContext().filters,...selection.filtersByMatter?.[matterId],startDate:selection.startDate,endDate:selection.endDate};
          const query=parseQueryContext({page:1,pageSize:200,filters});
          validateFilters(matter.querySchema,query.filters);
          plans.push({matterId,name:matter.name,query,key:returnTaskFingerprint(systemId,matterId,query.filters)});
        } catch(error) {problems.push(`${matter.name}：${error instanceof Error?error.message:'查询条件无效'}`);}
      }
      if (problems.length) throw invalid(problems.join('\n'));
      const active=this.dependencies.tasks().list().filter(task=>task.systemId===systemId && task.type==='data-return' && ['queued','running'].includes(task.status));
      for (const plan of plans) if (active.some(task=>task.matterId===plan.matterId && (task.details?.returnFingerprint===plan.key
        || object(task.details?.returnContext) && object(task.details.returnContext.filters) && returnTaskFingerprint(systemId,plan.matterId,task.details.returnContext.filters)===plan.key))) problems.push(`${plan.name}：相同条件的任务已在队列中`);
      if (problems.length) throw invalid(problems.join('\n'));
      if ((await plugin.getSessionState()).status!=='authenticated') throw new AppError('SYSTEM_LOGIN_REQUIRED','请先登录该业务系统后再批量回流');
      this.dependencies.tasks().resumeSystem(systemId);
      const batchId=randomUUID();
      const created=await this.dependencies.tasks().enqueueBatch(plans.map((plan,index)=>({
        name:`数据回流：${plugin.name} / ${plan.name}`,
        metadata:{type:'data-return',systemId,matterId:plan.matterId,details:{
          ...(systemId==='guangdong-hrss'?hrssReturnDateDetails(plan.matterId,plan.query.filters):{startDate:selection.startDate,endDate:selection.endDate,...(systemId==='government-info'?{dateBasis:'bj_bjsj'}:{})}),
          returnBatchId:batchId,returnBatchOrder:index,returnBatchSize:plans.length,returnFingerprint:plan.key,returnContext:structuredClone(plan.query),
        }},
        executor:async(context:TaskContext)=>{
          try {
            await this.dependencies.requireLicense(systemId,plan.matterId);
            context.signal.throwIfAborted();
            return await this.dependencies.execute(systemId,plan.matterId,context,structuredClone(plan.query));
          }
          catch(error) {
            if (!context.signal.aborted) {
              const state=await plugin.getSessionState().catch(()=>undefined);
              if (state && ['logged-out','expired'].includes(state.status)) this.dependencies.tasks().pauseSystem(systemId,'等待重新登录后继续回流');
            }
            throw error;
          }
        },
      })));
      for (const item of created) void item.completion.then(async task=>{
        try {await this.dependencies.audit?.(task.status==='completed'?'sync.committed':'query.failed',systemId,task.matterId!,task.id);}
        catch {console.warn('批量回流任务审计暂未保存',{systemId});}
      },()=>console.warn('批量回流任务状态未能完整保存',{systemId,taskId:item.task.id}));
      return {batchId,taskIds:created.map(item=>item.task.id),count:created.length};
    });
  }

  async get(systemInput:unknown,batchInput:unknown):Promise<ReturnBatchState> {
    const systemId=parseIdentifier(systemInput,'系统标识'),batchId=parseIdentifier(batchInput,'任务组标识');
    await this.dependencies.requireLicense(systemId);
    const stored=await this.dependencies.storedTasks(systemId,batchId);
    const grant=await this.dependencies.requireLicense(systemId),allowed=grant.allowedMatters?.[systemId];
    const tasks=stored.filter(task=>task.type==='data-return' && task.systemId===systemId && task.details?.returnBatchId===batchId
      && task.matterId && (!allowed || allowed.includes(task.matterId))).map(task=>this.dependencies.tasks().get(task.id)??task);
    if (!tasks.length) throw invalid('回流任务组不存在或当前无权查看');
    const counts={queued:0,running:0,completed:0,failed:0,cancelled:0,total:tasks.length};
    for (const task of tasks) counts[task.status]++;
    return {batchId,systemId,tasks,counts};
  }

  async cancelPending(systemId:unknown,batchId:unknown):Promise<{cancelled:number}> {
    const batch=await this.get(systemId,batchId);
    let cancelled=0;
    for (const task of batch.tasks) if (task.status==='queued') {
      await this.dependencies.requireLicense(batch.systemId,task.matterId);
      if (this.dependencies.tasks().get(task.id)?.status==='queued' && this.dependencies.tasks().cancel(task.id)) cancelled++;
    }
    return {cancelled};
  }

  async retryFailed(systemId:unknown,batchId:unknown):Promise<ReturnBatchCreated> {
    const batch=await this.get(systemId,batchId),failed=batch.tasks.filter(task=>task.status==='failed');
    if (!failed.length) throw invalid('当前任务组没有失败事项');
    const filtersByMatter:Record<string,Record<string,unknown>>={};
    let startDate:string|undefined,endDate:string|undefined;
    for (const task of failed) {
      const query=parseQueryContext(task.details?.returnContext);
      if (!validDate(query.filters.startDate) || !validDate(query.filters.endDate)) throw invalid('原任务日期快照不完整，请重新选择日期回流');
      startDate??=query.filters.startDate;endDate??=query.filters.endDate;
      if (startDate!==query.filters.startDate || endDate!==query.filters.endDate) throw invalid('原任务组的日期快照不一致');
      filtersByMatter[task.matterId!]=query.filters;
    }
    return this.submit(batch.systemId,{matterIds:failed.map(task=>task.matterId!),startDate,endDate,filtersByMatter});
  }

  onSessionState(systemId:string,status:string):void { if (status==='authenticated') this.dependencies.tasks().resumeSystem(systemId); }
}
