import { app, BrowserWindow, session, webContents } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { HRSS_SOURCE_CERTIFICATE_TRUST } from '../src/core/config/source-certificate-pins';
import { HRSS_LOGIN_URL } from '../src/plugins/guangdong-hrss/catalog';
import { installSourceCertificateTrust } from '../src/main/source-certificate-trust';
import { LoginTabController } from '../src/main/login-tab';

// Optional, real-network check of the public login page. Never loads a user's profile or submits a login.
assert(process.env.DATA_FUSION_UI_TEST_PROFILE, 'Use the isolated UI runner');
app.setPath('userData', process.env.DATA_FUSION_UI_TEST_PROFILE!);
app.on('window-all-closed', () => {});
const evidence = resolve('.tmp', 'hrss-fresh-certificate-' + Date.now());
const controller = new LoginTabController();

void app.whenReady().then(async () => {
  await mkdir(evidence, { recursive: true });
  let prompts = 0, reads = 0, writes = 0, acceptedAuthorityChecks = 0;
  const certificateChecks: Array<{ errorCode: number; result: number }> = [];
  const browser = session.fromPartition(HRSS_SOURCE_CERTIFICATE_TRUST.partition);
  const originalInstall = browser.setCertificateVerifyProc.bind(browser);
  browser.setCertificateVerifyProc = procedure => originalInstall(procedure ? (request, callback) => {
    procedure(request, result => {
      if (request.hostname === 'hrss.gdgov.cn' && request.errorCode === -202 && result === 0) acceptedAuthorityChecks++;
      if (request.hostname === 'hrss.gdgov.cn') certificateChecks.push({ errorCode: request.errorCode, result });
      callback(result);
    });
  } : null);
  await installSourceCertificateTrust({ ...HRSS_SOURCE_CERTIFICATE_TRUST,
    vault: { get: async () => { reads++; return null; }, set: async () => { writes++; } },
    prompt: async () => { prompts++; return false; } });
  const main = new BrowserWindow({ width: 1440, height: 900, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await main.loadURL('data:text/html,<title>Public login smoke</title>');
  controller.open(main, { id: 'guangdong-hrss', name: '广东人社一体化', loginPage: {
    url: HRSS_LOGIN_URL, partition: HRSS_SOURCE_CERTIFICATE_TRUST.partition, allowedOrigin: HRSS_SOURCE_CERTIFICATE_TRUST.origin } });
  main.showInactive();
  const deadline = Date.now() + 30_000;
  let source, ready = false;
  while (Date.now() < deadline) {
    source = webContents.getAllWebContents().find(contents => contents.id !== main.webContents.id && contents.getURL().startsWith(HRSS_SOURCE_CERTIFICATE_TRUST.origin));
    if (controller.state().tabs[0]?.error) throw new Error('Public login page failed to load');
    if (source) {
      const debug = source.debugger;
      if (!debug.isAttached()) debug.attach('1.3');
      ready = await debug.sendCommand('Runtime.evaluate', { returnByValue: true, expression: `location.pathname === '/sso/login.html'
        && /登录|扫码|二维码/.test(document.body?.innerText || '')
        && [...document.images].some(image => image.complete && image.naturalWidth >= 150 && image.naturalWidth === image.naturalHeight)` }).then(result => result.result?.value === true).catch(() => false);
      if (ready) break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) console.log(JSON.stringify({ ready, sourceCreated: !!source, sourceLoading: source?.isLoadingMainFrame(), certificateChecks, prompts }));
  assert(ready && source, 'Public login page and QR image must render in a completely new profile');
  assert(acceptedAuthorityChecks > 0, 'Must exercise the configured authority-invalid exception');
  assert.equal(prompts, 0); assert.equal(reads, 0); assert.equal(writes, 0);
  const debug = source.debugger;
  const shot = await debug.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: false, captureBeyondViewport: false });
  await writeFile(join(evidence, 'login.png'), Buffer.from(shot.data, 'base64'));
  const report = { status: 'pass', freshProfile: true, existingCertificateApprovals: 0, certificatePrompts: prompts,
    preferencesReads: reads, preferencesWrites: writes, acceptedAuthorityChecks, loginOrigin: HRSS_SOURCE_CERTIFICATE_TRUST.origin,
    loginPath: '/sso/login.html', qrImageLoaded: true, submittedLogin: false, collectorStarted: false, productionMutations: 0, evidence };
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  controller.close(); main.destroy(); app.exit(0);
}).catch(error => { console.error(error.name + ': ' + error.message); controller.close(); app.exit(1); });
