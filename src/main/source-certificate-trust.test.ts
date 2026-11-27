import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { connect, rootCertificates } from 'node:tls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request as CertificateVerificationRequest } from 'electron';

type VerifyProc = (request: CertificateVerificationRequest, callback: (result: number) => void) => void;
const electron = vi.hoisted(() => ({ procedures: new Map<string, VerifyProc>(),
  fromPartition: vi.fn(), showMessageBox: vi.fn() }));
vi.mock('electron', () => ({ session: { fromPartition: electron.fromPartition }, dialog: { showMessageBox: electron.showMessageBox } }));
vi.mock('node:tls', async (actual) => ({ ...await actual<typeof import('node:tls')>(), connect: vi.fn() }));
import { installSourceCertificateTrust, installSourceCertificateVerifiers, type SourceCertificateTrustOptions } from './source-certificate-trust';
import { HRSS_SOURCE_CERTIFICATE_TRUST } from '../core/config/source-certificate-pins';
import { SHENZHEN_INTEGRATED_SOURCE_CERTIFICATE_TRUST } from '../core/config/source-certificate-pins';
import { REVIEWED_CERTIFICATE } from './source-endpoint-certificate.test-fixture';

// Public, local synthetic certificates only; their disposable private keys were never saved.
const CERT_A = "-----BEGIN CERTIFICATE-----\nMIIDKDCCAhCgAwIBAgIUVCefL9RF+Jd+DTG9EqVSzLvl+dwwDQYJKoZIhvcNAQEL\nBQAwQTESMBAGA1UEAwwJaHJzcy50ZXN0MSswKQYDVQQKDCJMb2NhbCBTb3VyY2Ug\nQ2VydGlmaWNhdGUgRml4dHVyZSBBMB4XDTI2MDEwMTAwMDAwMFoXDTI4MDEwMTAw\nMDAwMFowQTESMBAGA1UEAwwJaHJzcy50ZXN0MSswKQYDVQQKDCJMb2NhbCBTb3Vy\nY2UgQ2VydGlmaWNhdGUgRml4dHVyZSBBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\nMIIBCgKCAQEAlQ/QtvzXJmeNUwCayoN4eMCDMQUoF2w2797yY7jcd69akKw++Lg/\nsWS67YkBhtghlmx+n1dHGHTOXx0EI1o8VEvWebKNSMyKns6nfCFNtC5NMAifZmX8\nS6N9ssbIcr+tRBRKyV5wBhmKcGouHu0k7dsjA97PTb8hjEjLGNu2M2J3jjcj4Q+v\n/6iLx/Za6b1iSBU2m49JTcNdzwMZB9HyicecZfCWHSmYPyydIzK0rPvFYiAvztkK\nCJqyoHrWV2Y80TZYgIPQJaNtuvpemb3OvJZa6FXpukhj2AHgOphR23BYALOc4CQ8\ntpnkAoDeoZ/4LfiJfhpMCX3wEJWUmCPqcwIDAQABoxgwFjAUBgNVHREEDTALgglo\ncnNzLnRlc3QwDQYJKoZIhvcNAQELBQADggEBAIhMJ3ZFhdpv26/rrgnxYKMYoiIZ\nVqWBucd5T5iT7pRTmiqrnURJlcVa3aGFzc46gp2QYRCaMOTa+MjlwlghDxl8gnEP\n2kVnmwCXIwEsQgohwhkSd2JuJH2vE9CQeU7X6Ic4mTf29BBQTEvmzwM/UAFFBLtF\nbGkSDrMgZrUYgqb5zvBw47ucZZfDm+C27BtdLm7OlEhBwkYOo7H1iXeOa0E+JmMv\nwRSCSf1f+xQWXg9+ROdESz7135+BxZW7nPnLVjKIrERjvQcr2wlDKUisYCnM2i1I\nxT8RtBq8/c07cZM2lWBDzvW8VuosGRIxXSqvHMkiQEtJsw4Xg7tATxV9RwI=\n-----END CERTIFICATE-----\n";
const CERT_B = "-----BEGIN CERTIFICATE-----\nMIIDKDCCAhCgAwIBAgIUFvZd0/2zc5zC2+VlwugyhVIbsYowDQYJKoZIhvcNAQEL\nBQAwQTESMBAGA1UEAwwJaHJzcy50ZXN0MSswKQYDVQQKDCJMb2NhbCBTb3VyY2Ug\nQ2VydGlmaWNhdGUgRml4dHVyZSBCMB4XDTI2MDEwMTAwMDAwMFoXDTI4MDEwMTAw\nMDAwMFowQTESMBAGA1UEAwwJaHJzcy50ZXN0MSswKQYDVQQKDCJMb2NhbCBTb3Vy\nY2UgQ2VydGlmaWNhdGUgRml4dHVyZSBCMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\nMIIBCgKCAQEAxx1Ox4iYpAL986CbzVd40RXXH4kpJDnliQwlPFqYti0jb6QecDHy\nafhctC8rUWRiPQM3eDd0swvae6dkcJunZMs7M98arHMHFwCpEspafq4gEFhOVukn\nvoaRqPWIXXAjaUfZOQIhRJ2lgUEQwVR6oUGh6Yt7NZmQpECpCv/5aTjM0vZ1tHGs\nY3RILikZJIfBM5IZy5yWl0MLZsrfI7OCWGvDLRnrR8tIYpvfTIZ72WzKSUlTQnxr\nfjZAZGbIuWVOhhF8xbya7QXFYLBfmKQJmo8+KLlv9GF4/1YTIeQNUe5L1kZvPSBY\nD4eohbhP1D4cqj4qAYkVy3Fxlxo/A5Y6gwIDAQABoxgwFjAUBgNVHREEDTALgglo\ncnNzLnRlc3QwDQYJKoZIhvcNAQELBQADggEBAByJZUYZl3JcZj9DafrnGd+yh9A7\np1Vx76f8wL282FSxrcBmrP7S6iOj9OV4DjBvrdXPTsCqz9Ivxckm9G97942neo01\np81bM97SKu0G7vBc9yKx2VJ4DftXQKzP62foNMVHATAni67WHpDIW02e9LKVH+k/\ny4n5t3GI7DIY5w43lzpWajadRDC/mZhLpVbG9n/Ekprt8sdQOxrQnNpOIbvWN02G\n8T91ysagTgFwitdCGpCzHN/uDvPpORDnioZcDLcjrExn8Rk97efxA9y0f1sfz01+\n8l4dL7b0t09e7VT1Yvb1L2UB0eSeuv4mu1fk7FIEf+x4nVJS6Uh2ay3/vFQ=\n-----END CERTIFICATE-----\n";
const NOW = Date.parse('2026-11-04T00:00:00Z');
const PARTITION = 'persist:source-certificate-fixture';
const ORIGIN = 'https://hrss.test';
const pinA = new X509Certificate(CERT_A).fingerprint256;
const pinB = new X509Certificate(CERT_B).fingerprint256;

