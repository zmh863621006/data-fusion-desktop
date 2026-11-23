import catalog from './matter-catalog.json';

export const FOOD_DRUG_SYSTEM_ID = catalog.id;
export const FOOD_DRUG_SYSTEM_NAME = catalog.name;
export const FOOD_DRUG_VERSION = catalog.version;
export const [FOOD_PRODUCTION, MEDICAL_DEVICE_OPERATION] = catalog.matters;
export const FOOD_DRUG_ORIGIN = 'https://jg.gdfda.gov.cn';
export const FOOD_DRUG_HOME = FOOD_DRUG_ORIGIN + '/dsxk/framework/ums/main.jsp';
export const FOOD_DRUG_SSO_PATH = '/sso/login';
export const FOOD_DRUG_LOGIN = FOOD_DRUG_ORIGIN + FOOD_DRUG_SSO_PATH + '?' + new URLSearchParams({ service: FOOD_DRUG_HOME });
export const FOOD_DRUG_PARTITION = 'persist:guangdong-food-drug';

export const FOOD_DRUG_LICENSES = [
  { ...FOOD_PRODUCTION, itemType: 'SPSC', workflow: 'SPSC_XKHF', certificateForm: 'form_b_dsxk_spsc_xkzxx', expiry: 'YXQJSRQ' },
  { ...MEDICAL_DEVICE_OPERATION, itemType: 'YLQXJY', workflow: 'QXJY_XKHF', certificateForm: 'form_b_dsxk_qxjy_xkzxx', expiry: 'XKZYXJZRQ' },
] as const;

export type FoodDrugLicense = typeof FOOD_DRUG_LICENSES[number];

export function foodDrugPreviousDay(now = Date.now()): string {
  const shanghaiTime = now + 8 * 3_600_000;
  return new Date(shanghaiTime - 86_400_000).toISOString().slice(0, 10);
}
