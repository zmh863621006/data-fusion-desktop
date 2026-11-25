import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { BusinessMatter } from '../../core/query/types';
import type { AuthAdapter, SessionState } from '../../core/session/types';
import { observeBrowserAuthMany } from '../../main/browser-auth';
import { HrssClient, type HrssClientOptions } from './client';
import { HRSS_HOME_URL, HRSS_LOGIN_URL, HRSS_MATTER_DEFINITIONS, HRSS_ORIGIN, HRSS_PARTITION, HRSS_SYSTEM_ID } from './catalog';
import { queryHrssLedger } from './query';
import { hrssDateFilter, hrssDefaultDateFilters } from '../../core/hrss/date-filters';
import { hasHrssHandlingRecords } from '../../core/hrss/handling-records';

export { HRSS_SYSTEM_ID, HRSS_MATTER_DEFINITIONS, HRSS_MATTER_BY_ID } from './catalog';
export { HrssClient } from './client';
export type { HrssClientOptions, HrssCredential } from './client';

export function createGuangdongHrssPlugin(options:HrssClientOptions={}):BusinessSystemPlugin {
  const client=new HrssClient(options);
  const state=async():Promise<SessionState>=>client.hasSession()?{systemId:HRSS_SYSTEM_ID,status:'authenticated',displayName:client.hasAccessToken()?'广东人社门户会话':client.hasCookie()?'广东人社一次性扩岗会话':'广东人社创业培训会话',expiresAt:client.sessionExpiresAt()}:{systemId:HRSS_SYSTEM_ID,status:'logged-out'};
  const auth:AuthAdapter={
    getState:state,login:state,logout:()=>client.clearBrowserSession(),
    async getSessionForRequest(){if(!client.hasSession()) throw new Error('请先在原站登录广东人社门户');return {expiresAt:client.sessionExpiresAt(),metadata:{partition:HRSS_PARTITION}};},
  };
  let initialized=false;
  return {
    id:HRSS_SYSTEM_ID,name:'广东省集中式人力资源和社会保障一体化门户系统',version:'0.1.0',
    description:'就业、补贴和街道办业务台账。',workspaceMode:'list-ledger',loginMode:'embedded',auth,
    loginPage:{url:HRSS_LOGIN_URL,partition:HRSS_PARTITION,allowedOrigin:HRSS_ORIGIN},
    sessionRecovery:{snapshot:()=>client.exportSession(),restore:value=>client.restoreSession(value),validate:signal=>client.validateSession(signal),homeUrl:()=>HRSS_HOME_URL},
    matters:[...HRSS_MATTER_DEFINITIONS.map<BusinessMatter>(definition=>({
      id:definition.id,name:definition.name,departmentId:definition.departmentId,departmentName:definition.departmentName,departmentOrder:definition.departmentOrder,matterOrder:definition.matterOrder,
      description:hasHrssHandlingRecords(HRSS_SYSTEM_ID,definition.id)?'按申请日期查询办件，采集非待受理办件的全部办理记录。':'提取原站列表字段；缺失字段保留为空。',executionMode:'one-click-return' as const,
      dateFilter:hrssDateFilter(definition.id),
      querySchema:[{key:'startDate',label:definition.id==='unemployment'?'登记开始日期':'开始日期',type:'date' as const,required:true},
        {key:'endDate',label:definition.id==='unemployment'?'登记结束日期':'结束日期',type:'date' as const,required:true}],
      uniqueKey:['recordKey'],listColumns:definition.columns.map(({key,label,sensitive})=>({key,label,sensitive})),
      createDefaultContext:()=>({page:1,pageSize:200,filters:hrssDefaultDateFilters(definition.id,(options.now??Date.now)())}),
      query:context=>queryHrssLedger(client,definition,context,(options.now??Date.now)()),
    }))],
    async initialize(){
      if(!initialized){
        observeBrowserAuthMany(HRSS_PARTITION,[
          ...['/employment/main/rest/*','/employment/business-tracking/rest/*','/subsidize/main/rest/*'].map(path=>({urlPattern:HRSS_ORIGIN+path,header:'access-token' as const,accept:(value:string)=>client.acceptBrowserAccessToken(value),clear:()=>client.clearAccessToken()})),
          {urlPattern:HRSS_ORIGIN+'/WGBT/*',header:'cookie',accept:value=>client.acceptBrowserCookie(value),clear:()=>client.clearCookie()},
          {urlPattern:HRSS_ORIGIN+'/ZXZJ/*',header:'cookie',accept:value=>client.acceptTrainingCookie(value),clear:()=>client.clearTrainingCookie()},
        ]);
        initialized=true;
      }
    },
    async getSessionState(options){if(options?.force && client.hasAccessToken()) await client.validateSession(new AbortController().signal); return state();},
  };
}
