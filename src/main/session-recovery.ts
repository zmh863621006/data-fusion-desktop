import { createHash } from 'node:crypto';
import { session, type Cookie, type CookiesSetDetails, type Session } from 'electron';
import { sourceOrigins, type BusinessSystemPlugin } from '../core/plugins/types';
import type { SessionState } from '../core/session/types';
import { AppError } from '../core/errors/app-error';

export interface SessionVault {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  flush(): Promise<void>;
}
interface SavedSession {
  version: 1;
  origin: string;
  api: Record<string, unknown> | null;
  cookies: Cookie[];
  sessionStorage: Record<string, string>;
}
interface Entry {
  plugin: BusinessSystemPlugin;
  browser: Session;
  saved?: SavedSession;
  storage: Record<string, string>;
  generation: number;
  suppressed: boolean;
  awaitingApiLogin?: boolean;
  fingerprint?: string;
  checkedAt: number;
  state?: SessionState;
  pending?: Promise<SessionState>;
  diagnosticKey?: string;
  diagnosticAt?: number;
  writes: Promise<void>;
  listener: () => void;
}

export function cookieInOrigin(cookie: Pick<Cookie, 'domain'>, origin: string): boolean {
  const host = new URL(origin).hostname;
  const domain = cookie.domain?.replace(/^\./, '').toLowerCase();
  return Boolean(domain && (host === domain || host.endsWith(`.${domain}`)));
}

export function restoredCookie(cookie: Cookie, origin: string, now = Date.now()): CookiesSetDetails | null {
  if (!cookieInOrigin(cookie, origin) || !cookie.name || typeof cookie.value !== 'string') return null;
  if (cookie.path && (!cookie.path.startsWith('/') || cookie.path.startsWith('//') || cookie.path.includes('\\'))) return null;
  if (cookie.expirationDate !== undefined && (!Number.isFinite(cookie.expirationDate) || cookie.expirationDate * 1000 <= now)) return null;
  return {
    url: new URL(cookie.path || '/', origin).href, name: cookie.name, value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }), path: cookie.path || '/',
    secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
    // Session cookies stay session cookies; their server-side lifetime is not extended.
    ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
  };
}

function storageValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter(([key, item]) => key.length <= 1024 && typeof item === 'string');
  if (JSON.stringify(entries).length > 1_000_000) return {};
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Coordinates API credentials and browser cookies; only status crosses the IPC boundary. */
export class SessionRecoveryService {
  private readonly entries = new Map<string, Entry>();
  private stopping = false;

  constructor(private readonly vault: SessionVault, private readonly browserFor = (partition: string) => session.fromPartition(partition)) {}
  private key(id: string): string { return `browser-session.v1.${id}`; }

  async register(plugin: BusinessSystemPlugin): Promise<void> {
    if (!plugin.sessionRecovery || !plugin.loginPage) return;
    const browser = this.browserFor(plugin.loginPage.partition);
    const entry: Entry = { plugin, browser, storage: {}, generation: 0, suppressed: false, checkedAt: 0, writes: Promise.resolve(), listener: () => {
      if (!this.stopping) void this.capture(plugin.id).catch(() => this.storageWarning(plugin.id));
    } };
    this.entries.set(plugin.id, entry);
    try {
      const serialized = await this.vault.get(this.key(plugin.id));
      if (serialized) {
        const saved = JSON.parse(serialized) as SavedSession;
        if (saved.version === 1 && saved.origin === plugin.loginPage.allowedOrigin && Array.isArray(saved.cookies)
          && (saved.api === null || typeof saved.api === 'object' && !Array.isArray(saved.api))) {
          entry.saved = saved;
          entry.storage = storageValues(saved.sessionStorage);
          for (const cookie of saved.cookies) {
            const origin = sourceOrigins(plugin.loginPage).find((item) => cookieInOrigin(cookie, item));
            const details = origin ? restoredCookie(cookie, origin) : null;
            if (details) await browser.cookies.set(details);
          }
          if (saved.api) await plugin.sessionRecovery.restore(saved.api);
        }
      }
    } catch { this.storageWarning(plugin.id); }
    browser.cookies.on('changed', entry.listener);
    // All existing IPC/task callers now use the same verified state, not a local token-present flag.
    plugin.getSessionState = (options) => this.getState(plugin.id, options);
  }

