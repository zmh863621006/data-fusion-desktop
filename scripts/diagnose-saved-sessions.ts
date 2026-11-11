import { app, session } from 'electron';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SecureSessionStore } from '../src/main/session-store';
import { restoredCookie } from '../src/main/session-recovery';
import { OversizeTransportClient } from '../src/plugins/oversize-transport/client';
import { MarketAccessClient, MARKET_ACCESS_PARTITION } from '../src/plugins/market-access/client';
import { PractitionerClient } from '../src/plugins/transport-practitioner/client';
import { OnlineCarPermitClient } from '../src/plugins/online-car-permit/client';

// Explicit read-only diagnostic: real vault is read, never updated; browser storage is isolated.
// No credentials, response bodies, business records, user names or URLs with queries are printed.
const source = process.argv.find((value) => value.startsWith('--source='))?.slice(9);
const profile = process.argv.find((value) => value.startsWith('--profile='))?.slice(10);
if (!source || !profile) throw new Error('Run through run-session-diagnostic.mjs with an explicit --source vault path');
// Chromium encrypts safeStorage values with a profile key protected by Windows.
// Reuse only the encrypted key container in the isolated profile, never the live Cookie database.
const localState = join(dirname(source), 'Local State');
if (existsSync(localState)) copyFileSync(localState, join(profile, 'Local State'));
app.setPath('userData', profile);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const response = await originalFetch(url, init);
  const metadata: Record<string, unknown> = { phase: 'response', path: new URL(String(url)).pathname, status: response.status,
    contentType: response.headers.get('content-type'), redirected: response.redirected };
  try {
    const value = await response.clone().json();
    metadata.code = typeof value.code === 'number' ? value.code : undefined;
    metadata.hasRows = Array.isArray(value.rows); metadata.hasTotal = Number.isFinite(Number(value.total));
    metadata.hasItems = Array.isArray(value.body?.items);
    metadata.publicStatusCode = /^[0-9]+$/.test(String(value.publicresponse?.statuscode)) ? String(value.publicresponse.statuscode) : undefined;
  } catch { metadata.json = false; }
  console.log(JSON.stringify(metadata));
  return response;
};

void app.whenReady().then(async () => {
  const store = new SecureSessionStore(source);
  for (const id of ['market-access', 'oversize-transport', 'transport-practitioner', 'online-car-permit']) {
    const serialized = await store.get(`browser-session.v1.${id}`);
    if (!serialized) { console.log(JSON.stringify({ system: id, saved: false })); continue; }
    const saved = JSON.parse(serialized);
    console.log(JSON.stringify({ system: id, saved: true, hasApi: Boolean(saved.api && Object.keys(saved.api).length), cookies: saved.cookies?.length ?? 0 }));
    const client = id === 'oversize-transport' ? new OversizeTransportClient() : id === 'transport-practitioner' ? new PractitionerClient()
      : id === 'online-car-permit' ? new OnlineCarPermitClient() : new MarketAccessClient();
    if (client instanceof MarketAccessClient) {
      const browser = session.fromPartition(MARKET_ACCESS_PARTITION);
      for (const cookie of saved.cookies ?? []) {
        const details = restoredCookie(cookie, saved.origin); if (details) await browser.cookies.set(details);
      }
      client.initialize();
    } else if (saved.api) client.restoreSession(saved.api);
    try {
      await client.validateSession(AbortSignal.timeout(10_000));
      console.log(JSON.stringify({ system: id, validated: true }));
    } catch (error: any) {
      console.log(JSON.stringify({ system: id, validated: false, errorType: error?.name, errorCode: error?.code,
        causeCode: error?.cause?.cause?.code ?? error?.cause?.code }));
    }
  }
}).catch(() => { console.error('Session diagnostic failed without exposing credentials'); process.exitCode = 1; })
  .finally(() => app.quit());
