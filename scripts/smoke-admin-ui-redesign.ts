import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import type { UpdateRecord } from '../admin-server/web/src/types';

// An offline browser regression of the real admin production build. The only
// server is a local fixture; no real server, credentials, database or profile is used.
const now = Date.now();
const systems = [
  ['market-access', '广东省市场准入系统'], ['government-info', '政务综合信息平台'],
  ['transport-practitioner', '广东省道路运输从业人员管理服务平台'],
  ['oversize-transport', '广东省交通运输厅大件运输许可系统'], ['online-car-permit', '惠州市网约车监管系统（车证）'],
].map(([id, name]) => ({ id, name, version: '1.0.0', enabled: 1, created_at: now }));
const enterprise = {
  id: 'enterprise-fixture', name: '仅供界面测试的 示例科技有限公词', credit_code: '914400000000000001',
  status: 'partial', source_system: 'government-info', reason: '本地虚构界面数据，需要人工核对法人信息，不会发起付费查询。',
  standard_name: '示例科技有限公司', standard_code: '914400000000000001', legal_person: '',
  source: 'manual', updated_at: now, attempts: 1, queried_at: now,
};
const bootstrap = {
  user: { id: 'fixture-admin', username: 'fixture-admin', role: 'admin' }, systems,
  tools: [{ id: 'health-publicity', name: '卫健局双公示工具', version: '1.0.0' }],
  matters: [{ id: 'fixture-matter', system_id: 'government-info', name: '界面测试事项', department_name: '水务局', enabled: 1, created_at: now },
    { id: 'fixture-market', system_id: 'market-access', name: '市场测试事项', department_name: '业务事项', enabled: 1, created_at: now }],
  customers: [{ id: 'fixture-customer', name: '示例区政务服务中心（仅供本地界面测试）', contact: '测试联系人 138****0001', enabled: 1, created_at: now }],
  licenses: [{ id: 'fixture-license', customer_id: 'fixture-customer', customer_name: '示例区政务服务中心', mode: 'online', expires_at: now + 86400000 * 30,
    allowed_systems_json: JSON.stringify(['market-access']), allowed_tools_json: '["health-publicity"]', allowed_matters_json: '{"market-access":["fixture-market"]}',
    max_devices: 2, allow_export: 1, allow_auto_sync: 0, allow_auto_update: 1, status: 'active', created_at: now }],
  devices: [{ id: 'fixture-device', license_id: 'fixture-license', customer_name: '示例区政务服务中心', device_id: 'a'.repeat(64), status: 'active', activated_at: now, last_seen_at: now }],
  updates: [{ id: 'fixture-update', target_type: 'app', version: '1.0.0', url: 'https://blocked.invalid/example.exe', sha256: '0'.repeat(64), notes: '虚构版本，仅供本地界面测试', published_at: now, enabled: 1 },
    ...[
      { id: 'fixture-same-windows', platform: 'win32', arch: 'x64', installer: 'nsis', fileName: '数据融合助手-安装包-1.0.2-x64.exe', notes: 'Windows 同版本测试记录' },
      { id: 'fixture-same-linux-x64', platform: 'linux', arch: 'x64', installer: 'deb', fileName: '数据融合助手-麒麟版-1.0.2-x64.deb', notes: '麒麟 x86_64 同版本测试记录' },
      { id: 'fixture-same-linux-arm64', platform: 'linux', arch: 'arm64', installer: 'deb', fileName: '数据融合助手-麒麟版-1.0.2-arm64.deb', notes: '麒麟 ARM64 同版本测试记录' },
    ].map(target => ({ ...target, target_type: 'app', version: '1.0.2', url: 'https://blocked.invalid/' + target.fileName,
      sha256: '0'.repeat(64), bytes: 4096, published_at: 0, enabled: 0, status: 'draft', managed: true })),
  ] as UpdateRecord[],
  audits: [],
};