beforeEach(() => {
  vi.clearAllMocks(); electron.procedures.clear();
  electron.fromPartition.mockImplementation((partition: string) => ({
    setCertificateVerifyProc: vi.fn((procedure: VerifyProc) => electron.procedures.set(partition, procedure)),
  }));
  electron.showMessageBox.mockResolvedValue({ response: 0 });
});
function request(overrides: Partial<CertificateVerificationRequest> = {}): CertificateVerificationRequest {
  return { hostname: 'hrss.test', errorCode: -202, verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
    certificate: { data: CERT_A, fingerprint: 'forged-electron-fingerprint', subjectName: 'forged-display-name' },
    ...overrides } as CertificateVerificationRequest;
}
function verify(value = request(), partition = PARTITION): Promise<number> {
  const procedure = electron.procedures.get(partition);
  if (!procedure) throw new Error('Missing fixture verification procedure');
  return new Promise(resolve => procedure(value, resolve));
}
function options(extra: Partial<SourceCertificateTrustOptions> = {}) {
  const vault = { get: vi.fn(async (_key: string): Promise<string | null> => null),
    set: vi.fn(async (_key: string, _value: string): Promise<void> => {}) };
  const prompt = vi.fn(async () => false);
  return { partition: PARTITION, origin: ORIGIN, now: () => NOW, vault, prompt, ...extra };
}

