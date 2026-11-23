import catalog from './matter-catalog.json';

export const EQUIPMENT_SYSTEM_ID = catalog.id;
export const EQUIPMENT_SYSTEM_NAME = catalog.name;
export const EQUIPMENT_VERSION = catalog.version;
export const [USE_REGISTRATION, PERSONNEL_ASSESSMENT] = catalog.matters;

export const EQUIPMENT_ORIGIN = 'https://amr.gd.gov.cn';
export const EQUIPMENT_SSO_ORIGIN = 'https://xtbg.gdzwfw.gov.cn';
const PORTAL_PATH = '/tzsbgov/zwfw/';
export const EQUIPMENT_HOME_URL = EQUIPMENT_ORIGIN + PORTAL_PATH;
export const EQUIPMENT_API = EQUIPMENT_HOME_URL + 'api/semms/';
export const EQUIPMENT_LOGIN_URL = EQUIPMENT_SSO_ORIGIN + '/zwrz/login?' + new URLSearchParams({
  appid: 'wl2bee594e73', agentid: '1002048', client_id: 'zwrz_gdtzsb', response_type: 'code', scope: 'all',
  redirect_uri: EQUIPMENT_HOME_URL + 'api/oauth/gov/new/code', pvfm_flag: 'true',
});
export const EQUIPMENT_PARTITION = 'persist:guangdong-special-equipment';

export const DEFAULT_EQUIPMENT_CITY = '441300';
export const EQUIPMENT_CITIES = [
  ['440100', '广州市'], ['440200', '韶关市'], ['440300', '深圳市'], ['440400', '珠海市'], ['440500', '汕头市'],
  ['440600', '佛山市'], ['440700', '江门市'], ['440800', '湛江市'], ['440900', '茂名市'], ['441200', '肇庆市'],
  ['441300', '惠州市'], ['441400', '梅州市'], ['441500', '汕尾市'], ['441600', '河源市'], ['441700', '阳江市'],
  ['441800', '清远市'], ['441900', '东莞市'], ['442000', '中山市'], ['445100', '潮州市'], ['445200', '揭阳市'], ['445300', '云浮市'],
].map(([value, label]) => ({ value, label }));

export function equipmentDate(now: number): string {
  return new Date(now + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

/** Keep only a reusable portal route. OAuth callbacks may contain one-time codes. */
export function equipmentHomeRoute(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.origin !== EQUIPMENT_ORIGIN || url.username || url.password
      || (url.pathname !== PORTAL_PATH.slice(0, -1) && !url.pathname.startsWith(PORTAL_PATH))
      || /^api(?:\/|$)/i.test(url.pathname.slice(PORTAL_PATH.length))) return;
    return url.origin + url.pathname + (/^#\/[\w/-]*$/.test(url.hash) ? url.hash : '');
  } catch { return undefined; }
}