let main: BrowserWindow | undefined;
let directory = '';
let profileDirectory = '';
let origin = '';
let authenticated = false;
let checks = 0;
const blockedRequests: string[] = [];
const pageErrors: string[] = [];
const requests: string[] = [];
const scopeWrites: Array<Record<string, any>> = [];
let conflictScopeOnce = false;
const releaseWrites: Array<{ id: string; enabled: boolean }> = [];
const releaseNotes = '本地虚构上传备注：测试 + 校验 & 发布';
let releaseUploadCalls = 0;
const root = resolve('admin-server/public');
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
  const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/api/')) {
    requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/api/admin/bootstrap') return json(authenticated ? 200 : 401, authenticated ? bootstrap : { error: 'fixture login required' });
    if (url.pathname === '/api/admin/session/restore') throw new Error('Retired remembered-login endpoint must not be requested');
    if (url.pathname === '/api/admin/captcha') return json(200, { id: 'fixture-captcha', expiresAt: now + 86400000,
      image: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="140" height="44"><rect width="140" height="44" fill="#fafafc"/><text x="25" y="31" fill="#007aff" font-size="26">A7B9C</text></svg>').toString('base64')}` });
    if (url.pathname === '/api/admin/login') {
      let body = ''; for await (const chunk of req) body += chunk;
      const value = JSON.parse(body);
      assert.equal(value.username, 'fixture-admin'); assert.equal(value.password, 'FixtureOnly!123'); assert.equal(value.captcha, 'A7B9C');
      assert.equal(Object.hasOwn(value, 'remember'), false, 'No persistent-login request is sent');
      authenticated = true; return json(200, { username: 'fixture-admin' });
    }
    if (url.pathname === '/api/admin/updates/upload' && req.method === 'POST') {
      assert(authenticated); releaseUploadCalls++;
      assert.equal(req.headers['content-type'], 'application/octet-stream');
      const platform = url.searchParams.get('platform'), arch = url.searchParams.get('arch');
      assert(['win32', 'linux'].includes(platform!)); assert(platform === 'win32' ? arch === 'x64' : arch === 'arm64');
      const fileName = platform === 'linux' ? '数据融合助手-麒麟版-1.0.3-arm64.deb' : 'DataFusion-Setup-1.0.3-x64.exe';
      assert.equal(url.searchParams.get('version'), '1.0.3'); assert.equal(url.searchParams.get('filename'), fileName);
      assert.equal(url.searchParams.has('notes'), false);
      assert.equal(Buffer.from(String(req.headers['x-release-notes-base64']), 'base64').toString('utf8'), releaseNotes);
      assert.equal(req.headers['x-content-sha256'], undefined, 'The server owns the artifact hash');
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); assert.deepEqual([...bytes], platform === 'linux' ? [33,60,97,114,99,104,62,10] : [77, 90, 0, 0]);
      const record: UpdateRecord = { id: platform === 'linux' ? 'fixture-uploaded-arm64' : 'fixture-uploaded-update', target_type: 'app',
        platform: platform as 'win32' | 'linux', arch: arch as 'x64' | 'arm64', installer: platform === 'linux' ? 'deb' : 'nsis', version: '1.0.3', fileName,
        sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, url: origin + '/api/releases/fixture-uploaded-update/' + encodeURIComponent(fileName),
        notes: releaseNotes, enabled: 0, published_at: 0, status: 'draft', managed: true };
      bootstrap.updates.push(record); return json(201, record);
    }
    if (url.pathname === '/api/admin/updates/fixture-uploaded-update' && req.method === 'PATCH') {
      assert(authenticated); let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); assert.equal(body.confirmPassword, 'FixtureOnly!123'); assert.equal(typeof body.enabled, 'boolean');
      assert.deepEqual(Object.keys(body).sort(), ['confirmPassword', 'enabled']);
      releaseWrites.push({ id: 'fixture-uploaded-update', enabled: body.enabled });
      const record = bootstrap.updates.find(item => item.id === 'fixture-uploaded-update')!;
      record.enabled = body.enabled ? 1 : 0; record.status = body.enabled ? 'published' : 'disabled';
      if (body.enabled) record.published_at = now;
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/admin/licenses/fixture-license/scope' && req.method === 'POST') {
      assert(authenticated);
      let raw='';for await(const chunk of req)raw+=chunk;
      const value=JSON.parse(raw), license=bootstrap.licenses[0];
      if(conflictScopeOnce){conflictScopeOnce=false;return json(409,{error:'授权范围已被其他操作修改，请刷新后重新调整',code:'LICENSE_SCOPE_CONFLICT'});}
      assert.deepEqual(Object.keys(value).sort(),['allowedMatters','allowedSystems','allowedTools','expectedScope']);
      assert.deepEqual(value.expectedScope,{allowedSystems:JSON.parse(license.allowed_systems_json),allowedTools:JSON.parse(license.allowed_tools_json),allowedMatters:JSON.parse(license.allowed_matters_json)});
      assert(value.allowedSystems.length||value.allowedTools.length);
      assert.deepEqual(Object.keys(value.allowedMatters).sort(),[...value.allowedSystems].sort());
      for(const id of value.allowedSystems)assert(value.allowedMatters[id].length,'New system requires explicitly selected matters');
      scopeWrites.push(value);
      license.allowed_systems_json=JSON.stringify(value.allowedSystems);
      license.allowed_tools_json=JSON.stringify(value.allowedTools);
      license.allowed_matters_json=JSON.stringify(value.allowedMatters);
      return json(200,{ok:true,changed:true,requiresOfflineReissue:license.mode==='offline'});
    }
    if (url.pathname === '/api/admin/enterprises/settings') return json(200, { configured: true, enabled: true, batchLimit: 20 });
    if (url.pathname === '/api/admin/enterprises') return json(200, { rows: [enterprise], total: 1 });
    if (url.pathname === '/api/admin/enterprises/enterprise-fixture/history') return json(200, [
      { id: 'history1', actor: 'fixture-admin', source: 'manual', before_json: '{"name":"原始示例名称"}', after_json: '{"name":"示例科技有限公司"}', created_at: now },
      { id: 'history2', actor: 'fixture-admin', source: 'manual', before_json: 'legacy evidence', after_json: '{invalid json', created_at: now - 1000 },
    ]);
    if (url.pathname === '/api/admin/users') return json(200, [
      { id: 'fixture-admin', username: 'fixture-admin', role: 'admin', enabled: 1, created_at: now },
      { id: 'fixture-operator', username: 'fixture-operator', role: 'operator', enabled: 1, created_at: now, lockedForSeconds: 60 },
    ]);
    if (url.pathname === '/api/admin/sessions') return json(200, [
      { id: 'session-fixture', ip_address: '127.0.0.1', user_agent: 'Local UI regression / Chromium', created_at: now, last_seen_at: now, expires_at: now + 3600000, current: 1 },
    ]);
    if (url.pathname === '/api/admin/security-events') return json(200, { rows: [{ id: 'security-fixture', event: 'login.success', username: 'fixture-admin', ip_address: '127.0.0.1', created_at: now }], total: 1 });
    if (url.pathname === '/api/admin/audits') return json(200, { rows: [{ id: 'audit-fixture', user_id: 'fixture-admin', username: 'fixture-admin', action: 'license.created', target_type: 'license', target_id: 'fixture-license', metadata_json: '{"fixture":true}', created_at: now }], total: 1 });
    return json(500, { error: `Unexpected fixture API: ${req.method} ${url.pathname}` });
  }
  try {
    const path = resolve(root, url.pathname === '/' ? 'index.html' : `.${url.pathname}`);
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' }); res.end(await readFile(path));
  } catch { res.writeHead(404); res.end('not found'); }
});

