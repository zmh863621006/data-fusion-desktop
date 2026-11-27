import catalog from './matter-catalog.json';

export const HOUSING_SYSTEM_ID = catalog.id;
export const HOUSING_SYSTEM_NAME = catalog.clientName;
export const HOUSING_VERSION = catalog.version;
export const HOUSING_BINDING_MATTER_ID = catalog.matters[0].id;
export const HOUSING_BINDING_MATTER_NAME = catalog.matters[0].name;
export const HOUSING_ORIGIN = 'https://web.zjj.sz.gov.cn';
export const HOUSING_HOME_URL = `${HOUSING_ORIGIN}/fwzl/LEAP/Login/4403/ZIBNEW/Index.html`;
// Base.js ___logout selects Login.html beside the current Index.html.
export const HOUSING_LOGIN_URL = `${HOUSING_ORIGIN}/fwzl/LEAP/Login/4403/ZIBNEW/Login.html`;
export const HOUSING_RPC_URL = `${HOUSING_ORIGIN}/fwzl/LEAP/Service/RPC/RPC.DO`;
export const HOUSING_PARTITION = 'persist:shenzhen-housing-rental';