describe('source certificate trust is narrowly scoped', () => {
  it('does not override normal TLS, other hosts or any error except authority-invalid', async () => {
    const config = options(); vi.mocked(config.vault.get).mockResolvedValue(pinA);
    await installSourceCertificateTrust(config);
    expect(electron.fromPartition).toHaveBeenCalledExactlyOnceWith(PARTITION);
    expect(await verify(request({ hostname: 'unrelated.test' }))).toBe(-3);
    expect(await verify(request({ errorCode: 0, verificationResult: 'OK' }))).toBe(-3);
    for (const errorCode of [-200, -201, -203, -204, -206, -214]) {
      expect(await verify(request({ errorCode }))).toBe(-3);
    }
    expect(await verify(request({ verificationResult: 'CERT_REVOKED' }))).toBe(-3);
    expect(config.prompt).not.toHaveBeenCalled(); expect(config.vault.set).not.toHaveBeenCalled();
  });
  it('accepts an encrypted stored SHA-256 pin only after real SAN and date validation', async () => {
    const config = options(); vi.mocked(config.vault.get).mockResolvedValue(pinA.replace(/:/g, '').toLowerCase());
    await installSourceCertificateTrust(config);
    expect(await verify()).toBe(0);
    expect(config.prompt).not.toHaveBeenCalled(); expect(config.vault.set).not.toHaveBeenCalled();
    expect(config.vault.get).toHaveBeenCalledWith('source-certificate-pin:persist%3Asource-certificate-fixture:https://hrss.test');
  });
  it('never trusts a matching display CN when the actual SAN has another host', async () => {
    const config = options({ origin: 'https://other.test' }); vi.mocked(config.vault.get).mockResolvedValue(pinA);
    await installSourceCertificateTrust(config);
    expect(await verify(request({ hostname: 'other.test' }))).toBe(-2);
    expect(config.prompt).not.toHaveBeenCalled();
  });
  it('rejects expired, not-yet-valid and malformed certificates without offering trust', async () => {
    for (const invalidNow of [Date.parse('2025-12-31T23:59:59Z'), Date.parse('2028-01-01T00:00:01Z')]) {
      const config = options({ now: () => invalidNow }); vi.mocked(config.vault.get).mockResolvedValue(pinA);
      await installSourceCertificateTrust(config); expect(await verify()).toBe(-2); expect(config.prompt).not.toHaveBeenCalled();
    }
    const config = options(); await installSourceCertificateTrust(config);
    expect(await verify(request({ certificate: { data: 'not a certificate' } as CertificateVerificationRequest['certificate'] }))).toBe(-2);
    expect(config.prompt).not.toHaveBeenCalled(); expect(config.vault.set).not.toHaveBeenCalled();
  });
  it('rejects unnamed/default partitions, HTTP and non-origin URLs without changing verification', async () => {
    for (const extra of [{ partition: '' }, { partition: ' ' }, { origin: 'http://hrss.test' }, { origin: 'https://hrss.test/path' }, { origin: 'https://hrss.test/' }]) {
      await expect(installSourceCertificateTrust(options(extra))).rejects.toThrow();
    }
    expect(electron.fromPartition).not.toHaveBeenCalled();
  });
});

