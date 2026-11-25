import catalog from './matter-catalog.json';
import { HRSS_STREET_PROFILES } from './street';
import { HRSS_TRAINING_PROFILE } from './training-catalog';

export const HRSS_SYSTEM_ID = 'guangdong-hrss';
export const HRSS_ORIGIN = 'https://hrss.gdgov.cn';
export const HRSS_PARTITION = 'persist:guangdong-hrss';
/** Source portal login entry confirmed by the user. */
export const HRSS_LOGIN_URL = `${HRSS_ORIGIN}/sso/login.html`;
/** Restore the full authenticated portal; list APIs are only used for session validation. */
export const HRSS_HOME_URL = `${HRSS_ORIGIN}/portal/template/system.html`;

export interface HrssColumn { key: string; label: string; sources: string[]; sensitive?: boolean }
export interface HrssListSource {
  id: string; path: string; method: 'GET' | 'POST';
  pagination?: 'tracking' | 'wgbt' | 'training'; params?: Record<string, unknown>;
  countPath?: string; identity: string[][];
}
export interface HrssMatterDefinition {
  id: string; name: string; departmentId: string; departmentName: string;
  departmentOrder: number; matterOrder: number; columns: HrssColumn[]; sources: HrssListSource[];
}
const sensitiveFields=new Set(['name','cardNumber','birthDate','peopleNumber','registrationNumber','phone','phoneNumber','applyName','applyNumber','applyPhone','handled','servicePeople','servicePeoplePhoneNumber','address','householdRegistrationAddress','permanentResidenceAddress']);
const f = (key: string, label: string, ...sources: string[]): HrssColumn => ({ key, label, sources: sources.length ? sources : [key],...(sensitiveFields.has(key)?{sensitive:true}:{}) });
const person = [f('name','姓名','aac003','aae009'),f('cardType','证件类型','aac058Name'),f('cardNumber','证件号码','aac147'),f('gender','性别','aac004Name')];
// Only list fields confirmed by original Java list builders: education is present in the internship list only.
const demographics = [f('birthDate','出生日期','aac006')];
const unit = [f('unitName','单位名称','aab004'),f('unitNumber','统一社会信用代码','bcea9y')];
const subsidyProcess = [f('applyChannel','申请渠道','bae025Name'),f('applyBh','申请编号','bce097'),f('applyDate','申请日期','adc705'),f('applyAddress','申请地','bdezh2Name'),f('currentLink','当前环节','bbe955Name'),f('examineDateFirst','初审日期','shhzDate'),f('examineDateSeconde','复审日期','sphzDate'),f('payDate','支付日期','bczf52'),f('payStatus','支付状态','bccfa4Name')];
const contact = [f('applyName','经办人','aae004'),f('applyNumber','经办人联系电话','aae005')];
const individualSubsidy = [...person,f('peopleType','人员类型','adc953Name'),f('phone','联系电话','aac067'),...subsidyProcess];
const unemployment = [f('slbh','受理编号','bce076'),...person,...demographics,f('applyDate','登记日期','aab080'),f('unemploymentDate','失业日期','bdz127'),f('applyType','申请类型','boe017Name'),f('registrationType','登记类型','bbd068Name'),f('employmentStatus','就业状态','aac016Name'),f('effectiveFlag','有效标志','bae085Name'),f('nationality','民族','aac005Name'),f('hukouType','户口性质','aac009Name'),f('domicile','户籍所在地','bac300Name'),f('address','常住地址','bac301Name'),f('phone','联系电话','aac067'),f('registrationUnemploymentType','登记失业类型','acc412Name'),f('employmentArea','就业所在地','bdc549Name'),f('registrationArea','登记地区','bae001Name'),f('registrationNumber','就业创业证号','adc001'),f('handled','经办人','bde317Name'),f('handledDate','经办日期','bde371'),f('handledOrg','经办机构','bde372Name')];
const recognition = [f('slbh','受理编号','cdc151'),...person.filter(c=>c.key!=='cardType'),f('rdType','认定类别','bcca2eName'),f('fwOrg','服务机构','cdc135Name'),f('applyType','申请类型','cdc136Name'),f('rdStatus','认定状态','bcca2gName'),f('applyDate','申请日期','cdc138'),f('exitDate','退出日期','bcc091'),f('exitReason','退出原因','bcca2mName'),f('rdDate','认定日期','cde808'),f('shStatus','审核状态','cdc137Name')];
const poverty = [...person.filter(c=>c.key!=='gender'),f('hjdlx','户籍类型','bhe878Name'),f('hjszd','户籍所在地','bac300Name'),f('wgszd','务工所在地','bdca34Name'),f('fwd','服务地','bae001Name'),f('rkdate','入库日期','bae003'),f('gzfwFlag','跟踪服务标志','bccrb3Name'),f('lastdate','最后更新日期','bae005')];
const tracking = [...person.filter(c=>c.key!=='gender'),f('peopleNumber','人员编号','bdzz77'),f('lastGzTime','最近跟踪日期','bae005'),f('belongArea','所属地区','aab301Name'),f('serviceAddress','服务地点','bdzk63Name'),f('serviceCreateTime','服务对象创建日期','bae003'),f('entryServiceSituation','入库服务情况','bdzk69Name'),f('taskStatus','任务状态','bdzz27Name'),f('taskCreateTime','任务创建日期','bdzk68'),f('taskType','任务类型','bdz447Name'),f('serviceType','服务类型','bdca42Name'),f('servicePeople','服务人员','aae011Name'),f('belongServiceOrg','所属服务机构','aaf011'),f('belongLink','所属环节','bze129Name'),f('stationName','站点名称','bcb902'),f('relatedTag','关联标签','portraitLabelNames'),f('relatedServiceConfig','关联服务配置','bze798'),f('servicePeoplePhoneNumber','联系电话','aac067'),f('householdRegistrationArea','户籍地区','bac300Name'),f('householdRegistrationAddress','户籍地址','aac010'),f('permanentResidence','常住地区','bac301Name'),f('permanentResidenceAddress','常住地址','aae006')];
const internshipUnit = [f('unitName','单位名称','aab004'),f('unitCode','单位代码','aab998'),f('unitType','单位类型','bcb609Name'),f('unitAddress','单位地址','aab078Name'),f('workerCount','岗位人数','gwnum'),f('applyBh','申请编号','bce097'),f('applyDate','申请日期','cdc111'),f('applyType','申请类型','bdg069Name'),f('zizhiStatus','资质状态','bdb278Name')];
const internshipAgreement = [f('unitName','单位名称','aab004'),f('unitCode','单位代码','aab998'),f('unitAddress','单位地址','aab078Name'),...person.filter(c=>c.key!=='cardType'),...demographics,f('xueli','学历','aac011Name'),f('biyeYear','毕业年份','bdcz69'),f('peopleType','人员类型','bdczb0Name'),f('workerName','岗位名称','bfe333'),f('applyBh','申请编号','bce097'),f('applyDate','申请日期','cdc111'),f('applyStatus','审核状态','bdczd9Name'),f('startDate','见习开始日期','bae062'),f('endDate','见习结束日期','bbd379'),f('actualEndDate','实际结束日期','bccp16'),f('retention','留用情况','bdczc7Name'),f('currentStatus','当前状态','bdczg9Name'),f('systemFlag','高校毕业生标志','ifCollegeGraduatesName')];
const expansion = [f('btType','补贴类型','_DIC_BCB00J'),f('processArea','办理地区','BAE970'),f('unitName','单位名称','unitName','AAB004','ACTION'),f('applyName','经办人','AAE004'),f('applyPhone','经办人联系电话','AAE005'),f('abnormalOperationFlag','经营异常标志','_DIC_BCBPJ4'),f('applyBh','申请编号','CCD002'),f('applyDate','申请日期','BBB318'),f('applyCount','申请人数','BCBPK9'),f('applyAmount','申请金额','BPD461'),f('currentLink','当前环节','_DIC_BCBPAF'),f('dataOrigin','数据来源','_DIC_BCBPKA')];
const subsidy = (id: string, kind: string, columns: HrssColumn[], params?: Record<string, unknown>) => ({ columns, sources: [{id,path:`/subsidize/main/rest/subsidy/${kind}`,method:'GET' as const,params,identity:[['applyBh']]}] });
const standard = (id: string,path: string,columns: HrssColumn[],identity: string[][],params?: Record<string,unknown>) => ({columns,sources:[{id,path,method:'POST' as const,params,identity}]});
const profiles: Record<string, Pick<HrssMatterDefinition,'columns'|'sources'>> = {
  unemployment:{columns:unemployment,sources:[{id:'unemployment',path:'/employment/main/rest/e/v1/jygl/jysyxxcx/syxx/page',countPath:'/employment/main/rest/e/v1/jygl/jysyxxcx/syxx/page/cnt',method:'GET',identity:[['slbh']]}]},
  'employment-difficulty-recognition':standard('recognition','/employment/main/rest/e/v1/jyyz/jyknry/common/rdsh/list',recognition,[['slbh']],{cdc135:'163374'}),
  'poverty-alleviation-personnel':standard('poverty','/employment/main/rest/e/v1/tprk/tprkdj/list',poverty,[['cardNumber']]),
  'self-employment-identity':subsidy('identity','zzcyrysfhs/progress/page',[...person,f('peopleType','人员类型','adc953Name'),f('phoneNumber','联系电话','aac067'),f('unitName','单位名称','aae009','aab004'),f('unitNumber','统一社会信用代码','bcea9y'),...subsidyProcess.filter(c=>!['examineDateFirst','examineDateSeconde','payDate','payStatus'].includes(c.key))]),
  'job-seeking-startup-subsidy':subsidy('job-seeking','qzcybt/progress/unit/list',[...unit,...contact,...subsidyProcess]),
  'graduate-flexible-employment-subsidy':subsidy('graduate-flexible','lhjybt/progress/person/list',[...individualSubsidy.map(c=>c.key==='name'?f('name','姓名','aae009','aac003'):c),f('subsidyMonth','补贴月份','slMonth'),f('subsidyMonthCount','补贴月数','slMonths')],{adc953:'LHJYBT_20'}),
  'difficult-flexible-employment-subsidy':subsidy('difficult-flexible','lhjybt/progress/person/list',[...individualSubsidy.map(c=>c.key==='name'?f('name','姓名','aae009','aac003'):c),f('subsidyMonth','补贴月份','slMonth'),f('subsidyMonthCount','补贴月数','slMonths')],{adc953:'LHJYBT_10'}),
  'one-time-startup-subsidy':subsidy('startup','ycxcyzz/progress/person/list',[...unit,...individualSubsidy]),
  'startup-rent-subsidy':subsidy('rent','cyzjbt/progress/person/list',[...unit,...individualSubsidy]),
  'startup-employment-subsidy':subsidy('startup-employment','cyddjybt/progress/unit/list',[...unit,...contact,...subsidyProcess,f('applyCount','申请人数','number'),f('applyAmount','申请金额','money'),f('currentAddCount','新增人数','jzrs'),f('currentSuccessCount','审核通过人数','passNumber'),f('currentSuccessAmount','审核通过金额','passMoney')]),
  'employment-internship-subsidy':subsidy('internship-subsidy','jyjxbt/progress/unit/list',[...unit,...contact,...subsidyProcess]),
  'greater-bay-youth-living-subsidy':subsidy('bay-youth','dwqqnjyjhshbz/progress/person/list',individualSubsidy.filter(c=>c.key!=='peopleType').map(c=>c.key==='name'?f('name','姓名','aae009','aac003'):c)),
  'one-time-job-expansion-subsidy':{columns:expansion,sources:[{id:'expansion',path:'/WGBT/gltPage.do',method:'POST',pagination:'wgbt',identity:[['applyBh']]}]},
  // Both original LIST endpoints are retained; the former Java count-only review branch is now a visible list source.
  'youth-internship-agreement':{columns:internshipAgreement,sources:[{id:'review',path:'/employment/main/rest/e/nw/jyjxgl/rybash/list',method:'POST',params:{bae001:'163374'},identity:[['applyBh'],['cardNumber','unitCode','startDate']]},{id:'registration',path:'/employment/main/rest/e/nw/jyjxgl/jxry/list',method:'POST',params:{bae001:'163374'},identity:[['cardNumber','unitCode','startDate'],['applyBh']]}]},
  'youth-internship-unit':{columns:internshipUnit,sources:[{id:'review',path:'/employment/main/rest/e/nw/jyjxgl/dwzzsh/list',method:'POST',params:{bae001:'163374'},identity:[['applyBh']]},{id:'registration',path:'/employment/main/rest/e/nw/jyjxgl/jxdw/list',method:'POST',params:{bae001:'163374'},identity:[['unitCode']]}]},
};
for (const [id,type] of [['graduate-tracking-service','101'],['difficult-tracking-service','102'],['unemployment-tracking-service','103']]) profiles[id]={columns:tracking,sources:[{id:type,path:'/employment/business-tracking/rest/v1/servicetrack/service/subject/manage/queryList',method:'POST',pagination:'tracking',params:{aab301:'163374',bdz30b:'01',bdzz78:'01',bdca42:type,bdzz27List:['01','02','03'],labelType:'all',mergeType:'SERVICE_SUBJECT',serviceSubjectRange:'02'},identity:[['peopleNumber'],['cardNumber']]}]};

export const HRSS_SUBDISTRICT_MATTERS = catalog.filter(meta => meta.departmentId === 'subdistrict-office');
export const HRSS_MATTER_DEFINITIONS: HrssMatterDefinition[] = catalog
  .map(meta=>{const profile=profiles[meta.id]??HRSS_STREET_PROFILES[meta.id]??(meta.id==='startup-training'?HRSS_TRAINING_PROFILE:undefined);
    if(!profile)throw new Error(`缺少人社事项配置：${meta.id}`);
    return {...meta,...profile,columns:[f('listSource','列表来源'),...profile.columns]};});
export const HRSS_MATTER_BY_ID = new Map(HRSS_MATTER_DEFINITIONS.map(definition=>[definition.id,definition]));
