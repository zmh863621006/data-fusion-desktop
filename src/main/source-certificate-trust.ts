import { X509Certificate } from 'node:crypto';
import { dialog, session, type Request as CertificateVerificationRequest } from 'electron';
import { publicSourceCertificateVerifier } from './source-public-certificate';

export interface SourceCertificateVault {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface SourceCertificateSummary {
  origin: string;
  hostname: string;
  subject: string;
  issuer: string;
  fingerprint256: string;
  validFrom: string;
  validTo: string;
  previousFingerprint256?: string;
}

export interface SourceCertificateTrustOptions {
  partition: string;
  origin: string;
  /** Must be the application's encrypted main-process vault, never renderer storage. */
  vault: SourceCertificateVault;
  /** Reviewed certificate SHA-256 identities shipped with the application. */
  trustedFingerprints?: readonly string[];
  /** Sources with reviewed built-in pins can reject unknown certificates without opening a dialog. */
  unknownCertificate?: 'confirm' | 'reject';
  prompt?(certificate: SourceCertificateSummary): Promise<boolean>;
  /** Injectable clock for deterministic certificate-validity tests. */
  now?(): number;
}

const USE_CHROMIUM_RESULT = -3;
const REJECT_CERTIFICATE = -2;
const AUTHORITY_INVALID = -202;
const authorityErrors = new Set(['CERT_AUTHORITY_INVALID', 'ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_AUTHORITY_INVALID']);

function installAuthorityVerifier(partition: string, verify: (request: CertificateVerificationRequest) => Promise<number>): void {
  session.fromPartition(partition).setCertificateVerifyProc((request, callback) => {
    if (request.errorCode !== AUTHORITY_INVALID || !authorityErrors.has(request.verificationResult)) {
      callback(USE_CHROMIUM_RESULT);
      return;
    }
    void verify(request).then(callback, () => callback(USE_CHROMIUM_RESULT));
  });
}

/** Only named source sessions receive the fallback. Exact-origin navigation rules still apply. */
export async function installSourceCertificateVerifiers(
  sources: Iterable<{ partition: string; origins: Iterable<string> }>,
  pinnedSource: SourceCertificateTrustOptions,
): Promise<void> {
  const partitions = new Map<string, Set<string>>();
  for (const { partition, origins } of sources) {
    if (!partition.trim() || partition !== partition.trim()) continue;
    for (const origin of origins) {
      if (!origin.startsWith('https://')) continue;
      const existing = partitions.get(partition) ?? new Set<string>();
      existing.add(origin);
      partitions.set(partition, existing);
    }
  }
  for (const [partition, origins] of partitions) {
    if (partition === pinnedSource.partition) continue;
    const verify = publicSourceCertificateVerifier(origins);
    installAuthorityVerifier(partition, async (request) =>
      await verify(request.hostname, request.certificate.data) ? 0 : USE_CHROMIUM_RESULT);
  }
  await installSourceCertificateTrust(pinnedSource, partitions.get(pinnedSource.partition));
}

function normalizedPin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/:/g, '').toUpperCase();
  return /^[A-F0-9]{64}$/.test(compact) ? compact.match(/.{2}/g)!.join(':') : null;
}

function validAt(certificate: X509Certificate, now: number): boolean {
  const start = Date.parse(certificate.validFrom), end = Date.parse(certificate.validTo);
  return Number.isFinite(now) && Number.isFinite(start) && Number.isFinite(end) && start <= now && now <= end;
}

async function defaultPrompt(certificate: SourceCertificateSummary): Promise<boolean> {
  const response = await dialog.showMessageBox({ type: 'warning', title: '原系统证书需要确认',
    message: `${certificate.hostname} 的证书颁发机构未被本机识别`,
    detail: [
      certificate.previousFingerprint256 ? '此证书与之前确认的证书不同，请重新核对。' : '请核对原系统提供的证书信息，再决定是否连接。',
      `网站：${certificate.origin}`,
      `证书主体：${certificate.subject}`,
      `颁发者：${certificate.issuer}`,
      `有效期：${certificate.validFrom} 至 ${certificate.validTo}`,
      `SHA-256 指纹：${certificate.fingerprint256}`,
      '确认后仅在此应用的该原系统分区中信任这一张证书；证书变更时需要再次确认。',
    ].join('\n\n'),
    buttons: ['取消连接', '信任此证书并继续'], defaultId: 0, cancelId: 0, noLink: true });
  return response.response === 1;
}

