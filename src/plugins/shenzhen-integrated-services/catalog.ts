import type { QueryContext, QueryFieldSchema } from '../../core/query/types';
import catalog from './matter-catalog.json';

export const SHENZHEN_SYSTEM_ID = catalog.id;
export const SHENZHEN_SYSTEM_NAME = catalog.name;
export const SHENZHEN_VERSION = '0.2.0';
export const SHENZHEN_ORIGIN = 'https://61.144.226.148:8001';
export const SHENZHEN_PARTITION = 'persist:' + SHENZHEN_SYSTEM_ID;
export const SHENZHEN_LOGIN_URL = SHENZHEN_ORIGIN + '/cas/login';
export const SHENZHEN_HOME_URL = SHENZHEN_ORIGIN + '/TRANS/zhsl/home';
export const SHENZHEN_MAX_RECORDS = 50_000;
export const SHENZHEN_MAX_HISTORY = 10_000;
export const SHENZHEN_POST_MATTER = 'poverty-alleviation-post-subsidy';
export const SHENZHEN_INSURANCE_MATTER = 'poverty-alleviation-social-insurance-subsidy';

export interface ShenzhenMatter { id: string; name: string; sourceIds: readonly string[]; sourceNames: readonly string[]; description: string }
const definitions: Record<string, { ids: string[]; names: string[] }> = {
  'poverty-alleviation-one-time-employment-subsidy': { ids: ['SX23032116100000002456'], names: ['吸纳脱贫人口一次性就业补贴'] },
  [SHENZHEN_POST_MATTER]: { ids: ['SX23032115100000002453'], names: ['吸纳脱贫人口社保补贴和岗位补贴', '吸纳脱贫人口社保补贴和岗位补贴申领'] },
  [SHENZHEN_INSURANCE_MATTER]: { ids: ['SX23032115100000002453'], names: ['吸纳脱贫人口社保补贴和岗位补贴', '吸纳脱贫人口社保补贴和岗位补贴申领'] },
  'employee-housekeeping-enterprise-filing': { ids: ['SX23032110100000002383'], names: ['员工制家政服务企业备案'] },
  'employee-housekeeping-social-insurance-subsidy': { ids: ['SX23032110100000002394'], names: ['员工制家政服务企业社保补贴'] },
  'small-enterprise-social-insurance-subsidy': { ids: ['SX23032111100000002419'], names: ['小微企业社保补贴申领', '小微企业社保补贴'] },
};
export const SHENZHEN_MATTERS: ShenzhenMatter[] = catalog.matters.map(matter => ({
  ...matter, sourceIds: definitions[matter.id]?.ids ?? [], sourceNames: definitions[matter.id]?.names ?? [matter.name],
  description: [SHENZHEN_POST_MATTER, SHENZHEN_INSURANCE_MATTER].includes(matter.id)
    ? '原系统合并返回社保和岗位补贴，两个入口共用办件及完整办理过程。'
    : '按所选日期获取办件，保留申请、受理、审核等完整办理过程。',
}));

/** Only these two reviewed source aliases share storage; authorization still uses the requested matter. */
export function shenzhenRecordMatterId(systemId: string, matterId: string): string {
  return systemId === SHENZHEN_SYSTEM_ID && matterId === SHENZHEN_POST_MATTER ? SHENZHEN_INSURANCE_MATTER : matterId;
}

export const SHENZHEN_QUERY_SCHEMA: QueryFieldSchema[] = [
  { key: 'dateType', label: '日期类型', type: 'select', required: true, options: [
    { value: 'received', label: '接收时间' }, { value: 'accepted', label: '受理时间' }, { value: 'finished', label: '办结时间' },
  ] },
  { key: 'startDate', label: '开始日期', type: 'date', required: true },
  { key: 'endDate', label: '结束日期', type: 'date', required: true },
];
export function createDefaultShenzhenContext(now = Date.now()): QueryContext {
  const today = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
  return { page: 1, pageSize: 200, filters: { dateType: 'received', startDate: today.slice(0, 7) + '-01', endDate: today } };
}

export const SHENZHEN_LIST_COLUMNS = [
  { key: 'caseNumber', label: '办件编号' }, { key: 'applicationNumber', label: '申办流水号' },
  { key: 'sourceMatterName', label: '事项名称' }, { key: 'scenarioName', label: '情形名称' },
  { key: 'subjectName', label: '申请人／单位名称' }, { key: 'subjectNumber', label: '申请人／单位号码', sensitive: true },
  { key: 'businessState', label: '业务状态' }, { key: 'currentStep', label: '当前环节' },
  { key: 'appliedAt', label: '申请提交时间' }, { key: 'receivedAt', label: '接收时间' },
  { key: 'acceptedAt', label: '受理时间' }, { key: 'finishedAt', label: '办结时间' },
  { key: 'acceptor', label: '业务受理人' }, { key: 'currentAssignee', label: '当前分配人' },
  { key: 'organization', label: '业务经办单位' }, { key: 'handlingRecordCount', label: '办理记录数' },
  { key: 'handlingRecordStatus', label: '办理记录状态' }, { key: 'summary', label: '业务摘要' },
] as const;
