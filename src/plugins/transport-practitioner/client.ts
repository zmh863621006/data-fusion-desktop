import { constants, publicEncrypt } from 'node:crypto';
import { AppError } from '../../core/errors/app-error';
import { RequestGate } from '../../core/network/request-policy';

export const PRACTITIONER_BASE_URL = 'https://td.gd.gov.cn/cyry/';
export const PRACTITIONER_GATEWAY_URL = `${PRACTITIONER_BASE_URL}api/ServiceGateway/DataService`;
export const PRACTITIONER_PAGE_URL = `${PRACTITIONER_BASE_URL}default/index`;
export const PRACTITIONER_HOME_URL = `${PRACTITIONER_BASE_URL}index.html`;
export const PRACTITIONER_PARTITION = 'persist:transport-practitioner';
const SYSTEM_ID = '4BCCE78E-B253-4AC6-883F-423E3846FFEC';
const PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxRuke17d42dGsa8FzqLEl65pWepmHjDYVsBrglzUOEbVRpLAgbNfGB3Tz/r2DpRY/TaMv3/kxCU6yw379o20+32j8TzliKiWkGA8Id7fTQeibTkUQG8jAFN8faKgOFFL0gnK8eS6EOzWwdUygtfhufAvnAUsKUV4EtCbIFv2swpA/ayz4CyFv908dXJfc4XfOxEymPVPCGEOjJiLEvUr7p9l5diIMB3EggTal1cvC8sYj3sxP+C1Z6+YTiVDI+gZZrgV1yVmIXEdI+59AU6ymb7G3hAhzCYK/MFTuop/btIDa0oIBYho5oR96L5L5Qr4EVEQ36p2N3cmoXsQsAx9bwIDAQAB';

export type PractitionerCategory = 'road' | 'taxi';

export interface ArchivePage {
  items: Record<string, unknown>[];
  total: number;
}

function requestTime(now = new Date()): string {
  const part = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}${part(now.getMilliseconds(), 3)}`;
}

function publicRequest(servicecode: string) {
  return {
    sysid: SYSTEM_ID,
    reqid: crypto.randomUUID().toUpperCase(),
    servicecode,
    protover: '1.0',
    servicever: '1.0',
    requesttime: requestTime(),
    signdata: '',
    reserve: '',
  };
}

function parseJsonLayer(value: unknown): unknown {
  let current = value;
  for (let index = 0; index < 5; index += 1) {
    if (typeof current === 'string') {
      const text = current.trim();
      try { current = JSON.parse(text); continue; } catch {
        try { current = JSON.parse(text.replace(/\\"/g, '"').replace(/^"|"$/g, '')); continue; } catch { return current; }
      }
    }
    if (current && typeof current === 'object' && 'data' in current) {
      const data = (current as { data?: unknown }).data;
      if (data && typeof data === 'object' && 'string' in data) {
        current = (data as { string?: unknown }).string;
        continue;
      }
    }
    break;
  }
  return current;
}

export function parseGatewayResponse(raw: string): Record<string, unknown> {
  const parsed = parseJsonLayer(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('REMOTE_REQUEST_FAILED', '从业人员系统返回了无法识别的报文');
  }
  return parsed as Record<string, unknown>;
}

function bodyObject(root: Record<string, unknown>): Record<string, unknown> {
  const body = parseJsonLayer(root.body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('REMOTE_REQUEST_FAILED', '从业人员系统返回报文缺少业务数据');
  }
  return body as Record<string, unknown>;
}

function pemPublicKey(): string {
  return `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;
}

export class PractitionerClient {
  private readonly requestGate = new RequestGate({ timeoutMs: 60_000, maxAttempts: 2, retryDelayMs: 1_000, minimumIntervalMs: 250 });
  private token = process.env.DATA_FUSION_PRACTITIONER_TOKEN?.trim() ?? '';
  private expiresAt = this.token ? Date.now() + 2 * 60 * 60 * 1000 : undefined;
  private configuredCredentials?: { account: string; password: string };

  configureCredentials(credentials: { account: string; password: string } | null): void {
    this.configuredCredentials = credentials ?? undefined;
    this.clearSession();
  }

  isAuthenticated(): boolean {
    return /^[0-9a-f-]{36}$/i.test(this.token) && (this.expiresAt === undefined || this.expiresAt > Date.now());
  }

  sessionExpiresAt(): number | undefined {
    return this.expiresAt;
  }

  exportSession(): Record<string, unknown> | null { return this.token ? { token: this.token } : null; }
  restoreSession(value: Record<string, unknown>): void {
    if (typeof value.token === 'string' && /^[0-9a-f-]{36}$/i.test(value.token)) {
      this.token = value.token; this.expiresAt = 0;
    }
  }
  async validateSession(signal: AbortSignal): Promise<{ displayName: string }> {
    if (!this.token) throw new AppError('SESSION_EXPIRED', '从业人员会话不存在');
    const today = new Date().toISOString().slice(0, 10);
    const root = await this.postGateway({ publicrequest: publicRequest('007400100021'), body: {
      Page: 1, Rows: 1, data: { XingMing: '', XingBie: '', ZhengJianLeiXing: '', ZhengJianHaoMa: '', CongYeZiGeZhengHao: '',
        XiaQuShi: '惠州', ZhuangTai: '0', CongYeRenYuanDangAnHao: '', FaZhengRiQiCong: today, FaZhengRiQiZhi: today, CongYeZiGeLeiBie: '' },
    } }, signal, this.token);
    const statusCode = (root.publicresponse as { statuscode?: unknown } | undefined)?.statuscode;
    if (Number(statusCode) === 401 || Number(statusCode) === 403) throw new AppError('SESSION_EXPIRED', '从业人员会话已失效');
    if (statusCode !== undefined && Number(statusCode) !== 0) throw new AppError('REMOTE_REQUEST_FAILED', '从业人员会话验证未获成功响应');
    const body = bodyObject(root);
    if (!Array.isArray(body.items) || !Number.isFinite(Number(body.totalcount))) {
      throw new AppError('REMOTE_REQUEST_FAILED', '从业人员会话验证响应无法确认');
    }
    this.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
    return { displayName: '省从业人员平台会话' };
  }

