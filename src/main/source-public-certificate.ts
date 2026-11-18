import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { connect, rootCertificates } from 'node:tls';

const PROBE_TIMEOUT_MS = 4_000;
const publicRoots = [...rootCertificates];

/** Revalidate the exact leaf using a credential-free handshake and bundled public roots. */
function verifyPeer(hostname: string, port: number, leaf: X509Certificate): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: hostname, port, servername: isIP(hostname) ? undefined : hostname,
      ca: publicRoots, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    const finish = (verified: boolean) => {
      clearTimeout(deadline);
      socket.destroy();
      resolve(verified);
    };
    // Bound DNS, TCP and TLS together, including peers that keep sending data.
    const deadline = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    socket.once('error', () => finish(false));
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate();
      finish(socket.authorized && peer?.raw?.equals(leaf.raw) === true);
    });
  });
}

const hostnameKey = (hostname: string) => hostname.toLowerCase().replace(/^\[|\]$/g, '');

export function publicSourceCertificateVerifier(origins: Iterable<string>) {
  const ports = new Map<string, Set<number>>();
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) continue;
    const hostname = hostnameKey(url.hostname);
    const allowedPorts = ports.get(hostname) ?? new Set<number>();
    allowedPorts.add(Number(url.port || 443));
    ports.set(hostname, allowedPorts);
  }
  const pending = new Map<string, Promise<boolean>>();
  return (requestHostname: string, certificateData: string): Promise<boolean> | undefined => {
    const hostname = hostnameKey(requestHostname);
    const allowedPorts = ports.get(hostname);
    // Chromium only identifies the hostname. Do not guess which endpoint to probe.
    if (allowedPorts?.size !== 1) return;
    let leaf: X509Certificate;
    try { leaf = new X509Certificate(certificateData); }
    catch { return Promise.resolve(false); }
    const matches = isIP(hostname) ? leaf.checkIP(hostname) : leaf.checkHost(hostname, { subject: 'never' });
    if (!matches) return Promise.resolve(false);
    const key = `${hostname}/${leaf.fingerprint256}`;
    const active = pending.get(key);
    if (active) return active;
    const [port] = allowedPorts;
    const verification = verifyPeer(hostname, port, leaf).catch(() => false).finally(() => pending.delete(key));
    pending.set(key, verification);
    return verification;
  };
}