describe('explicit certificate decisions', () => {
  it('shows a native dialog with cancellation as default and actual X509 identity/fingerprint', async () => {
    const config = options(); const { prompt: _injected, ...native } = config;
    await installSourceCertificateTrust(native);
    expect(await verify()).toBe(-2);
    expect(electron.showMessageBox).toHaveBeenCalledOnce();
    const dialog = electron.showMessageBox.mock.calls[0][0];
    expect(dialog).toMatchObject({ type: 'warning', defaultId: 0, cancelId: 0, noLink: true,
      buttons: ['取消连接', '信任此证书并继续'] });
    expect(dialog.detail).toContain('Local Source Certificate Fixture A'); expect(dialog.detail).toContain('颁发者：');
    expect(dialog.detail).toContain(pinA); expect(dialog.detail).not.toContain('forged-electron-fingerprint');
    expect(dialog.detail).not.toContain('forged-display-name'); expect(config.vault.set).not.toHaveBeenCalled();
  });
  it('coalesces concurrent connections into one approval and persists only the derived pin', async () => {
    let decide!: (approved: boolean) => void;
    const prompt = vi.fn(() => new Promise<boolean>(resolve => { decide = resolve; }));
    const config = options({ prompt }); await installSourceCertificateTrust(config);
    const first = verify(), second = verify();
    expect(prompt).toHaveBeenCalledOnce();
    decide(true); expect(await first).toBe(0); expect(await second).toBe(0);
    expect(config.vault.set).toHaveBeenCalledExactlyOnceWith(
      'source-certificate-pin:persist%3Asource-certificate-fixture:https://hrss.test', pinA);
    expect(await verify()).toBe(0); expect(prompt).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(config.vault.set).mock.calls)).not.toContain('BEGIN CERTIFICATE');
  });
  it('remembers rejection only for this installed session and never writes a declined pin', async () => {
    const config = options(); await installSourceCertificateTrust(config);
    expect(await verify()).toBe(-2); expect(await verify()).toBe(-2);
    expect(config.prompt).toHaveBeenCalledOnce(); expect(config.vault.set).not.toHaveBeenCalled();
    await installSourceCertificateTrust(config); expect(await verify()).toBe(-2);
    expect(config.prompt).toHaveBeenCalledTimes(2);
  });
  it('asks again for a changed certificate and keeps the existing pin when declined', async () => {
    const config = options(); vi.mocked(config.vault.get).mockResolvedValue(pinA);
    await installSourceCertificateTrust(config);
    expect(await verify(request({ certificate: { data: CERT_B } as CertificateVerificationRequest['certificate'] }))).toBe(-2);
    expect(config.prompt).toHaveBeenCalledWith(expect.objectContaining({ fingerprint256: pinB, previousFingerprint256: pinA }));
    expect(await verify()).toBe(0); expect(config.vault.set).not.toHaveBeenCalled();
  });
  it('replaces a pin only after approval, and stores it separately for every partition', async () => {
    const config = options({ prompt: vi.fn(async () => true) }); vi.mocked(config.vault.get).mockResolvedValue(pinA);
    await installSourceCertificateTrust(config);
    expect(await verify(request({ certificate: { data: CERT_B } as CertificateVerificationRequest['certificate'] }))).toBe(0);
    expect(config.vault.set).toHaveBeenCalledWith(expect.any(String), pinB);
    const other = options({ partition: 'persist:other-source-fixture' });
    await installSourceCertificateTrust(other); expect(await verify(request(), other.partition)).toBe(-2);
    expect(other.prompt).toHaveBeenCalledOnce();
    expect(other.vault.get).toHaveBeenCalledWith('source-certificate-pin:persist%3Aother-source-fixture:https://hrss.test');
  });
  it('fails closed on prompt or encrypted vault failures without repeating a failed decision', async () => {
    for (const failure of ['prompt', 'write']) {
      const config = options({ prompt: vi.fn(async () => true) });
      if (failure === 'prompt') vi.mocked(config.prompt).mockRejectedValue(new Error('fixture dialog unavailable'));
      else vi.mocked(config.vault.set).mockRejectedValue(new Error('fixture encrypted storage unavailable'));
      await installSourceCertificateTrust(config);
      expect(await verify()).toBe(-2); expect(await verify()).toBe(-2); expect(config.prompt).toHaveBeenCalledOnce();
    }
    const unavailable = options(); vi.mocked(unavailable.vault.get).mockRejectedValue(new Error('fixture vault unavailable'));
    electron.fromPartition.mockClear();
    await expect(installSourceCertificateTrust(unavailable)).rejects.toThrow('fixture vault unavailable');
    expect(electron.fromPartition).not.toHaveBeenCalled();
  });
  it('checks the validity period again if the certificate expires while the prompt is open', async () => {
    let clock = NOW;
    const config = options({ now: () => clock, prompt: vi.fn(async () => { clock = Date.parse('2029-01-01T00:00:00Z'); return true; }) });
    await installSourceCertificateTrust(config);
    expect(await verify()).toBe(-2); expect(config.vault.set).not.toHaveBeenCalled();
  });
});