  acceptBrowserToken(token: string): void {
    if (!/^[0-9a-f-]{36}$/i.test(token)) return;
    this.token = token;
    this.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
  }

  clearSession(): void {
    this.token = '';
    this.expiresAt = undefined;
  }

  async login(): Promise<void> {
    const configuredToken = process.env.DATA_FUSION_PRACTITIONER_TOKEN?.trim();
    if (configuredToken && /^[0-9a-f-]{36}$/i.test(configuredToken)) {
      this.token = configuredToken;
      this.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
      return;
    }
    const account = this.configuredCredentials?.account.trim() || process.env.DATA_FUSION_PRACTITIONER_ACCOUNT?.trim();
    const password = this.configuredCredentials?.password || process.env.DATA_FUSION_PRACTITIONER_PASSWORD;
    const ocrUrl = process.env.DATA_FUSION_PRACTITIONER_OCR_URL?.trim();
    if (!account || !password || !ocrUrl) {
      throw new AppError('SYSTEM_LOGIN_REQUIRED', '从业人员系统尚未配置登录凭据和验证码识别服务');
    }

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const sessionId = crypto.randomUUID().toUpperCase();
      const captchaRoot = await this.postGateway({ publicrequest: publicRequest('00000030011'), body: sessionId });
      const image = typeof captchaRoot.body === 'string' ? captchaRoot.body : '';
      if (!image) continue;
      const code = await this.recognizeCaptcha(ocrUrl, image);
      if (!code) continue;
      const plaintext = JSON.stringify({ SysId: SYSTEM_ID, AccountName: account, Password: password, SessionId: sessionId, Code: code });
      const encrypted = publicEncrypt({ key: pemPublicKey(), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(plaintext)).toString('base64');
      const loginRoot = await this.postGateway({ publicrequest: publicRequest('007400100999'), body: encrypted });
      const candidate = typeof loginRoot.body === 'string' ? loginRoot.body.trim() : '';
      if (/^[0-9a-f-]{36}$/i.test(candidate)) {
        this.token = candidate;
        this.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
        return;
      }
    }
    throw new AppError('SYSTEM_LOGIN_REQUIRED', '从业人员系统登录失败，验证码连续识别失败或账号配置无效');
  }

  async fetchArchivePage(
    category: PractitionerCategory,
    startDate: string,
    endDate: string,
    page: number,
    pageSize: number,
    outerSignal?: AbortSignal,
  ): Promise<ArchivePage> {
    if (!this.isAuthenticated()) throw new AppError('SESSION_EXPIRED', '从业人员系统会话已失效，请重新连接');
    const serviceCode = category === 'road' ? '007400100021' : '007400100059';
    const payload = {
      publicrequest: publicRequest(serviceCode),
      body: {
        Page: page,
        Rows: pageSize,
        data: {
          XingMing: '', XingBie: '', ZhengJianLeiXing: '', ZhengJianHaoMa: '', CongYeZiGeZhengHao: '',
          XiaQuShi: '惠州', ZhuangTai: '0', CongYeRenYuanDangAnHao: '',
          FaZhengRiQiCong: startDate, FaZhengRiQiZhi: endDate, CongYeZiGeLeiBie: '',
        },
      },
    };
    const root = await this.postGateway(payload, outerSignal, this.token);
    const body = bodyObject(root);
    const items = Array.isArray(body.items)
      ? body.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
    const numericTotal = Number(body.totalcount);
    return { items, total: Number.isFinite(numericTotal) && numericTotal >= 0 ? numericTotal : items.length };
  }

  private async recognizeCaptcha(url: string, image: string): Promise<string> {
    return this.requestGate.execute(async (signal) => {
      const response = await fetch(url, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }),
      });
      if (!response.ok) throw new AppError('REMOTE_REQUEST_FAILED', `验证码识别服务请求失败（${response.status}）`);
      const value = await response.json() as { code?: unknown };
      return typeof value.code === 'string' ? value.code.trim() : '';
    });
  }

  private async postGateway(payload: unknown, outerSignal?: AbortSignal, token?: string): Promise<Record<string, unknown>> {
    return this.requestGate.execute(async (signal) => {
      const response = await fetch(PRACTITIONER_GATEWAY_URL, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(token ? { token } : {}),
        },
        body: `=${encodeURIComponent(JSON.stringify(payload))}`,
      });
      if (response.status === 401 || response.status === 403) {
        throw new AppError('SESSION_EXPIRED', '从业人员系统会话已失效');
      }
      if (!response.ok) throw new AppError('REMOTE_REQUEST_FAILED', `从业人员系统请求失败（${response.status}）`);
      return parseGatewayResponse(await response.text());
    }, outerSignal);
  }
}