  private async snapshot(entry: Entry): Promise<SavedSession> {
    const origin = entry.plugin.loginPage!.allowedOrigin;
    const origins = sourceOrigins(entry.plugin.loginPage!);
    return { version: 1, origin, api: await entry.plugin.sessionRecovery!.snapshot(),
      cookies: (await entry.browser.cookies.get({})).filter((cookie) => origins.some((item) => cookieInOrigin(cookie, item))
        && (cookie.expirationDate === undefined || cookie.expirationDate * 1000 > Date.now())), sessionStorage: entry.storage };
  }

  async getState(id: string, options: { force?: boolean } = {}): Promise<SessionState> {
    const entry = this.entries.get(id)!;
    if (this.stopping) return entry.state ?? { status: 'logged-out', systemId: id };
    if (entry.pending) return entry.pending;
    const generation = entry.generation;
    const currentState = (): SessionState => entry.state ?? { status: 'logged-out', systemId: id };
    const work = async (): Promise<SessionState> => {
      let snapshot: SavedSession;
      try { snapshot = await this.snapshot(entry); }
      catch {
        if (entry.generation !== generation || entry.awaitingApiLogin) return currentState();
        return { status: 'unverified', systemId: id, message: '会话暂时无法读取，已保存的信息未清除' };
      }
      if (entry.generation !== generation) return currentState();
      const hasApi = snapshot.api && Object.keys(snapshot.api).length > 0;
      if (entry.awaitingApiLogin && !hasApi) return currentState();
      entry.awaitingApiLogin = false;
      const fingerprint = createHash('sha256').update(JSON.stringify({ api: snapshot.api,
        cookies: snapshot.cookies.map(({ name, value, domain, path }) => ({ name, value, domain, path })) })).digest('hex');
      // A failed check before login must not mask the same cookie becoming authenticated.
      const cacheMs = entry.state?.status === 'authenticated' ? 60_000 : 5_000;
      if (!options.force && entry.state && fingerprint === entry.fingerprint && Date.now() - entry.checkedAt < cacheMs) return entry.state;
      if (entry.fingerprint !== fingerprint) entry.suppressed = false;
      let state: SessionState;
      if (!hasApi && !snapshot.cookies.length && !entry.saved) state = { status: 'logged-out', systemId: id };
      else {
        try {
          const verified = await entry.plugin.sessionRecovery!.validate(AbortSignal.timeout(10_000));
          state = { status: 'authenticated', systemId: id, ...verified };
        } catch (error) {
          if (entry.generation !== generation) return currentState();
          this.verificationWarning(entry, error);
          state = error instanceof AppError && error.code === 'SESSION_EXPIRED'
            ? { status: 'expired', systemId: id, message: '原系统会话已失效，请重新登录' }
            : { status: 'unverified', systemId: id, message: '暂时无法验证登录，已保留会话；请检查网络或打开原系统确认' };
        }
      }
      if (entry.generation !== generation) return currentState();
      entry.state = state; entry.fingerprint = fingerprint; entry.checkedAt = Date.now();
      if (state.status === 'authenticated') {
        entry.suppressed = false;
        await this.capture(id).catch(() => this.storageWarning(id));
      } else if (state.status === 'unverified') {
        // Persistence is not proof of authentication. Keep newly captured credentials
        // through transient verification failures; recovery still requires validation.
        await this.capture(id).catch(() => this.storageWarning(id));
      } else if (state.status === 'expired') {
        entry.suppressed = true; entry.saved = undefined;
        await this.vault.delete(this.key(id)).catch(() => this.storageWarning(id));
      }
      return entry.generation === generation ? state : currentState();
    };
    entry.pending = work().finally(() => { entry.pending = undefined; });
    return entry.pending;
  }