/**
 * An explicit leaf-certificate pin for one source hostname in one named partition.
 * All ordinary TLS decisions remain Chromium's. A pin is never inferred from a
 * probe, a displayed fingerprint, an issuer name or an existing browser cookie.
 */
export async function installSourceCertificateTrust(options: SourceCertificateTrustOptions, publicOrigins: Iterable<string> = []): Promise<void> {
  const url = new URL(options.origin);
  if (url.protocol !== 'https:' || url.origin !== options.origin || !url.hostname
    || !options.partition.trim() || options.partition !== options.partition.trim()) {
    throw new Error('原系统证书信任必须指定独立分区及完整 HTTPS 源地址');
  }
  const hostname = url.hostname.toLowerCase();
  const storageKey = `source-certificate-pin:${encodeURIComponent(options.partition)}:${options.origin}`;
  const approvedPins = new Set<string>();
  for (const value of options.trustedFingerprints ?? []) {
    const pin = normalizedPin(value);
    if (!pin) throw new Error('原系统内置证书指纹必须是有效的 SHA-256');
    approvedPins.add(pin);
  }
  const silent = options.unknownCertificate === 'reject';
  // Built-in trust is portable and does not depend on a previous profile's encrypted preferences.
  let trustedPin = silent ? null : normalizedPin(await options.vault.get(storageKey));
  const pending = new Map<string, Promise<boolean>>();
  const declined = new Set<string>();
  const now = options.now ?? Date.now;
  const prompt = options.prompt ?? defaultPrompt;

  async function verify(request: CertificateVerificationRequest): Promise<boolean> {
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(request.certificate.data);
      // Requiring a subjectAltName prevents a matching display CN from bypassing a wrong SAN.
      if (!certificate.checkHost(hostname, { subject: 'never' }) || !validAt(certificate, now())) return false;
    } catch { return false; }
    // Compute SHA-256 from the received DER; Electron's supplied fingerprint may be SHA-1.
    const pin = normalizedPin(certificate.fingerprint256);
    if (!pin) return false;
    if (approvedPins.has(pin)) return true;
    if (silent) return false;
    if (pin === trustedPin) return true;
    if (declined.has(pin)) return false;
    const inFlight = pending.get(pin);
    if (inFlight) return inFlight;

    const decision = (async (): Promise<boolean> => {
      const approved = await prompt({ origin: options.origin, hostname,
        subject: certificate.subject.slice(0, 2_000), issuer: certificate.issuer.slice(0, 2_000),
        fingerprint256: pin, validFrom: certificate.validFrom, validTo: certificate.validTo,
        ...(trustedPin ? { previousFingerprint256: trustedPin } : {}) });
      if (!approved || !validAt(certificate, now())) return false;
      // Failed encrypted persistence must never silently downgrade to session-only trust.
      await options.vault.set(storageKey, pin);
      trustedPin = pin;
      return true;
    })().catch(() => false).then(approved => {
      if (!approved) declined.add(pin);
      return approved;
    }).finally(() => pending.delete(pin));
    pending.set(pin, decision);
    return decision;
  }

  const verifyPublic = publicSourceCertificateVerifier(publicOrigins);
  installAuthorityVerifier(options.partition, async (request) => {
    // Keep the reviewed pin available even if the widely trusted path is unavailable.
    if (request.hostname.toLowerCase() === hostname && await verify(request)) return 0;
    if (await verifyPublic(request.hostname, request.certificate.data)) return 0;
    return request.hostname.toLowerCase() === hostname ? REJECT_CERTIFICATE : USE_CHROMIUM_RESULT;
  });
}