describe('reviewed built-in certificate trust for new clients', () => {
  it('accepts the reviewed certificate on an empty profile with no dialog or saved approval', async () => {
    const config = options({ trustedFingerprints: [pinA.replace(/:/g, '').toLowerCase()], unknownCertificate: 'reject' });
    await installSourceCertificateTrust(config);
    expect(await verify()).toBe(0);
    expect(await verify()).toBe(0);
    expect(config.prompt).not.toHaveBeenCalled(); expect(electron.showMessageBox).not.toHaveBeenCalled();
    expect(config.vault.get).not.toHaveBeenCalled(); expect(config.vault.set).not.toHaveBeenCalled();
  });
  it('rejects a different certificate silently, even if an old profile stored its approval', async () => {
    const config = options({ trustedFingerprints: [pinA], unknownCertificate: 'reject' });
    vi.mocked(config.vault.get).mockResolvedValue(pinB);
    await installSourceCertificateTrust(config);
    expect(await verify(request({ certificate: { data: CERT_B } as CertificateVerificationRequest['certificate'] }))).toBe(-2);
    expect(config.prompt).not.toHaveBeenCalled(); expect(electron.showMessageBox).not.toHaveBeenCalled();
    expect(config.vault.get).not.toHaveBeenCalled(); expect(config.vault.set).not.toHaveBeenCalled();
  });
  it('still checks the real hostname and validity dates before accepting an embedded pin', async () => {
    for (const patch of [{ now: () => Date.parse('2029-01-01T00:00:00Z') }, { origin: 'https://other.test' }]) {
      const config = options({ trustedFingerprints: [pinA], unknownCertificate: 'reject', ...patch });
      await installSourceCertificateTrust(config);
      expect(await verify(request({ hostname: new URL(config.origin).hostname }))).toBe(-2);
      expect(config.prompt).not.toHaveBeenCalled();
    }
  });
  it('does not override other hosts or expired, name-mismatch or revocation verification errors', async () => {
    const config = options({ trustedFingerprints: [pinA], unknownCertificate: 'reject' });
    await installSourceCertificateTrust(config);
    expect(await verify(request({ hostname: 'unrelated.test' }))).toBe(-3);
    for (const errorCode of [-200, -201, -203, -204, -206, -214]) expect(await verify(request({ errorCode }))).toBe(-3);
    expect(config.prompt).not.toHaveBeenCalled();
  });
  it('keeps a shipped approved pin usable when no encrypted preferences are available', async () => {
    const config = options({ trustedFingerprints: [pinA], unknownCertificate: 'reject' });
    vi.mocked(config.vault.get).mockRejectedValue(new Error('no profile encryption key'));
    vi.mocked(config.vault.set).mockRejectedValue(new Error('no profile encryption key'));
    await installSourceCertificateTrust(config);
    expect(await verify()).toBe(0); expect(config.prompt).not.toHaveBeenCalled();
  });
  it('rejects malformed configured pins before installing any verification override', async () => {
    await expect(installSourceCertificateTrust(options({ trustedFingerprints: ['not-a-sha256'], unknownCertificate: 'reject' }))).rejects.toThrow('SHA-256');
    expect(electron.fromPartition).not.toHaveBeenCalled();
  });
  it('ships automatic trust only for the explicitly approved HRSS origin and partition', () => {
    expect(HRSS_SOURCE_CERTIFICATE_TRUST).toEqual({ partition: 'persist:guangdong-hrss', origin: 'https://hrss.gdgov.cn', unknownCertificate: 'reject',
      trustedFingerprints: ['99:A4:5E:36:EF:E5:CE:EA:37:77:76:CB:D3:AE:1E:3C:67:40:3E:A3:98:26:0B:D6:73:20:B7:BD:08:13:AF:6F'] });
  });
});

