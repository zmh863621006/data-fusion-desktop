import { X509Certificate } from 'node:crypto';
import { SHENZHEN_INTEGRATED_SOURCE_CERTIFICATE_TRUST as reviewed } from '../core/config/source-certificate-pins';

/** Explicit name-mismatch exception for one reviewed certificate and source tab. */
export function approvedSourceEndpointCertificate(
  systemId: string,
  page: { partition: string; allowedOrigin: string },
  requestUrl: string,
  error: string,
  certificateData: string,
  now = Date.now(),
): boolean {
  if (systemId !== reviewed.systemId || page.partition !== reviewed.partition || page.allowedOrigin !== reviewed.origin
    || error !== 'net::ERR_CERT_COMMON_NAME_INVALID' && error !== 'ERR_CERT_COMMON_NAME_INVALID') return false;
  try {
    const url = new URL(requestUrl);
    if (url.origin !== reviewed.origin || url.username || url.password) return false;
    const certificate = new X509Certificate(certificateData);
    if (certificate.fingerprint256 !== reviewed.fingerprint256
      || !certificate.checkHost(reviewed.certificateHostname, { subject: 'never' })) return false;
    const start = Date.parse(certificate.validFrom), end = Date.parse(certificate.validTo);
    return Number.isFinite(now) && Number.isFinite(start) && Number.isFinite(end) && start <= now && now <= end;
  } catch { return false; }
}
