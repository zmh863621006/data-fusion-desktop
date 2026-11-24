import catalog from './matter-catalog.json';

export const ONE_WINDOW_SYSTEM_ID = catalog.id;
export const ONE_WINDOW_SYSTEM_NAME = catalog.name;
export const ONE_WINDOW_VERSION = catalog.version;
export const ONE_WINDOW_MATTERS = catalog.matters;
export const ONE_WINDOW_ORIGIN = 'http://10.248.79.52';
export const ONE_WINDOW_LOGIN_URL = ONE_WINDOW_ORIGIN + '/Accept/login';
export const ONE_WINDOW_HOME_URL = ONE_WINDOW_ORIGIN + '/Accept/index?recRes=true';
export const ONE_WINDOW_PARTITION = 'persist:shenzhen-one-window';
export const ONE_WINDOW_LIST_PATH = '/Accept/accept/monitor/allbusiness/queryAll';
export const ONE_WINDOW_WORKSPACE_PATH = '/Accept/accept/monitor/allbusiness/allbusi';
export const ONE_WINDOW_MAX_RECORDS = 50_000;

export interface OneWindowMatter { id: string; name: string }

export const ONE_WINDOW_LIST_COLUMNS = [
  { key: 'receiveNumber', label: '受理编号' },
  { key: 'bsnum', label: '办件流水号' },
  { key: 'applicant', label: '申请主体' },
  { key: 'creditCode', label: '统一社会信用代码' },
  { key: 'legalPerson', label: '法定代表人' },
  { key: 'organizationName', label: '办理部门' },
  { key: 'statusLabel', label: '办理状态' },
  { key: 'receivedAt', label: '受理时间' },
  { key: 'finishedAt', label: '办结时间' },
] as const;

export const ONE_WINDOW_STATES = [
  { value: '', label: '全部状态' }, { value: '2', label: '预警' }, { value: '3', label: '超时' },
  { value: '4', label: '已办结' }, { value: '5', label: '未办结' },
  { value: '6', label: '已审核' }, { value: '7', label: '未审核' }, { value: '8', label: '已受理' },
];