describe('public CA fallback for source partitions', () => {
  const other = 'persist:another-source';
  const pinned = 'persist:pinned-source';

  function peer(certificate = CERT_A, authorized = true) {
    const socket = Object.assign(new EventEmitter(), {
      authorized,
      getPeerCertificate: () => ({ raw: new X509Certificate(certificate).raw }),
      destroy: vi.fn(),
    });
    vi.mocked(connect).mockReturnValue(socket as unknown as ReturnType<typeof connect>);
    return socket;
  }

  function install(origins = [ORIGIN]) {
    return installSourceCertificateVerifiers([
      { partition: PARTITION, origins },
      { partition: other, origins: ['https://other.test'] },
      { partition: pinned, origins: [ORIGIN] },
      { partition: 'persist:http-source', origins: ['http://hrss.test'] },
    ], options({ partition: pinned, unknownCertificate: 'reject', trustedFingerprints: [pinA] }));
  }

  it('requires a trusted TLS handshake with the same leaf and combines concurrent probes', async () => {
    await install(['https://hrss.test:8443']);
    const socket = peer();
    const first = verify(), second = verify();
    expect(connect).toHaveBeenCalledExactlyOnceWith({ host: 'hrss.test', port: 8443, servername: 'hrss.test',
      ca: [...rootCertificates], rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    socket.emit('secureConnect');
    expect(await Promise.all([first, second])).toEqual([0, 0]);
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it('delegates if the chain fails or the independently verified leaf is different', async () => {
    await install();
    const changedLeaf = peer(CERT_B);
    const mismatch = verify();
    changedLeaf.emit('secureConnect');
    expect(await mismatch).toBe(-3);
    const untrusted = peer(CERT_A, false);
    const rejected = verify();
    untrusted.emit('error', new Error('Untrusted CA'));
    expect(await rejected).toBe(-3);
  });

  it('skips unconfigured hosts, mismatched SAN, HTTP-only partitions and other Chromium errors', async () => {
    await install();
    expect(electron.procedures.has('persist:http-source')).toBe(false);
    expect(await verify(request(), other)).toBe(-3);
    expect(await verify(request({ hostname: 'other.test' }), other)).toBe(-3);
    for (const errorCode of [0, -200, -201, -206]) expect(await verify(request({ errorCode }))).toBe(-3);
    expect(await verify(request({ verificationResult: 'CERT_REVOKED' }))).toBe(-3);
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not guess which port to probe when the configured hostname is ambiguous', async () => {
    await install([ORIGIN, 'https://hrss.test:8443']);
    expect(await verify()).toBe(-3);
    expect(connect).not.toHaveBeenCalled();
  });

  it('returns control to Chromium if the probe times out', async () => {
    vi.useFakeTimers();
    try {
      await install();
      const socket = peer();
      const timedOut = verify();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await timedOut).toBe(-3);
      expect(socket.destroy).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('keeps the reviewed pin while allowing independently validated certificate rotation', async () => {
    await install();
    expect(await verify(request(), pinned)).toBe(0);
    expect(connect).not.toHaveBeenCalled();
    const rotated = peer(CERT_B);
    const result = verify(request({ certificate: { data: CERT_B } as CertificateVerificationRequest['certificate'] }), pinned);
    await Promise.resolve();
    rotated.emit('secureConnect');
    expect(await result).toBe(0);
    expect(electron.showMessageBox).not.toHaveBeenCalled();
  });

  it('allows the reviewed Shenzhen leaf in its dedicated sole-origin session before any tab opens', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-27T00:00:00Z'));
    try {
      const reviewed = SHENZHEN_INTEGRATED_SOURCE_CERTIFICATE_TRUST;
      await installSourceCertificateVerifiers([{ partition: reviewed.partition, origins: [reviewed.origin] }], options());
      const peer = request({ hostname: '61.144.226.148', errorCode: -200, verificationResult: 'net::ERR_CERT_COMMON_NAME_INVALID',
        certificate: { data: REVIEWED_CERTIFICATE } as CertificateVerificationRequest['certificate'] });
      expect(await verify(peer, reviewed.partition)).toBe(0);
      expect(connect).not.toHaveBeenCalled();
      for (const errorCode of [-201, -202, -206]) expect(await verify({ ...peer, errorCode }, reviewed.partition)).toBe(-3);
      expect(await verify({ ...peer, hostname: 'other.test' }, reviewed.partition)).toBe(-3);
      expect(await verify({ ...peer, certificate: { data: CERT_A } as CertificateVerificationRequest['certificate'] }, reviewed.partition)).toBe(-3);
      vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
      expect(await verify(peer, reviewed.partition)).toBe(-3);
    } finally { vi.useRealTimers(); }
  });

  it('does not extend the Shenzhen session exception to another partition or ambiguous source configuration', async () => {
    const reviewed = SHENZHEN_INTEGRATED_SOURCE_CERTIFICATE_TRUST;
    const peer = request({ hostname: '61.144.226.148', errorCode: -200, verificationResult: 'net::ERR_CERT_COMMON_NAME_INVALID',
      certificate: { data: REVIEWED_CERTIFICATE } as CertificateVerificationRequest['certificate'] });
    await installSourceCertificateVerifiers([
      { partition: reviewed.partition, origins: [reviewed.origin, 'https://61.144.226.148:8002'] },
      { partition: 'persist:unrelated', origins: [reviewed.origin] },
    ], options());
    expect(await verify(peer, reviewed.partition)).toBe(-3);
    expect(await verify(peer, 'persist:unrelated')).toBe(-3);
  });
});
