import catalog from './matter-catalog.json';

export const HAZCHEM_SYSTEM_ID = 'shenzhen-hazardous-chemicals';
export const HAZCHEM_ORIGIN = 'https://szwh.yjgl.sz.gov.cn';
export const HAZCHEM_LOGIN_URL = HAZCHEM_ORIGIN + '/iHome/#/login';
export const HAZCHEM_HOME_URL = HAZCHEM_ORIGIN + '/iHome/';
export const HAZCHEM_PARTITION = 'persist:shenzhen-hazardous-chemicals';
export const HAZCHEM_AUTHORITY = '深圳市南山区应急管理局';
export const HAZCHEM_AUTHORITY_CODE = '11440305MB2D288348';
export const HAZCHEM_MATTERS = catalog;
export type HazardousMatter = typeof catalog[number];
export const HAZCHEM_SERVICES = {
  done: 'szsti.gasstation.ApprHandleLog.selectHandleDoneApprProcessList',
  certificates: 'szsti.gasstation.ElectronicRouting.getElectronicLicenseList',
  report: 'szsti.gasstation.ElectronicRouting.certificationDataReportList',
} as const;