  async capture(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    const generation = entry.generation;
    const work = entry.writes.then(async () => {
      if (entry.suppressed || entry.generation !== generation) return;
      const saved = await this.snapshot(entry);
      if (entry.generation !== generation || entry.suppressed) return;
      // Do not overwrite a complete saved API session with a partial/empty read.
      if (entry.state?.status === 'unverified' && entry.saved?.api && Object.keys(entry.saved.api).length
        && (!saved.api || !Object.keys(saved.api).length)) return;
      if (!saved.cookies.length && (!saved.api || !Object.keys(saved.api).length)) return;
      entry.saved = saved;
      await this.vault.set(this.key(id), JSON.stringify(saved));
    });
    entry.writes = work.catch(() => {});
    return work;
  }

  storage(id: string): Record<string, string> { return { ...this.entries.get(id)?.storage }; }
  async saveStorage(id: string, value: unknown): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.suppressed || this.stopping) return;
    entry.storage = storageValues(value);
    await this.capture(id);
  }

  async forget(id: string, { awaitApiLogin = false } = {}): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return this.vault.delete(this.key(id));
    entry.generation++; entry.saved = undefined; entry.storage = {}; entry.suppressed = true;
    entry.state = { status: 'logged-out', systemId: id }; entry.checkedAt = 0;
    entry.fingerprint = undefined;
    // For token-based browser sign-out, leftover cookies cannot revive the old session.
    entry.awaitingApiLogin = awaitApiLogin;
    // Delete after any in-progress write and before a fresh login can write its own snapshot.
    const deletion = entry.writes.then(() => this.vault.delete(this.key(id)));
    entry.writes = deletion.catch(() => {});
    await deletion;
  }

  async recoverableSystems(allowedSystems: string[]): Promise<string[]> {
    const candidates = [...this.entries.values()].filter((entry) => entry.saved && allowedSystems.includes(entry.plugin.id));
    const results = await Promise.all(candidates.map(async (entry) => (
      (await this.getState(entry.plugin.id)).status === 'authenticated' ? entry.plugin.id : null
    )));
    return results.filter((id): id is string => id !== null && this.canRestore(id));
  }

  canRestore(id: string): boolean {
    const entry = this.entries.get(id);
    return !this.stopping && Boolean(entry?.saved && !entry.suppressed && entry.state?.status === 'authenticated');
  }

  async flush(): Promise<void> {
    this.stopping = true;
    for (const entry of this.entries.values()) entry.browser.cookies.removeListener('changed', entry.listener);
    await Promise.all([...this.entries.values()].map((entry) => entry.pending?.catch(() => undefined)));
    await Promise.all([...this.entries.keys()].map((id) => this.capture(id).catch(() => this.storageWarning(id))));
    await Promise.all([...this.entries.values()].map((entry) => entry.browser.cookies.flushStore().catch(() => {})));
    await this.vault.flush();
  }

  private storageWarning(id: string): void { console.warn('会话安全存储暂不可用，不影响当前登录；重启恢复可能不可用', { systemId: id }); }

  private verificationWarning(entry: Entry, error: unknown): void {
    // Never log raw errors: they can contain response bodies, credentials or business records.
    const knownNames = new Set(['AppError', 'Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError']);
    const value = error as { name?: string; code?: unknown; cause?: { code?: unknown; cause?: { code?: unknown } } } | null;
    const safeCode = (code: unknown) => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
    const diagnostic = { systemId: entry.plugin.id,
      errorType: knownNames.has(value?.name ?? '') ? value!.name : 'Error',
      errorCode: error instanceof AppError ? error.code : undefined,
      reason: error instanceof AppError && ['EMPTY_RESPONSE', 'INVALID_RPC_RESPONSE', 'UNEXPECTED_RESULT'].includes(String(error.details?.reason))
        ? error.details?.reason : undefined,
      causeCode: safeCode(value?.cause?.cause?.code ?? value?.cause?.code ?? value?.code) };
    const key = JSON.stringify(diagnostic);
    if (entry.diagnosticKey === key && Date.now() - (entry.diagnosticAt ?? 0) < 60_000) return;
    entry.diagnosticKey = key; entry.diagnosticAt = Date.now();
    console.warn('原系统登录验证未通过', diagnostic);
  }
}
