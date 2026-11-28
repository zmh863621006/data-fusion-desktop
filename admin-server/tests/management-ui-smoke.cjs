// Run with Node after admin:web:build. Everything is synthetic and localhost-only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const runtime = require('electron');

async function parent() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'df-admin-pagination-'));
  try {
    const env = { ...process.env, DATA_FUSION_MANAGEMENT_UI_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(runtime, [__filename], { env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 120000);
    try { process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code ?? 1)); }); }
    finally { clearTimeout(timer); }
  } finally {
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir())); assert(path.basename(profile).startsWith('df-admin-pagination-'));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function child() {
  const { app, BrowserWindow } = runtime; app.setPath('userData', process.env.DATA_FUSION_MANAGEMENT_UI_PROFILE);
  const now = Date.now(), requests = [], errors = [];
  const customers = Array.from({ length: 36 }, (_, index) => ({ id: `customer-${index}`, name: `测试客户 ${String(index).padStart(2, '0')}`, enabled: 1, created_at: now }));
  const licenses = customers.map((customer, index) => ({ id: `license-${index}`, customer_id: customer.id, customer_name: customer.name, customer_enabled: 1,
    mode: 'online', expires_at: now + 86400000, allowed_systems_json: '["fixture-system"]', allowed_tools_json: '[]', allowed_matters_json: '{"fixture-system":["fixture-matter"]}', max_devices: 1, allow_export: 1, allow_auto_update: 1, status: 'active', created_at: now }));
  const devices = licenses.map((license, index) => ({ id: `device-${index}`, license_id: license.id, customer_name: license.customer_name, device_id: index.toString(16).padStart(64, '0'), status: 'active', activated_at: now, last_seen_at: now }));
  const updates = customers.map((_, index) => ({ id: `release-${index}`, target_type: 'app', platform: 'win32', arch: 'x64', variant: 'standard', version: `1.0.${index}`, url: 'https://fixture.invalid/installer.exe', sha256: 'a'.repeat(64), status: 'published', enabled: 1, published_at: now }));
  const settings = { configured: true, enabled: true, batchLimit: 20, statistics: { libraryHits: 9, providerCacheHits: 3, providerRequests: 2 } };
  const enterprise = { id: 'enterprise-1', name: '核验企业', status: 'success', standard_name: '核验企业', standard_code: '91440300123456789H', legal_person: '原法人', last_verified_at: now - 100 * 86400000,
    revalidation_status: 'different', revalidation_reason: '差异待确认', proposal_json: JSON.stringify({ name: '核验企业', creditCode: '91440300123456789H', legalPerson: '新法人', expected: { name: '核验企业', creditCode: '91440300123456789H', legalPerson: '原法人' } }) };
  const bootstrap = { paginated: true, user: { id: 'fixture', username: 'fixture', role: 'admin' }, tools: [], systems: [{ id: 'fixture-system', name: '测试系统', enabled: 1, version: '1.0.0' }], matters: [{ id: 'fixture-matter', system_id: 'fixture-system', name: '测试事项', enabled: 1 }], customers: [], licenses: [], devices: [], updates: [], audits: [],
    summary: { customers: 36, activeLicenses: 36, activeDevices: 36, enabledSystems: 1, recentLicenses: licenses.slice(0, 6), latestRelease: updates[0], systemLicenseCounts: { 'fixture-system': 36 } } };
  const root = path.resolve(__dirname, '../public');
  const server = require('node:http').createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'); requests.push(`${req.method} ${url.pathname}${url.search}`);
      const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
      if (url.pathname === '/api/admin/bootstrap') { assert.equal(url.searchParams.get('compact'), '1'); return json(bootstrap); }
      const kind = url.pathname.split('/').at(-1), source = { customers, licenses, devices, updates }[kind];
      if (source && req.method === 'GET') {
        let rows = source;
        if (url.searchParams.get('name')) rows = rows.filter(row => row.name.includes(url.searchParams.get('name')));
        if (url.searchParams.get('id')) rows = rows.filter(row => row.id === url.searchParams.get('id'));
        if (url.searchParams.get('licenseId')) rows = rows.filter(row => row.license_id === url.searchParams.get('licenseId'));
        const size = Number(url.searchParams.get('pageSize')) || 20, page = Number(url.searchParams.get('page')) || 1;
        return json({ total: rows.length, rows: rows.slice((page - 1) * size, page * size), page, pageSize: size });
      }
      if (url.pathname === '/api/admin/enterprises/settings') return json(settings);
      if (url.pathname === '/api/admin/enterprises') return json({ total: 1, rows: [enterprise] });
      if (url.pathname === '/api/admin/business-releases') return json({ rows: [], total: 0, configured: true, feedBase: 'https://fixture.invalid', storageMode: 'oss' });
      if (url.pathname.startsWith('/api/')) { res.statusCode = 404; return json({ error: 'Unexpected fixture API' }); }
      const file = path.resolve(root, url.pathname === '/' ? 'index.html' : `.${url.pathname}`);
      if (!file.startsWith(root + path.sep)) { res.statusCode = 404; return res.end(); }
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await fs.readFile(file));
    } catch (error) { errors.push(error.message); res.statusCode = 500; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let main;
  try {
    await app.whenReady(); main = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    const origin = `http://127.0.0.1:${server.address().port}`;
    main.webContents.session.webRequest.onBeforeRequest((details, done) => { const safe = details.url.startsWith(origin) || details.url.startsWith('data:'); if (!safe) errors.push(`external request: ${details.url}`); done({ cancel: !safe }); });
    main.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    const dom = code => main.webContents.executeJavaScript(code).catch(error => { throw new Error(`${error.message}\nScript: ${code}\nConsole: ${JSON.stringify(errors)}`); });
    const waitFor = async code => { for (let n = 0; n < 150; n++) { if (await dom(code)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Timeout: ${code}`); };
    const route = async page => { await dom(`location.hash='/${page}'`); await new Promise(resolve => setTimeout(resolve, 350)); };
    const click = async text => { await dom(`(()=>{const element=[...document.querySelectorAll('button,a')].find(el=>el.textContent.replace(/\\s+/g,'')===${JSON.stringify(text)});if(!element)throw Error('missing button');element.click()})()`); };
    await main.loadURL(origin); await waitFor(`document.body.innerText.includes('运营概览')`);
    assert.equal(await dom(`document.querySelectorAll('.overview-licenses tbody tr.ant-table-row').length`), 6);
    await route('customers'); await waitFor(`document.querySelectorAll('tbody tr.ant-table-row').length===10`);
    assert(requests.some(item => /customers\?.*pageSize=10/.test(item)));
    await dom(`document.querySelector('.ant-pagination-item-2 a').click()`); await waitFor(`document.querySelector('tbody').innerText.includes('测试客户 10')`);
    await route('licenses'); await waitFor(`document.querySelectorAll('tbody tr.ant-table-row').length===10`); await click('签发授权');
    await waitFor(`document.querySelector('input[id$="customerId"]')!==null`);
    await dom(`(()=>{const input=document.querySelector('input[id$="customerId"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'35');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.body.innerText.includes('测试客户 35')`);
    assert(requests.some(item => /customers\?.*name=35/.test(item)));
    await click('取消'); await click('详情'); await click('调整授权'); await waitFor(`document.querySelector('.license-bound-devices').innerText.includes('1 台')`);
    assert(requests.some(item => /devices\?.*licenseId=license-0/.test(item))); await click('取消');
    await route('devices'); await waitFor(`document.querySelectorAll('tbody tr.ant-table-row').length===10`);
    await route('updates'); await waitFor(`document.querySelectorAll('tbody tr.ant-table-row').length===10`); assert(requests.some(item => /updates\?.*platform=win32/.test(item)));
    await route('enterprises'); await waitFor(`document.body.innerText.includes('差异待确认')`); assert.equal(await dom(`document.body.innerText.includes('超过 90 天')`), true);
    await click('核对差异'); await waitFor(`document.querySelector('input[id$="legalPerson"]')?.value==='新法人'`);
    assert.equal(await dom(`document.querySelector('.ant-modal').innerText.includes('原法人')`), true); await click('取消');
    const out = path.resolve(__dirname, '../../.tmp/admin-management-ui'); await fs.mkdir(out, { recursive: true });
    await new Promise(resolve => setTimeout(resolve, 500));
    await fs.writeFile(path.join(out, 'enterprise-desktop.png'), (await main.webContents.capturePage()).toPNG());
    main.setContentSize(390, 844); await new Promise(resolve => setTimeout(resolve, 700));
    await fs.writeFile(path.join(out, 'enterprise-mobile.png'), (await main.webContents.capturePage()).toPNG());
    assert.equal(await dom(`document.documentElement.scrollWidth <= innerWidth + 1`), true);
    assert.equal(await dom(`document.querySelector('.admin-main-column').getBoundingClientRect().left===0`), true);
    assert.deepEqual(errors, []); console.log(`PASS: compact overview, paged lists, customer lookup, bound devices and enterprise revalidation UI (${requests.length} local requests)`);
  } finally { main?.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(); }
}

if (typeof runtime === 'string') parent().catch(error => { console.error(error); process.exitCode = 1; });
else child().catch(error => { console.error(error); runtime.app.exit(1); });