const dom = <T = any>(script: string): Promise<T> => main!.webContents.executeJavaScript(script);
async function until(check: () => Promise<boolean>, label: string) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
async function settle() { await new Promise(resolve => setTimeout(resolve, 240)); }
async function clickText(text: string, selector = 'button') {
  const found = await dom<boolean>(`(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.replace(/\\s+/g,'') === ${JSON.stringify(text.replace(/\s+/g, ''))} && node.getBoundingClientRect().width > 0); if (!node) return false; node.click(); return true; })()`);
  assert.equal(found, true, `click ${text}`); await settle();
}
async function setInput(selector: string, value: string) {
  await dom(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) throw new Error('input missing'); const prototype=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
}
async function screenshot(name: string) { await writeFile(join(directory, `${name}.png`), (await main!.webContents.capturePage()).toPNG()); }
async function verifyBounds(label: string) {
  await settle();
  await until(() => dom(`![...document.querySelectorAll('.ant-modal-content,.ant-drawer-content-wrapper')].some(node => [...node.classList].some(name => /(?:appear|enter)(?:-active|-start)?$/.test(name)))`), `${label} animation`);
  const result = await dom<{ width: number; scroll: number; outside: string[] }>(`(() => { const width = document.documentElement.clientWidth; return { width, scroll: document.documentElement.scrollWidth, outside: [...document.querySelectorAll('.ant-modal-content,.ant-drawer-content-wrapper')].filter(node => node.getBoundingClientRect().width && getComputedStyle(node).visibility !== 'hidden').filter(node => {const r=node.getBoundingClientRect();return r.left < -1 || r.right > width+1;}).map(node=>node.className) }; })()`);
  assert.ok(result.scroll <= result.width + 1, `${label}: document overflows ${JSON.stringify(result)}`);
  assert.deepEqual(result.outside, [], `${label}: overlay outside viewport`); checks++;
}
async function route(page: string) {
  const titles: Record<string, string> = { overview: '运营概览', customers: '客户管理', enterprises: '企业信息管理', licenses: '授权管理', devices: '设备管理', systems: '业务系统', updates: '版本更新', audits: '操作审计', security: '账号与安全' };
  await dom(`window.location.hash=${JSON.stringify('/' + page)}`);
  await until(() => dom(`document.querySelector('.ant-page-header-heading-title')?.textContent === ${JSON.stringify(titles[page])}`), `route ${page}`);
  await until(() => dom(`document.querySelector('.admin-content .ant-table-tbody tr:not(.ant-table-measure-row)') !== null`), `${page} table`);
  await settle();
}
async function modal(openText: string, label: string) {
  await clickText(openText);
  await until(() => dom(`Boolean([...document.querySelectorAll('.ant-modal-content')].some(node => node.getBoundingClientRect().width > 0))`), label);
  await verifyBounds(label); await screenshot(label);
  await dom(`document.querySelector('.ant-modal:not([style*="display: none"]) .ant-modal-close')?.click()`);
  await until(() => dom(`![...document.querySelectorAll('.ant-modal-content')].some(node => node.getBoundingClientRect().width > 0)`), `${label} close`);
}
async function verifyReleaseTargets() {
  await route('updates');
  const rowIds = () => dom<string[]>(`[...document.querySelectorAll('.ant-table-tbody tr[data-row-key]')].map(row=>row.getAttribute('data-row-key')).filter(id=>id?.startsWith('fixture-'))`);
  const captureTarget = async (name: string) => {
    for (const width of [1440, 600]) {
      main!.setContentSize(width, 1000);
      await verifyBounds(`release-target-${name}-${width}`);
      const bounds = await dom<boolean>(`[...document.querySelectorAll('.release-target-picker .ant-segmented')].every(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=document.documentElement.clientWidth+1;})`);
      assert(bounds, 'Target controls remain inside the viewport'); checks++;
      await screenshot(`release-target-${name}-${width}`);
    }
    main!.setContentSize(1440, 1000);
  };
  assert.deepEqual(await rowIds(), ['fixture-update', 'fixture-same-windows']); checks++;
  await captureTarget('windows');
  await clickText('信创', '.release-target-picker .ant-segmented-item-label');
  await until(async () => (await rowIds()).join() === 'fixture-same-linux-x64', 'only Kylin x64 rows'); checks++;
  assert.equal(await dom(`document.querySelector('.release-guidance').innerText.includes('1.0.20')`), true); checks++;
  await captureTarget('linux-x64');
  await clickText('ARM64 · 飞腾 / 鲲鹏', '.release-target-picker .ant-segmented-item-label');
  await until(async () => (await rowIds()).join() === 'fixture-same-linux-arm64', 'only Kylin ARM64 rows'); checks++;
  assert.equal(await dom(`document.querySelector('.release-architecture-notice').innerText.includes('目标电脑实测')`), true); checks++;
  await captureTarget('linux-arm64');
  await clickText('发布新版本');
  await until(() => dom(`Boolean(document.querySelector('.release-upload-modal input#version'))`), 'ARM64 upload form');
  assert.equal(await dom(`document.querySelector('.release-native-file').accept`), '.deb'); checks++;
  assert.equal(await dom(`document.querySelector('.release-upload-modal').innerText.includes('麒麟 ARM64 安装包')`), true); checks++;
  assert.equal(await dom(`document.querySelectorAll('.release-target-picker input[type="radio"]').length > 0 && [...document.querySelectorAll('.release-target-picker input[type="radio"]')].every(input=>input.disabled)`), true); checks++;
  // Even a direct click cannot change the selected target while its upload
  // dialog is open; the API separately verifies the frozen target response.
  await clickText('Windows', '.release-target-picker .ant-segmented-item-label');
  assert.equal(await dom(`document.querySelector('.release-upload-modal .ant-modal-title').innerText.includes('ARM64')`), true); checks++;
  await setInput('.release-upload-modal input#version', '1.0.3');
  await setInput('.release-upload-modal textarea#notes', releaseNotes);
  await dom(`(() => {const input=document.querySelector('.release-native-file'),transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([33,60,97,114,99,104,62,10])],'数据融合助手-麒麟版-1.0.3-arm64.deb',{type:'application/octet-stream'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await clickText('上传并校验');
  await until(() => dom(`Boolean(document.querySelector('.release-upload-modal .ant-alert-message')?.textContent.includes('上传完成'))`), 'ARM64 draft uploaded');
  assert.equal(bootstrap.updates.find(row => row.id === 'fixture-uploaded-arm64')?.arch, 'arm64');
  assert.equal(bootstrap.updates.find(row => row.id === 'fixture-uploaded-arm64')?.status, 'draft');
  assert.deepEqual(releaseWrites, []); checks++;
  for (const width of [1440, 600]) { main!.setContentSize(width, 1000); await verifyBounds(`release-arm64-draft-${width}`); await screenshot(`release-arm64-draft-${width}`); }
  main!.setContentSize(1440, 1000); await clickText('暂不发布');
  await until(() => dom(`![...document.querySelectorAll('.ant-modal-content')].some(node=>node.getBoundingClientRect().width>0)`), 'ARM64 draft dialog closed');
  await clickText('Windows', '.release-target-picker .ant-segmented-item-label');
  await until(async () => (await rowIds()).join() === 'fixture-update,fixture-same-windows', 'Windows rows restored without Linux draft'); checks++;
}
async function verifyReleasePublishing() {
  await route('updates'); await clickText('发布新版本');
  const uploadsBefore = releaseUploadCalls;
  await until(() => dom(`Boolean(document.querySelector('.release-upload-modal input#version'))`), 'release upload form');
  assert.equal(await dom(`getComputedStyle(document.querySelector('.release-native-file')).display`), 'none'); checks++;
  await setInput('.release-upload-modal input#version', '1.0.3'); await setInput('.release-upload-modal textarea#notes', releaseNotes);
  await dom(`(() => { const input=document.querySelector('.release-native-file'), transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([77,90,0,0])],'DataFusion-Setup-1.0.3-x64.exe',{type:'application/octet-stream'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await clickText('上传并校验');
  await until(() => dom(`Boolean(document.querySelector('.release-upload-modal .ant-alert-message')?.textContent.includes('上传完成'))`), 'server verified release');
  assert.equal(releaseUploadCalls, uploadsBefore + 1); assert.deepEqual(releaseWrites, [], 'An upload never publishes automatically'); checks++;
  assert.equal(bootstrap.updates.find(row => row.id === 'fixture-uploaded-update')?.status, 'draft'); checks++;
  assert(await dom(`document.querySelector('.release-upload-modal').innerText.includes('服务器 SHA256')`)); checks++;
  for (const width of [1440, 1180, 600]) { main!.setContentSize(width, 1000); await verifyBounds(`update-uploaded-${width}`); await screenshot(`update-uploaded-${width}`); }
  main!.setContentSize(1440, 1000); await clickText('核对并发布');
  await until(() => dom(`Boolean([...document.querySelectorAll('.ant-modal-title')].find(node=>node.textContent.includes('发布版本 1.0.3')))`), 'confirm publication');
  await clickText('确认发布'); assert.deepEqual(releaseWrites, [], 'The password form must block empty confirmation'); checks++;
  await setInput('.ant-modal input[type="password"]', 'FixtureOnly!123'); await clickText('确认发布');
  await until(async () => bootstrap.updates.find(row => row.id === 'fixture-uploaded-update')?.status === 'published', 'release published');
  await until(() => dom(`![...document.querySelectorAll('.ant-modal-content')].some(node=>node.getBoundingClientRect().width>0)`), 'publish dialog closed');
  assert.deepEqual(releaseWrites, [{ id: 'fixture-uploaded-update', enabled: true }]); checks++;
  await verifyBounds('update-published'); await screenshot('update-published');
  await dom(`(() => { const row=[...document.querySelectorAll('.ant-table-tbody tr')].find(node=>node.textContent.includes('1.0.3'));[...row.querySelectorAll('button')].find(node=>node.textContent.trim()==='下线').click(); })()`);
  await until(() => dom(`Boolean([...document.querySelectorAll('.ant-modal-title')].find(node=>node.textContent.includes('下线版本 1.0.3')))`), 'confirm unpublish');
  await setInput('.ant-modal input[type="password"]', 'FixtureOnly!123'); await clickText('确认下线');
  await until(async () => bootstrap.updates.find(row => row.id === 'fixture-uploaded-update')?.status === 'disabled', 'release disabled');
  await until(() => dom(`![...document.querySelectorAll('.ant-modal-content')].some(node=>node.getBoundingClientRect().width>0)`), 'unpublish dialog closed');
  assert.deepEqual(releaseWrites, [{ id: 'fixture-uploaded-update', enabled: true }, { id: 'fixture-uploaded-update', enabled: false }]); checks++;
}
async function drawer(openText: string, label: string) {
  await clickText(openText);
  await until(() => dom(`Boolean(document.querySelector('.ant-drawer-open'))`), label);
  await verifyBounds(label);
}
async function closeDrawer() {
  await dom(`document.querySelector('.ant-drawer-open .ant-drawer-close')?.click()`);
  await until(() => dom(`!document.querySelector('.ant-drawer-open')`), 'drawer close');
  await settle();
}

async function openScopeSelect(label: string) {
  assert.equal(await dom(`(() => {const label=[...document.querySelectorAll('.license-scope-modal .ant-form-item-label label')].find(node=>node.textContent.trim()===${JSON.stringify(label)});const target=label?.closest('.ant-form-item')?.querySelector('.ant-select-selector');if(!target)return false;target.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));return true;})()`),true,`Open scope selector ${label}`);
  await settle();
}

async function verifyScopeEditing() {
  await route('licenses');await drawer('详情','scope-edit-interaction');await clickText('调整授权');
  await until(()=>dom(`Boolean(document.querySelector('.license-scope-modal'))`),'Scope editor');
  assert.equal(await dom(`document.querySelector('.license-scope-modal').innerText.includes('影响此授权绑定的全部设备')`),true);checks++;
  await openScopeSelect('授权业务系统');
  assert.equal(await dom(`(() => {const node=[...document.querySelectorAll('.ant-select-item-option-content')].find(node=>node.textContent==='政务综合信息平台'&&node.getBoundingClientRect().width);node?.click();return !!node;})()`),true);checks++;
  await dom(`(() => {const title=document.querySelector('.license-scope-modal .ant-modal-title');title.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));title.click();})()`);await settle();
  const beforeWrites=scopeWrites.length;
  await clickText('保存授权范围','.license-scope-modal button');
  await until(()=>dom(`document.querySelector('.license-scope-modal').innerText.includes('请明确选择至少一个业务事项')`),'new matter selection is required');
  assert.equal(scopeWrites.length,beforeWrites,'Selecting a new system cannot silently grant all matters');checks++;
  await openScopeSelect('政务综合信息平台 · 业务事项');
  assert.equal(await dom(`(() => {const title=[...document.querySelectorAll('.ant-select-tree-title')].find(node=>node.textContent==='界面测试事项'&&node.getBoundingClientRect().width);const checkbox=title?.closest('.ant-select-tree-treenode')?.querySelector('.ant-select-tree-checkbox');checkbox?.click();return !!checkbox;})()`),true);checks++;
  await dom(`(() => {const title=document.querySelector('.license-scope-modal .ant-modal-title');title.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));title.click();})()`);await settle();
  await verifyBounds('scope-explicit-system-add');await screenshot('scope-explicit-system-add');
  const fixed={expiresAt:bootstrap.licenses[0].expires_at,devices:JSON.stringify(bootstrap.devices),maxDevices:bootstrap.licenses[0].max_devices,customerId:bootstrap.licenses[0].customer_id,allowExport:bootstrap.licenses[0].allow_export};
  await clickText('保存授权范围','.license-scope-modal button');
  await until(()=>dom(`!document.querySelector('.license-scope-modal')`),'scope saved');
  assert.deepEqual(JSON.parse(bootstrap.licenses[0].allowed_systems_json),['market-access','government-info']);
  assert.deepEqual(JSON.parse(bootstrap.licenses[0].allowed_matters_json),{'market-access':['fixture-market'],'government-info':['fixture-matter']});
  assert.deepEqual({expiresAt:bootstrap.licenses[0].expires_at,devices:JSON.stringify(bootstrap.devices),maxDevices:bootstrap.licenses[0].max_devices,customerId:bootstrap.licenses[0].customer_id,allowExport:bootstrap.licenses[0].allow_export},fixed);checks++;
  await drawer('详情','scope-conflict-detail');await clickText('调整授权');
  conflictScopeOnce=true;
  await clickText('保存授权范围','.license-scope-modal button');
  await until(()=>dom(`document.querySelector('.license-scope-modal').innerText.includes('当前修改尚未保存')`),'scope conflict is visible');
  assert.equal(await dom(`[...document.querySelectorAll('.license-scope-modal button')].find(node=>node.textContent.includes('保存授权范围'))?.disabled`),true);checks++;
  await verifyBounds('scope-conflict');await screenshot('scope-conflict');
  await clickText('刷新授权','.license-scope-modal button');await until(()=>dom(`!document.querySelector('.license-scope-modal')`),'conflict refresh');
  bootstrap.licenses[0].mode='offline';
  await clickText('刷新','.admin-topbar button');
  await route('overview');await route('licenses');await drawer('详情','scope-offline-detail');
  await clickText('调整授权');await until(()=>dom(`Boolean(document.querySelector('.license-scope-modal'))`),'offline editor');
  assert.equal(await dom(`document.querySelector('.license-scope-modal').innerText.includes('已交付的旧文件不会远程失效')`),true);checks++;
  await verifyBounds('scope-offline-notice');await screenshot('scope-offline-notice');
  await clickText('取消','.license-scope-modal button');await closeDrawer();
  bootstrap.licenses[0].mode='online';
  await clickText('刷新','.admin-topbar button');
  await drawer('详情','scope-tools-only-detail');await clickText('调整授权');
  assert.equal(await dom(`(() => {const label=[...document.querySelectorAll('.license-scope-modal .ant-form-item-label label')].find(node=>node.textContent.trim()==='授权业务系统');const target=label?.closest('.ant-form-item')?.querySelector('.ant-select-clear');if(!target)return false;target.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));target.click();return true;})()`),true);
  await settle();await verifyBounds('scope-tools-only');await screenshot('scope-tools-only');
  await clickText('保存授权范围','.license-scope-modal button');await until(()=>dom(`!document.querySelector('.license-scope-modal')`),'tools-only saved');
  assert.deepEqual(JSON.parse(bootstrap.licenses[0].allowed_systems_json),[]);
  assert.deepEqual(JSON.parse(bootstrap.licenses[0].allowed_matters_json),{});
  assert.deepEqual(JSON.parse(bootstrap.licenses[0].allowed_tools_json),['health-publicity']);checks++;
  bootstrap.user.role='viewer';await clickText('刷新','.admin-topbar button');
  await drawer('详情','scope-viewer-detail');
  assert.equal(await dom(`[...document.querySelectorAll('.ant-drawer-open button')].some(node=>node.textContent.includes('调整授权'))`),false,'Viewers have no scope editor entry');checks++;
  await closeDrawer();bootstrap.user.role='admin';await clickText('刷新','.admin-topbar button');
}

async function run() {
  await mkdir(resolve('.tmp'), { recursive: true });
  directory = await mkdtemp(join(resolve('.tmp'), 'admin-ui-redesign-'));
  profileDirectory = process.env.DATA_FUSION_UI_TEST_PROFILE || join(directory, 'isolated-profile');
  app.setPath('userData', profileDirectory);
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  await app.whenReady();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
  main = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  main.webContents.setFrameRate(60);
  main.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(origin + '/') || details.url.startsWith('data:') || details.url.startsWith('devtools:');
    if (!allowed) blockedRequests.push(details.url); callback({ cancel: !allowed });
  });
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  main.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(origin)) event.preventDefault(); });
  main.webContents.on('console-message', (event) => { if (event.level === 'error') pageErrors.push(event.message); });
  await main.loadURL(origin);
  await until(() => dom(`Boolean(document.querySelector('.captcha-image img'))`), 'captcha loaded');
  assert.equal(await dom(`Boolean(document.querySelector('input[autocomplete="current-password"]'))`), true); checks++;
  assert.equal(await dom(`(() => { const form=document.querySelector('form');return form.getAttribute('action')==='/api/admin/login'&&form.getAttribute('method')==='post'&&form.autocomplete==='on'; })()`), true); checks++;
  assert.equal(await dom(`Boolean(document.querySelector('input[name="username"][autocomplete="username"]'))`), true); checks++;
  assert.equal(await dom(`document.querySelector('.login-page').innerText.includes('账号密码可由浏览器保存并自动填充')`), true); checks++;
  assert.equal(await dom(`Boolean(document.querySelector('.login-page input[type="checkbox"]')) || /7 天免输密码|记住登录/.test(document.querySelector('.login-page').innerText)`), false); checks++;
  for (const width of [1440, 1180, 600]) { main.setContentSize(width, 1000); await verifyBounds(`login-${width}`); await screenshot(`login-${width}`); }
  main.setContentSize(1440, 1000);
  await setInput('input[name="username"]', 'fixture-admin');
  await setInput('input[name="password"]', 'FixtureOnly!123');
  await setInput('input[aria-label="图片验证码"]', 'A7B9C');
  await dom(`document.querySelector('form').requestSubmit()`);
  await until(() => dom(`Boolean(document.querySelector('.admin-content'))`), 'fixture login'); checks++;
  const pages = ['overview', 'customers', 'enterprises', 'licenses', 'devices', 'systems', 'updates', 'audits', 'security'];
  for (const width of [1440, 1180, 600]) {
    main.setContentSize(width, 1000); await settle();
    for (const page of pages) { await route(page); await verifyBounds(`${page}-${width}`); await screenshot(`${page}-${width}`); }
    await route('customers'); await modal('新增客户', `customer-create-${width}`);
    await route('licenses'); await modal('签发授权', `license-create-${width}`);
    await drawer('详情', `license-detail-${width}`); await screenshot(`license-detail-${width}`);
    await modal('续期', `license-renew-${width}`); await modal('调整授权', `license-scope-${width}`); await closeDrawer();
    await route('systems'); await modal('维护', `system-edit-${width}`);
    await route('updates'); await modal('发布新版本', `update-create-${width}`); await modal('下线', `update-confirm-${width}`);
    await route('enterprises'); await modal('登记企业', `enterprise-create-${width}`); await modal('修正', `enterprise-edit-${width}`);
    await drawer('依据', `enterprise-detail-${width}`);
    for (const label of ['标准信息', '查询依据', '历史记录']) { await clickText(label, '.enterprise-details-tabs [role="tab"]'); await verifyBounds(`enterprise-${label}-${width}`); }
    await clickText('历史记录', '.enterprise-details-tabs [role="tab"]');
    await until(() => dom(`document.querySelectorAll('.enterprise-history .ant-collapse-item').length === 2`), 'history evidence');
    await dom(`document.querySelectorAll('.enterprise-history .ant-collapse-header')[1].click()`); await settle();
    assert.equal(await dom(`document.querySelector('.enterprise-history').innerText.includes('legacy evidence')`), true); checks++;
    await screenshot(`enterprise-history-${width}`); await closeDrawer();
    await route('security');
    for (const label of ['后台账号', '我的登录会话', '登录安全日志']) { await clickText(label, '.security-tabs [role="tab"]'); await verifyBounds(`security-${label}-${width}`); }
    await modal('修改我的密码', `password-change-${width}`); await modal('新增账号', `account-create-${width}`);
  }
  main.setContentSize(1440, 1000);await verifyScopeEditing();await verifyReleaseTargets();await verifyReleasePublishing();await route('overview');
  await dom(`document.querySelector('.ant-pro-sider-collapsed-button')?.click()`); await settle();
  assert.equal(await dom(`Boolean(document.querySelector('.ant-layout-sider-collapsed'))`), true); checks++;
  await verifyBounds('sidebar-collapsed'); await screenshot('sidebar-collapsed');
  await dom(`document.querySelector('.ant-pro-sider-collapsed-button')?.click()`); await settle();
  assert.equal(await dom(`Boolean(document.querySelector('.ant-layout-sider-collapsed'))`), false); checks++;
  assert.deepEqual(blockedRequests, [], 'UI must not request external hosts'); checks++;
  assert.deepEqual(pageErrors, [], 'no browser console errors'); checks++;
  assert.equal(requests.some(value => value === 'POST /api/admin/login'), true); checks++;
  assert.equal(requests.some(value => value.includes('/api/admin/session/restore')), false); checks++;
  assert.equal(await dom(`Object.keys(localStorage).length + Object.keys(sessionStorage).length`), 0, 'The app never persists account passwords in browser storage'); checks++;
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: checks, sizes: [1440,1180,600], pages, blockedRequests, pageErrors, requests, scopeWrites,
    releaseTargets: ['win32/x64', 'linux/x64', 'linux/arm64'], releaseUploadCalls, frozenTargetVerified: true, arm64DraftRemainsUnpublished: true }, null, 2));
  console.log(`PASS: ${checks} admin UI checks; screenshots: ${directory}`);
}
// Keep ownership of shutdown until cleanup has finished, including failing runs.
app.on('window-all-closed', () => {});
async function finish(code: number) {
  main?.destroy();
  await new Promise<void>(resolve => server.listening ? server.close(() => resolve()) : resolve());
  if (!process.env.DATA_FUSION_UI_TEST_PROFILE && directory && profileDirectory) {
    const absoluteRun = resolve(directory);
    const absoluteProfile = resolve(profileDirectory);
    // Only the exact, named child of this unique workspace test directory may
    // be removed. Reports and screenshots are deliberately kept beside it.
    if (dirname(absoluteRun) !== resolve('.tmp') || !basename(absoluteRun).startsWith('admin-ui-redesign-')
      || absoluteProfile !== join(absoluteRun, 'isolated-profile') || dirname(absoluteProfile) !== absoluteRun) {
      console.error('Refusing unexpected test profile cleanup path');
      code = 1;
    } else {
      try { await rm(absoluteProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch (error) { console.error('Test profile cleanup failed', error); code = 1; }
    }
  }
  app.exit(code);
}
void run().then(() => finish(0)).catch(async error => { console.error(error); if (main && directory) await screenshot('failure').catch(() => {}); return finish(1); });
