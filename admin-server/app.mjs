import { createHash, createPublicKey, randomBytes, randomUUID, scrypt, scryptSync, sign, timingSafeEqual, verify } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { createSecurity, strongPassword, PASSWORD_HINT } from './security.mjs';
import { retireRememberedLogins } from './remember-login.mjs';
import { prepareLicenseScope, storedLicenseScope } from './license-scope.mjs';
import { createEnterpriseStore, aliyunProvider } from './enterprises.mjs';
import { createUpdateReleases } from './update-releases.mjs';
import { createBusinessReleases } from './business-releases.mjs';
import { createOneWindowUploads } from './one-window-uploads.mjs';
import { createReturnBatches } from './return-batches.mjs';
import { releaseTarget, RELEASE_VERSION_PATTERN } from './update-filenames.mjs';
import { establishmentImporterFromEnv } from './establishment-oss-import.mjs';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import governmentMatters from '../src/plugins/government-info/matter-catalog.json' with { type: 'json' };
import hrssMatters from '../src/plugins/guangdong-hrss/matter-catalog.json' with { type: 'json' };
import hazardousMatters from '../src/plugins/shenzhen-hazardous-chemicals/matter-catalog.json' with { type: 'json' };
import equipmentCatalog from '../src/plugins/guangdong-special-equipment/matter-catalog.json' with { type: 'json' };
import foodDrugCatalog from '../src/plugins/guangdong-food-drug/matter-catalog.json' with { type: 'json' };
import populationCatalog from '../src/plugins/guangdong-population/matter-catalog.json' with { type: 'json' };
import shenzhenServicesCatalog from '../src/plugins/shenzhen-integrated-services/matter-catalog.json' with { type: 'json' };
import oneWindowCatalog from '../src/plugins/shenzhen-one-window/matter-catalog.json' with { type: 'json' };
import housingCatalog from '../src/plugins/shenzhen-housing-rental/matter-catalog.json' with { type: 'json' };
import toolCatalog from '../src/core/tools/catalog.json' with { type: 'json' };

export function createAdminServer(options = {}) {
const serverRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(serverRoot);
const publicRoot = join(serverRoot, 'public');
const dataPath = options.dataPath === ':memory:' ? ':memory:' : resolve(options.dataPath ?? process.env.ADMIN_DB_PATH ?? join(serverRoot, 'data', 'admin.sqlite'));
const privateKeyPath = resolve(process.env.ADMIN_LICENSE_PRIVATE_KEY ?? join(projectRoot, 'private', 'license-private.pem'));
if (!options.privateKey && !existsSync(privateKeyPath)) throw new Error('License 私钥不存在，请配置 ADMIN_LICENSE_PRIVATE_KEY');
if (dataPath !== ':memory:') mkdirSync(dirname(dataPath), { recursive: true });
const privateKey = options.privateKey ?? readFileSync(privateKeyPath, 'utf8');
const secureCookie = options.secureCookie ?? process.env.ADMIN_COOKIE_SECURE === 'true';
const database = new DatabaseSync(dataPath, { allowExtension: false });
const publicOrigin = options.publicOrigin ?? process.env.ADMIN_PUBLIC_ORIGIN;
const intranet = (options.deployment ?? process.env.ADMIN_DEPLOYMENT) === 'huizhou-intranet';
const updateStorageMode = options.updateStorageMode ?? process.env.ADMIN_UPDATE_STORAGE_MODE ?? (intranet ? 'local' : 'oss');
const businessStorageMode = options.businessStorageMode ?? process.env.ADMIN_BUSINESS_STORAGE_MODE ?? (intranet ? 'local' : 'oss');
const returnUploadsEnabled = options.returnUploadsEnabled ?? (process.env.ADMIN_RETURN_UPLOADS_ENABLED === 'true' || intranet);
if (intranet) {
  const origin = publicOrigin && new URL(publicOrigin);
  if (!origin || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) throw new Error('惠州内网部署必须配置 HTTPS 入口');
  if ([updateStorageMode, businessStorageMode].some(mode => mode !== 'local')
    || !returnUploadsEnabled || process.env.ESTABLISHMENT_OSS_ENABLED === 'true'
    || (options.updatePublicOrigin ?? process.env.ADMIN_UPDATE_PUBLIC_ORIGIN ?? publicOrigin) !== publicOrigin) throw new Error('惠州部署必须使用内网存储和同源更新，并关闭深圳 OSS 导入');
}
const managementPublic = options.managementPublic ?? process.env.ADMIN_MANAGEMENT_PUBLIC === 'true';
const managementIps = new Set((managementPublic ? [] : options.managementAllowedIps ?? (process.env.ADMIN_MANAGEMENT_ALLOWED_IPS ?? '').split(',').map(value=>value.trim()).filter(Boolean)).map(value=>{
  if (!isIP(value)) throw new Error('管理入口白名单必须是明确的 IP 地址');
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}));
if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin) throw new Error('ADMIN_PUBLIC_ORIGIN 必须是完整源地址，不含路径或结尾斜线');
database.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS admin_users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admin_sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES admin_users(id));
CREATE TABLE IF NOT EXISTS systems(id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS system_matters(id TEXT NOT NULL, system_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, PRIMARY KEY(system_id,id), FOREIGN KEY(system_id) REFERENCES systems(id));
CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY, name TEXT NOT NULL, contact TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS licenses(
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, mode TEXT NOT NULL, expires_at INTEGER NOT NULL, allowed_systems_json TEXT NOT NULL,
 allowed_matters_json TEXT, max_devices INTEGER NOT NULL DEFAULT 1, allow_export INTEGER NOT NULL DEFAULT 0,
 allow_auto_sync INTEGER NOT NULL DEFAULT 0, allow_auto_update INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
 FOREIGN KEY(customer_id) REFERENCES customers(id));
CREATE TABLE IF NOT EXISTS activation_codes(id TEXT PRIMARY KEY, license_id TEXT NOT NULL, code_hash TEXT UNIQUE NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL, FOREIGN KEY(license_id) REFERENCES licenses(id));
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, license_id TEXT NOT NULL, device_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', activated_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, UNIQUE(license_id,device_id), FOREIGN KEY(license_id) REFERENCES licenses(id));
CREATE TABLE IF NOT EXISTS updates(id TEXT PRIMARY KEY, target_type TEXT NOT NULL, system_id TEXT, version TEXT NOT NULL, url TEXT NOT NULL, sha256 TEXT NOT NULL, notes TEXT, published_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS admin_audit_events(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, metadata_json TEXT, created_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES admin_users(id));
CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON admin_audit_events(created_at DESC);
`);

// Additive, repeatable migrations; never replace customer/license data.
function addColumn(table, name, definition) {
  if (!database.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
addColumn('admin_users', 'role', "TEXT NOT NULL DEFAULT 'admin'");
addColumn('admin_users', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
addColumn('admin_users', 'password_policy_version', 'INTEGER NOT NULL DEFAULT 0');
addColumn('licenses', 'allowed_tools_json', "TEXT NOT NULL DEFAULT '[]'");
addColumn('admin_sessions', 'id', 'TEXT');
addColumn('admin_sessions', 'last_seen_at', 'INTEGER');
addColumn('admin_sessions', 'ip_address', "TEXT NOT NULL DEFAULT ''");
addColumn('admin_sessions', 'user_agent', "TEXT NOT NULL DEFAULT ''");
addColumn('admin_sessions', 'remember_device_id', 'TEXT');
database.prepare('DELETE FROM admin_sessions WHERE id IS NULL').run();
database.exec('CREATE INDEX IF NOT EXISTS admin_session_expiry ON admin_sessions(expires_at)');
const security = createSecurity(database, { secureCookie,
  trustedProxies: options.trustedProxies ?? (process.env.ADMIN_TRUSTED_PROXIES ?? '').split(',').map(value => value.trim()).filter(Boolean),
  captchaFactory: options.captchaFactory, now: options.now,
});
retireRememberedLogins(database);
addColumn('activation_codes', 'used_device_id', 'TEXT');
addColumn('activation_codes', 'revoked', 'INTEGER NOT NULL DEFAULT 0');
addColumn('system_matters', 'department_id', 'TEXT');
addColumn('system_matters', 'department_name', 'TEXT');
addColumn('system_matters', 'department_order', 'INTEGER NOT NULL DEFAULT 0');
addColumn('system_matters', 'matter_order', 'INTEGER NOT NULL DEFAULT 0');
function transaction(work) {
  database.exec('BEGIN IMMEDIATE');
  try { const value = work(); database.exec('COMMIT'); return value; }
  catch (error) { database.exec('ROLLBACK'); throw error; }
}

const now = Date.now();
const seedSystem = database.prepare('INSERT OR IGNORE INTO systems(id,name,version,created_at) VALUES(?,?,?,?)');
seedSystem.run('market-access', '广东省市场准入系统', '1.0.0', now);
seedSystem.run('government-info', '政务综合信息平台', '1.0.0', now);
seedSystem.run('transport-practitioner', '广东省道路运输从业人员管理服务平台', '0.1.0', now);
seedSystem.run('oversize-transport', '广东省交通运输厅大件运输许可系统', '0.1.0', now);
seedSystem.run('online-car-permit', '网络预约出租汽车运输证系统', '0.1.0', now);
seedSystem.run('guangdong-hrss', '广东省集中式人力资源和社会保障一体化门户系统', '0.1.0', now);
database.prepare(`INSERT INTO systems(id,name,version,created_at) VALUES(?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name WHERE systems.name=?`)
  .run('shenzhen-hazardous-chemicals', '危化品管理', '0.1.0', now, '深圳市危险化学品安全生产风险监测预警系统');
const seedMatter = database.prepare('INSERT OR IGNORE INTO system_matters(id,system_id,name,created_at) VALUES(?,?,?,?)');
seedMatter.run('business-application-query', 'market-access', '业务办理查询', now);
transaction(() => {
  const upsert = database.prepare(`INSERT INTO system_matters(id,system_id,name,department_id,department_name,department_order,matter_order,created_at)
    VALUES(?,'government-info',?,?,?,?,?,?) ON CONFLICT(system_id,id) DO UPDATE SET name=excluded.name,
    department_id=excluded.department_id,department_name=excluded.department_name,department_order=excluded.department_order,matter_order=excluded.matter_order`);
  for (const matter of governmentMatters) upsert.run(matter.id, matter.name, matter.departmentId, matter.departmentName, matter.departmentOrder, matter.matterOrder, now);
  database.prepare("UPDATE system_matters SET enabled=0 WHERE system_id='government-info' AND id='double-publicity-return'").run();
  // This legacy permission meant all government return matters. Preserve that scope.
  for (const license of database.prepare('SELECT id,allowed_matters_json FROM licenses WHERE allowed_matters_json IS NOT NULL').all()) {
    const allowed = JSON.parse(license.allowed_matters_json);
    if (Array.isArray(allowed?.['government-info']) && allowed['government-info'].includes('double-publicity-return')) {
      allowed['government-info'] = [...new Set([...allowed['government-info'].filter((id) => id !== 'double-publicity-return'), ...governmentMatters.map((m) => m.id)])];
      database.prepare('UPDATE licenses SET allowed_matters_json=? WHERE id=?').run(JSON.stringify(allowed), license.id);
    }
  }
});
seedMatter.run('road-practitioner-return', 'transport-practitioner', '道路运输从业人员', now);
seedMatter.run('taxi-driver-return', 'transport-practitioner', '出租车驾驶员', now);
seedMatter.run('oversize-transport-return', 'oversize-transport', '大件运输许可', now);
seedMatter.run('online-car-permit-return', 'online-car-permit', '网约车车证', now);
transaction(() => {
  const seedOrderedMatter = database.prepare('INSERT OR IGNORE INTO system_matters(id,system_id,name,matter_order,created_at) VALUES(?,?,?,?,?)');
  for (const catalog of [equipmentCatalog, foodDrugCatalog, populationCatalog, shenzhenServicesCatalog, oneWindowCatalog, housingCatalog]) {
    seedSystem.run(catalog.id, catalog.name, catalog.version, now);
    for (const [order, matter] of catalog.matters.entries()) seedOrderedMatter.run(matter.id, catalog.id, matter.name, order, now);
  }
});
// Human-resources lists are an independent component. Adding its catalog never
// expands an existing customer's signed scope or enables enterprise enrichment.
transaction(() => {
  const existingSubdistrict = database.prepare("SELECT 1 FROM system_matters WHERE system_id='guangdong-hrss' AND department_id='subdistrict-office' LIMIT 1").get();
  if (!existingSubdistrict) {
    const existingIds = hrssMatters.filter(matter => matter.departmentId !== 'subdistrict-office').map(matter => matter.id);
    const pin = database.prepare('UPDATE licenses SET allowed_matters_json=? WHERE id=?');
    // Older HRSS grants without an explicit matter list covered the original catalog.
    for (const license of database.prepare('SELECT id,allowed_systems_json,allowed_matters_json FROM licenses').all()) {
      let scope;
      try { scope = storedLicenseScope(license); }
      catch { continue; } // Malformed legacy grants are rejected when used.
      if (scope.allowedSystems.includes('guangdong-hrss') && !Object.hasOwn(scope.allowedMatters ?? {}, 'guangdong-hrss')) {
        pin.run(JSON.stringify({ ...scope.allowedMatters, 'guangdong-hrss': existingIds }), license.id);
      }
    }
  }
  const upsert = database.prepare(`INSERT INTO system_matters(id,system_id,name,department_id,department_name,department_order,matter_order,created_at)
    VALUES(?,'guangdong-hrss',?,?,?,?,?,?) ON CONFLICT(system_id,id) DO UPDATE SET name=excluded.name,
    department_id=excluded.department_id,department_name=excluded.department_name,department_order=excluded.department_order,matter_order=excluded.matter_order`);
  for (const matter of hrssMatters) upsert.run(matter.id, matter.name, matter.departmentId, matter.departmentName, matter.departmentOrder, matter.matterOrder, now);
});
// Catalog registration is additive. Existing signed scope and manual disabling
// remain authoritative until an administrator explicitly assigns this system.
transaction(() => {
  const upsert = database.prepare(`INSERT INTO system_matters(id,system_id,name,department_id,department_name,department_order,matter_order,created_at)
    VALUES(?,'shenzhen-hazardous-chemicals',?,?,?,?,?,?) ON CONFLICT(system_id,id) DO UPDATE SET name=excluded.name,
    department_id=excluded.department_id,department_name=excluded.department_name,department_order=excluded.department_order,matter_order=excluded.matter_order`);
  for (const matter of hazardousMatters) upsert.run(matter.id, matter.name, matter.departmentId, matter.departmentName, matter.departmentOrder, matter.matterOrder, now);
});

function passwordHash(password) {
  const salt = randomBytes(16);
  return `s2:${salt.toString('base64url')}:${scryptSync(password, salt, 32, {N:32768,maxmem:64*1024*1024}).toString('base64url')}`;
}
const scryptAsync = promisify(scrypt);
let passwordChecks = 0;
async function passwordValid(password, stored) {
  if (passwordChecks >= 4) throw Object.assign(new Error('登录校验繁忙，请稍后重试'), { status: 429, retryAfterSeconds: 3, code: 'AUTH_BUSY' });
  const parts=stored.split(':');
  const modern=parts.length===3 && parts[0]==='s2';
  const [saltText,hashText]=modern?parts.slice(1):parts;
  if (!saltText || !hashText) return false;
  passwordChecks++;
  try {
    const actual = await scryptAsync(password, Buffer.from(saltText, 'base64url'), 32, {N:modern?32768:16384,maxmem:64*1024*1024});
    const expected = Buffer.from(hashText, 'base64url');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } finally { passwordChecks--; }
}
const dummyPasswordHash = passwordHash(randomBytes(32).toString('base64url'));
if (!database.prepare('SELECT id FROM admin_users LIMIT 1').get()) {
  const initialPassword = options.initialPassword ?? process.env.ADMIN_INITIAL_PASSWORD;
  if (!strongPassword(initialPassword)) throw new Error(`首次启动请设置 ADMIN_INITIAL_PASSWORD：${PASSWORD_HINT}`);
  database.prepare('INSERT INTO admin_users(id,username,password_hash,created_at,password_policy_version) VALUES(?,?,?,?,1)')
    .run(randomUUID(), process.env.ADMIN_INITIAL_USERNAME ?? 'admin', passwordHash(initialPassword), now);
  console.log(`已创建初始管理员：${process.env.ADMIN_INITIAL_USERNAME ?? 'admin'}`);
}

const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (response, status, body) => {
  const content = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': content.length, 'cache-control': 'no-store' });
  response.end(content);
};
const readJson = async (request) => {
  const chunks = []; let size = 0;
  // Installer uploads get a longer deadline, but ordinary JSON requests retain the original 30s cap.
  const timeout = setTimeout(() => request.destroy(Object.assign(new Error('请求读取超时'), { status: 408 })), 30_000);
  timeout.unref?.();
  try { for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw Object.assign(new Error('请求内容过大'), { status: 413 }); chunks.push(chunk); } }
  finally { clearTimeout(timeout); }
  try {
    const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw Object.assign(new Error('请求必须为 JSON 对象'), { status: 400 }); }
};
const cookie = (request, name) => (request.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
const currentUser = (request) => {
  const token = cookie(request, 'df_admin');
  if (!token) return null;
  const user = database.prepare(`SELECT u.id,u.username,u.role,u.password_policy_version<1 AS passwordChangeRequired FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND s.last_seen_at>? AND u.enabled=1`).get(hash(token), security.now(), security.now() - 30 * 60_000);
  if (user) database.prepare('UPDATE admin_sessions SET last_seen_at=? WHERE token_hash=?').run(security.now(), hash(token));
  return user;
};
const authCookie = (name, token, seconds, path = '/') => `${name}=${token}; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=${seconds}${secureCookie ? '; Secure' : ''}`;
const clearAuthCookies = response => response.setHeader('set-cookie', [authCookie('df_admin', '', 0), authCookie('df_remember', '', 0, '/api/admin')]);
function createSession(request, user) {
  const token = randomBytes(32).toString('base64url'), timestamp = security.now();
  database.prepare('DELETE FROM admin_sessions WHERE expires_at<=? OR last_seen_at<=?').run(timestamp, timestamp - 30 * 60_000);
  database.prepare('INSERT INTO admin_sessions(token_hash,user_id,expires_at,created_at,id,last_seen_at,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?)')
    .run(hash(token), user.id, timestamp + 8 * 60 * 60 * 1000, timestamp, randomUUID(), timestamp, security.ip(request), String(request.headers['user-agent'] ?? '').slice(0,300));
  database.prepare('DELETE FROM admin_sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM admin_sessions WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 5)').run(user.id, user.id);
  return authCookie('df_admin', token, 28800);
}
async function confirmSensitive(request, user, password) {
  security.checkLogin(request, user.username);
  const stored = database.prepare('SELECT password_hash FROM admin_users WHERE id=? AND enabled=1').get(user.id);
  if (typeof password !== 'string' || password.length > 256 || !await passwordValid(password, stored?.password_hash ?? dummyPasswordHash)) {
    const state = security.failure(request, user.username, 'sensitive.password_failed');
    throw Object.assign(new Error('当前密码不正确，请重新确认'), { status: state.retryAfterSeconds ? 429 : 400, code: 'PASSWORD_CONFIRM_FAILED', ...state });
  }
  const activeUser = currentUser(request);
  const latest = database.prepare('SELECT password_hash FROM admin_users WHERE id=?').get(user.id);
  if (!activeUser || activeUser.role !== user.role || latest?.password_hash !== stored?.password_hash) throw Object.assign(new Error('账号状态已变更，请重新登录'), { status:403 });
  security.clearFailures(user.username);
}
function verifyClientProof(body) {
  try {
    const proof = body.proof;
    if (proof?.algorithm !== 'RSA-SHA256' || typeof proof.payload !== 'string' || proof.payload.length > 32768
      || typeof proof.signature !== 'string' || proof.signature.length > 2048
      || !verify('RSA-SHA256', Buffer.from(proof.payload, 'base64url'), createPublicKey(privateKey), Buffer.from(proof.signature, 'base64url'))) throw new Error();
    const grant = JSON.parse(Buffer.from(proof.payload, 'base64url').toString('utf8'));
    if (grant.activationMode !== 'online' || grant.licenseId !== body.licenseId || grant.deviceId !== body.deviceId
      || !/^[a-f0-9]{64}$/.test(body.deviceId) || (grant.notBefore && grant.notBefore > Date.now())) throw new Error();
    // Expired signed proofs may refresh after an administrator renews the live license.
    return grant;
  } catch { throw Object.assign(new Error('需要当前设备的签名授权凭据，请升级客户端后重试'), { status: 403, code: 'DEVICE_PROOF_REQUIRED' }); }
}
const requireAdmin = (request, response) => {
  const user = currentUser(request);
  if (!user) { json(response, 401, { error: '请先登录管理后台' }); return null; }
  if (user.passwordChangeRequired && request.method !== 'GET') { json(response,403,{error:'请先在账号与安全中升级密码',code:'PASSWORD_CHANGE_REQUIRED'}); return null; }
  if (user.role === 'viewer' && request.method !== 'GET') { json(response, 403, { error: '只读账号不能执行管理操作' }); return null; }
  return user;
};
const signedEnvelope = (grant) => {
  const payloadBytes = Buffer.from(JSON.stringify(grant));
  return { payload: payloadBytes.toString('base64url'), signature: sign('RSA-SHA256', payloadBytes, privateKey).toString('base64url'), algorithm: 'RSA-SHA256' };
};
const offlineKey = (grant) => `DFL1.${Buffer.from(JSON.stringify(signedEnvelope(grant))).toString('base64url')}`;
const licenseGrant = (license, customer, deviceId) => {
  const scope = storedLicenseScope(license);
  return {
    licenseId: license.id, customerId: customer.id, customerName: customer.name, activationMode: license.mode,
    issuedAt: Date.now(), expiresAt: license.expires_at, allowedSystems: scope.allowedSystems,
    allowedMatters: scope.allowedMatters ?? undefined, allowedTools: scope.allowedTools,
    maxDevices: license.max_devices, deviceId, allowExport: Boolean(license.allow_export),
    allowAutoSync: Boolean(license.allow_auto_sync), allowAutoUpdate: license.mode === 'online' && Boolean(license.allow_auto_update),
  };
};
const all = (sql, ...params) => database.prepare(sql).all(...params);
const audit = (user, action, targetType, targetId, metadata) => database.prepare('INSERT INTO admin_audit_events(id,user_id,username,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
  .run(randomUUID(), user.id, user.username, action, targetType ?? null, targetId ?? null, metadata ? JSON.stringify(metadata) : null, Date.now());

const enterprises = createEnterpriseStore(database, {
  provider: options.enterpriseProvider ?? aliyunProvider(process.env.ALIYUN_ENTERPRISE_APPCODE ?? ''),
  configured: Boolean(options.enterpriseProvider || process.env.ALIYUN_ENTERPRISE_APPCODE), audit, transaction,
});
const updateReleases = createUpdateReleases(database, {
  storageMode: updateStorageMode,
  deploymentProfile: intranet ? 'huizhou' : 'shenzhen',
  directory: options.releaseDirectory ?? process.env.ADMIN_UPDATE_DIRECTORY ?? (dataPath === ':memory:' ? undefined : join(dirname(dataPath), 'releases')),
  publicOrigin: options.updatePublicOrigin ?? process.env.ADMIN_UPDATE_PUBLIC_ORIGIN ?? publicOrigin,
  transaction, audit, authorize: currentUser,
  ...(options.updateMaxBytes ? { maxBytes: options.updateMaxBytes } : {}),
  ...(options.uploadTimeoutMs ? { uploadTimeoutMs: options.uploadTimeoutMs } : {}),
});
const businessReleases = createBusinessReleases(database, {
  directory: options.businessReleaseDirectory ?? process.env.ADMIN_BUSINESS_UPDATE_DIRECTORY ?? (dataPath === ':memory:' ? undefined : join(dirname(dataPath), 'business-releases')),
  publicOrigin: options.updatePublicOrigin ?? process.env.ADMIN_UPDATE_PUBLIC_ORIGIN ?? publicOrigin,
  privateKey, transaction, audit, authorize: currentUser,
  storageMode: businessStorageMode,
  requiredBackendOrigin: intranet ? publicOrigin : undefined,
  localFeedBase: options.businessLocalFeedBase ?? process.env.ADMIN_BUSINESS_LOCAL_FEED_BASE,
  ...(options.businessOssStorage ? { ossStorage: options.businessOssStorage } : {}),
  ...(options.uploadTimeoutMs ? { uploadTimeoutMs: options.uploadTimeoutMs } : {}),
});
const oneWindowUploads = intranet ? undefined : createOneWindowUploads({ database,
  configDirectory: dataPath === ':memory:' ? undefined : dirname(dataPath),
  storage: options.oneWindowOssStorage,
  authorize(body, { systemId, matterId }) {
    const reject = () => { throw Object.assign(new Error('一窗回流上传需要有效的设备及事项授权'), { status: 403 }); };
    let grant;
    try {
      const proof = body.proof;
      if (proof?.algorithm !== 'RSA-SHA256' || typeof proof.payload !== 'string' || proof.payload.length > 32768
        || typeof proof.signature !== 'string' || proof.signature.length > 2048
        || !verify('RSA-SHA256', Buffer.from(proof.payload, 'base64url'), createPublicKey(privateKey), Buffer.from(proof.signature, 'base64url'))) reject();
      grant = JSON.parse(Buffer.from(proof.payload, 'base64url').toString('utf8'));
      if (!Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now() || grant.deviceId !== body.deviceId
        || !/^[a-f0-9]{64}$/.test(body.deviceId) || (grant.notBefore && grant.notBefore > Date.now())
        || !grant.allowedSystems?.includes(systemId)
        || (grant.allowedMatters?.[systemId] && !grant.allowedMatters[systemId].includes(matterId))) reject();
    } catch { reject(); }
    const license = database.prepare(`SELECT l.* FROM licenses l JOIN customers c ON c.id=l.customer_id
      JOIN devices d ON d.license_id=l.id WHERE l.id=? AND d.device_id=? AND d.status='active'
      AND c.enabled=1 AND l.status='active' AND l.expires_at>?`).get(String(grant.licenseId), String(body.deviceId), Date.now());
    const scope = license && storedLicenseScope(license);
    if (!license?.allow_export || !scope?.allowedSystems.includes(systemId)
      || (scope.allowedMatters?.[systemId] && !scope.allowedMatters[systemId].includes(matterId))
      || !database.prepare(`SELECT 1 FROM systems s JOIN system_matters m ON s.id=m.system_id
        WHERE s.id=? AND m.id=? AND s.enabled=1 AND m.enabled=1`).get(systemId, matterId)) reject();
    return { customerId: license.customer_id, licenseId: license.id, deviceId: body.deviceId };
  },
});
function authorizeReturnUpload(body, { systemId, matterId }) {
  const reject = () => { throw Object.assign(new Error('回流上传需要有效的设备及事项授权'), { status: 403 }); };
  let grant;
  try {
    const proof = body.proof;
    if (proof?.algorithm !== 'RSA-SHA256' || typeof proof.payload !== 'string' || proof.payload.length > 32768
      || typeof proof.signature !== 'string' || proof.signature.length > 2048
      || !verify('RSA-SHA256', Buffer.from(proof.payload, 'base64url'), createPublicKey(privateKey), Buffer.from(proof.signature, 'base64url'))) reject();
    grant = JSON.parse(Buffer.from(proof.payload, 'base64url').toString('utf8'));
    // Match the desktop's signed legacy-scope normalization without widening live permissions.
    if (grant.allowedMatters?.['government-info']?.includes('double-publicity-return')) grant.allowedMatters['government-info'] =
      [...new Set([...grant.allowedMatters['government-info'].filter(id => id !== 'double-publicity-return'), ...governmentMatters.map(matter => matter.id)])];
    if (grant.allowedSystems?.includes('guangdong-hrss') && !grant.allowedMatters?.['guangdong-hrss']) grant.allowedMatters = {
      ...grant.allowedMatters, 'guangdong-hrss': hrssMatters.filter(matter => matter.departmentId !== 'subdistrict-office').map(matter => matter.id) };
    if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now() || grant.deviceId !== body.deviceId
      || !/^[a-f0-9]{64}$/.test(body.deviceId) || grant.notBefore && grant.notBefore > Date.now()
      || !grant.allowedSystems?.includes(systemId)
      || grant.allowedMatters?.[systemId] && !grant.allowedMatters[systemId].includes(matterId)) reject();
  } catch { reject(); }
  const license = database.prepare(`SELECT l.* FROM licenses l JOIN customers c ON c.id=l.customer_id
    JOIN devices d ON d.license_id=l.id WHERE l.id=? AND d.device_id=? AND d.status='active'
    AND c.enabled=1 AND l.status='active' AND l.expires_at>?`).get(String(grant.licenseId), String(body.deviceId), Date.now());
  const scope = license && storedLicenseScope(license);
  if (!license || !scope?.allowedSystems.includes(systemId)
    || scope.allowedMatters?.[systemId] && !scope.allowedMatters[systemId].includes(matterId)
    || !database.prepare(`SELECT 1 FROM systems s JOIN system_matters m ON s.id=m.system_id
      WHERE s.id=? AND m.id=? AND s.enabled=1 AND m.enabled=1`).get(systemId, matterId)) reject();
  return { customerId: license.customer_id, licenseId: license.id, deviceId: body.deviceId };
}
const returnBatches = createReturnBatches(database, { transaction, authorize: authorizeReturnUpload, revalidate: authorizeReturnUpload });
async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') return json(response,200,{status:'ok'});
  if (request.method === 'GET' && url.pathname === '/api/returns/capabilities') return json(response, 200, { schema: 1, enabled: returnUploadsEnabled });
  if (url.pathname.startsWith('/api/returns/')) {
    if (!returnUploadsEnabled) return json(response, 503, { error: '回流数据接收尚未启用' });
    if (request.method !== 'POST') return json(response, 404, { error: '接口不存在' });
    if (String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return json(response, 415, { error: '仅接受 application/json' });
    security.limit(`return-upload:${security.ip(request)}`, 600, 60_000);
    return json(response, 200, await returnBatches.handle(url.pathname, await readJson(request)));
  }
  if (url.pathname === '/api/admin/returns' || url.pathname.startsWith('/api/admin/returns/')) {
    const user = requireAdmin(request, response); if (!user) return;
    if (request.method !== 'GET') return json(response, 404, { error: '接口不存在' });
    if (url.pathname === '/api/admin/returns') return json(response, 200, returnBatches.list(url.searchParams));
    const match = /^\/api\/admin\/returns\/([a-f0-9-]{36})(\/export)?$/.exec(url.pathname);
    if (!match) return json(response, 404, { error: '批次不存在' });
    if (!match[2]) return json(response, 200, returnBatches.detail(match[1], url.searchParams));
    const exported = returnBatches.export(match[1]);
    audit(user, 'return_batch.exported', 'return_batch', match[1], { rowCount: exported.batch.rowCount });
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="return-${match[1]}.json"` });
    response.write('{"batch":' + JSON.stringify(exported.batch) + ',"rows":[');
    let first = true;
    for (const row of exported.rows) {
      if (response.destroyed) break;
      // Honor slow readers without accumulating the complete export in memory.
      const writable = response.write((first ? '' : ',') + JSON.stringify(row)); first = false;
      if (!writable && !response.destroyed) await new Promise(resolve => {
        const done = () => { response.off('drain', done); response.off('close', done); resolve(); };
        response.once('drain', done); response.once('close', done);
      });
    }
    if (!response.destroyed) response.end(']}'); return;
  }
  if (url.pathname.startsWith('/api/releases/') && await updateReleases.serve(request, response, url)) return;
  if (url.pathname.startsWith('/api/business-releases/') && await businessReleases.serve(request, response, url)) return;
  if (request.method === 'GET' && url.pathname === '/api/admin/captcha') return json(response, 200, security.captcha(request, response));
  if (request.method === 'POST' && url.pathname.startsWith('/api/one-window/uploads/')) {
    if (!oneWindowUploads) return json(response, 404, { error: '此部署通过回流数据接口上传记录' });
    const body = await readJson(request);
    security.limit(`one-window-upload:${security.ip(request)}`, 120, 60_000);
    return json(response, 200, await oneWindowUploads.handle(url.pathname, body));
  }
  if (url.pathname === '/api/admin/enterprises' || url.pathname.startsWith('/api/admin/enterprises/')) {
    const user = requireAdmin(request, response); if (!user) return;
    return enterprises.route(request, response, url, { user, readJson, json });
  }
  if (request.method === 'POST' && url.pathname === '/api/enterprises/resolve') {
    const body = await readJson(request);
    let grant;
    try {
      const proof = body.proof;
      if (proof?.algorithm !== 'RSA-SHA256' || typeof proof.payload !== 'string' || proof.payload.length > 32768
        || typeof proof.signature !== 'string' || proof.signature.length > 2048
        || !verify('RSA-SHA256', Buffer.from(proof.payload, 'base64url'), createPublicKey(privateKey), Buffer.from(proof.signature, 'base64url'))) throw new Error();
      grant = JSON.parse(Buffer.from(proof.payload, 'base64url').toString('utf8'));
      if (grant.expiresAt <= Date.now() || grant.deviceId !== body.deviceId || !/^[a-f0-9]{64}$/.test(body.deviceId)
        || (grant.notBefore && grant.notBefore > Date.now())) throw new Error();
    } catch { return json(response, 403, { error: '企业补全需要有效签名授权' }); }
    const licensed = database.prepare(`SELECT l.* FROM licenses l JOIN customers c ON c.id=l.customer_id JOIN devices d ON d.license_id=l.id
      WHERE l.id=? AND d.device_id=? AND d.status='active' AND c.enabled=1 AND l.status='active' AND l.expires_at>?`).get(String(grant.licenseId), String(body.deviceId), Date.now());
    const systemId = body.systemId, matterId = body.matterId;
    const scope = licensed && storedLicenseScope(licensed);
    const selected = scope?.allowedMatters?.[systemId];
    const allowedSystem = scope && ['government-info','oversize-transport','online-car-permit','shenzhen-hazardous-chemicals'].includes(systemId)
      && scope.allowedSystems.includes(systemId) && typeof matterId === 'string'
      && (selected === undefined
        ? Boolean(database.prepare('SELECT 1 FROM system_matters WHERE system_id=? AND id=?').get(systemId, matterId))
        : selected.includes(matterId));
    const allowedTool = scope && systemId === 'health-publicity' && matterId === 'word-to-publicity'
      && scope.allowedTools.includes('health-publicity');
    if (!allowedSystem && !allowedTool) return json(response, 403, { error: '没有该事项的企业补全权限' });
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) return json(response, 400, { error: '单次最多提交 100 家企业' });
    security.limit(`enterprise-items:${grant.licenseId}:${body.deviceId}`,5000,60_000,body.items.length);
    if (body.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) return json(response, 400, { error: '企业数据格式无效' });
    // The licensed desktop never receives the provider secret. Missing enterprise fields are resolved
    // server-side and awaited before business records are persisted by the desktop.
    return json(response, 200, { results: await enterprises.resolve(body.items, systemId,
      { username: `client:${grant.licenseId}:${body.deviceId}` }) });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/login') {
    const body = await readJson(request);
    if (typeof body.password !== 'string' || body.password.length > 256 || typeof body.username !== 'string' || body.username.length > 80) return json(response, 400, { error: '账号或密码格式无效' });
    body.username = body.username.trim();
    security.checkLogin(request, body.username);
    security.verifyCaptcha(request, body);
    const user = database.prepare('SELECT * FROM admin_users WHERE username=? AND enabled=1').get(body.username);
    const valid = await passwordValid(body.password, user?.password_hash ?? dummyPasswordHash);
    const latest = user && database.prepare('SELECT password_hash,enabled,role FROM admin_users WHERE id=?').get(user.id);
    security.checkLogin(request,body.username);
    if (!user || !valid || !latest?.enabled || latest.password_hash!==user.password_hash || latest.role!==user.role) {
      const state = security.failure(request, body.username);
      if (state.retryAfterSeconds) response.setHeader('retry-after', state.retryAfterSeconds);
      return json(response, state.retryAfterSeconds ? 429 : 401, { error: state.retryAfterSeconds ? '连续输错 5 次，已锁定 15 分钟' : `账号或密码错误，还可尝试 ${state.attemptsRemaining} 次`, code: state.retryAfterSeconds ? 'LOGIN_LOCKED' : 'LOGIN_FAILED', ...state });
    }
    security.clearFailures(user.username);
    const cookies = transaction(() => {
      const sessionCookie = createSession(request, user);
      audit(user, 'admin.login', 'admin_user', user.id);
      security.event('login.success', request, user.username);
      return [sessionCookie, authCookie('df_remember', '', 0, '/api/admin'), authCookie('df_challenge', '', 0, '/api/admin')];
    });
    response.setHeader('set-cookie', cookies);
    return json(response, 200, { username: user.username });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/session/restore') {
    // Cached older clients must not restore authentication from a legacy token.
    // Do not clear a valid ordinary session that another tab may be using.
    response.setHeader('set-cookie', authCookie('df_remember', '', 0, '/api/admin'));
    return json(response, 401, { error: '请使用账号密码和验证码登录', code: 'PASSWORD_LOGIN_REQUIRED' });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/logout') {
    const user = currentUser(request); if (user) audit(user, 'admin.logout', 'admin_user', user.id);
    const token = cookie(request, 'df_admin'); if (token) database.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(hash(token));
    clearAuthCookies(response); return json(response, 200, { ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/password') {
    const user = currentUser(request); if (!user) return json(response, 401, { error: '请先登录' });
    const body = await readJson(request);
    if (!strongPassword(body.newPassword)) return json(response, 400, { error: PASSWORD_HINT });
    if (body.oldPassword === body.newPassword) return json(response, 400, { error: '新密码不能与当前密码相同' });
    await confirmSensitive(request, user, body.oldPassword);
    transaction(() => {
      database.prepare('UPDATE admin_users SET password_hash=?,password_policy_version=1 WHERE id=?').run(passwordHash(body.newPassword), user.id);
      database.prepare('DELETE FROM admin_sessions WHERE user_id=?').run(user.id);
      audit(user, 'admin.password_changed', 'admin_user', user.id);
    });
    clearAuthCookies(response); return json(response, 200, { ok: true });
  }
  if (url.pathname === '/api/admin/security-events' && request.method === 'GET') {
    const user = requireAdmin(request,response); if (!user) return;
    if (user.role !== 'admin') return json(response,403,{ error:'仅超级管理员可查看安全日志' });
    const page = Math.max(1,Math.min(100000,Math.floor(Number(url.searchParams.get('page')) || 1)));
    return json(response,200,{ total: database.prepare('SELECT count(*) n FROM admin_security_events').get().n,
      rows: all('SELECT * FROM admin_security_events ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?', (page-1)*20) });
  }
  if (url.pathname === '/api/admin/sessions' && request.method === 'GET') {
    const user = requireAdmin(request,response); if (!user) return;
    return json(response,200,all('SELECT id,ip_address,user_agent,created_at,last_seen_at,expires_at,token_hash=? AS current FROM admin_sessions WHERE user_id=? AND expires_at>? AND last_seen_at>? ORDER BY created_at DESC',
      hash(cookie(request,'df_admin')),user.id,security.now(),security.now()-30*60_000));
  }
  if (url.pathname === '/api/admin/sessions/revoke-others' && request.method === 'POST') {
    const user = currentUser(request); if (!user) return json(response,401,{ error:'请先登录管理后台' });
    transaction(() => {
      database.prepare('DELETE FROM admin_sessions WHERE user_id=? AND token_hash<>?').run(user.id,hash(cookie(request,'df_admin')));
      audit(user,'admin.sessions_revoked','admin_user',user.id);
    });
    return json(response,200,{ok:true});
  }
  const unlockMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/unlock$/);
  if (unlockMatch && request.method === 'POST') {
    const user = requireAdmin(request,response); if (!user) return;
    if (user.role !== 'admin') return json(response,403,{ error:'仅超级管理员可解锁账号' });
    const target = database.prepare('SELECT username FROM admin_users WHERE id=?').get(unlockMatch[1]);
    if (!target) return json(response,404,{error:'账号不存在'});
    security.clearFailures(target.username); audit(user,'admin.unlocked','admin_user',unlockMatch[1]);
    return json(response,200,{ok:true});
  }
  if (url.pathname === '/api/admin/users' || /^\/api\/admin\/users\/[^/]+$/.test(url.pathname)) {
    const user = requireAdmin(request, response); if (!user) return;
    if (user.role !== 'admin') return json(response, 403, { error: '仅超级管理员可管理账号' });
    if (request.method === 'GET' && url.pathname === '/api/admin/users') return json(response, 200, all('SELECT id,username,role,enabled,created_at FROM admin_users ORDER BY created_at').map(row => ({...row,lockedForSeconds:security.lock(row.username)})));
    const body = await readJson(request);
    if (request.method === 'POST' && url.pathname === '/api/admin/users') {
      if (typeof body.username !== 'string' || !/^[A-Za-z0-9_.-]{3,80}$/.test(body.username) || !['admin','operator','viewer'].includes(body.role)) return json(response, 400, { error: '账号或角色无效' });
      if (!strongPassword(body.password)) return json(response,400,{error:PASSWORD_HINT});
      if (database.prepare('SELECT id FROM admin_users WHERE username=?').get(body.username)) return json(response, 409, { error: '账号已存在' });
      const id = randomUUID();
      database.prepare('INSERT INTO admin_users(id,username,password_hash,role,created_at,password_policy_version) VALUES(?,?,?,?,?,1)').run(id, body.username, passwordHash(body.password), body.role, Date.now());
      audit(user, 'admin.created', 'admin_user', id, { role: body.role }); return json(response, 201, { id });
    }
    if (request.method === 'PATCH') {
      const id = url.pathname.split('/').at(-1);
      const target = database.prepare('SELECT * FROM admin_users WHERE id=?').get(id);
      if (!target) return json(response, 404, { error: '账号不存在' });
      const role = body.role ?? target.role, enabled = body.enabled === undefined ? target.enabled : Number(body.enabled);
      if (!['admin','operator','viewer'].includes(role) || ![0,1].includes(enabled)) return json(response, 400, { error: '角色或状态无效' });
      if (target.role === 'admin' && target.enabled && (role !== 'admin' || !enabled) && database.prepare("SELECT count(*) n FROM admin_users WHERE role='admin' AND enabled=1").get().n <= 1) return json(response, 409, { error: '必须保留至少一个启用的超级管理员' });
      transaction(() => {
        database.prepare('UPDATE admin_users SET role=?,enabled=? WHERE id=?').run(role, enabled, id);
        database.prepare('DELETE FROM admin_sessions WHERE user_id=?').run(id);
        audit(user, 'admin.updated', 'admin_user', id, { role, enabled: Boolean(enabled) });
      }); return json(response, 200, { ok: true });
    }
    return json(response, 405, { error: '不支持的操作' });
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/bootstrap') {
    const user = requireAdmin(request, response); if (!user) return;
    return json(response, 200, {
      user,
      deployment: intranet ? 'huizhou-intranet' : 'standard',
      tools: toolCatalog,
      systems: all('SELECT * FROM systems ORDER BY name'), matters: all('SELECT * FROM system_matters ORDER BY system_id,department_order,matter_order,name'), customers: all('SELECT * FROM customers ORDER BY created_at DESC'),
      licenses: all(`SELECT l.*,c.name customer_name FROM licenses l JOIN customers c ON c.id=l.customer_id ORDER BY l.created_at DESC`),
      devices: all(`SELECT d.*,c.name customer_name FROM devices d JOIN licenses l ON l.id=d.license_id JOIN customers c ON c.id=l.customer_id ORDER BY d.activated_at DESC`),
      updates: all('SELECT * FROM updates ORDER BY published_at DESC').map(updateReleases.describe), audits: all('SELECT * FROM admin_audit_events ORDER BY created_at DESC LIMIT 200'),
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/audits') {
    const user = requireAdmin(request, response); if (!user) return;
    const page = Math.max(1, Math.min(100000, Number(url.searchParams.get('page')) || 1));
    const size = 20;
    const username = `%${(url.searchParams.get('username') ?? '').slice(0,80)}%`;
    const action = `%${(url.searchParams.get('action') ?? '').slice(0,80)}%`;
    return json(response, 200, { total: database.prepare('SELECT count(*) n FROM admin_audit_events WHERE username LIKE ? AND action LIKE ?').get(username, action).n,
      rows: all('SELECT * FROM admin_audit_events WHERE username LIKE ? AND action LIKE ? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?', username, action, size, (Math.floor(page)-1)*size) });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/customers') {
    const user = requireAdmin(request, response); if (!user) return; const body = await readJson(request);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) return json(response, 400, { error: '客户名称无效' });
    const id = randomUUID(); database.prepare('INSERT INTO customers(id,name,contact,created_at) VALUES(?,?,?,?)').run(id, body.name.trim(), String(body.contact ?? '').slice(0, 200), Date.now());
    audit(user, 'customer.created', 'customer', id, { name: body.name.trim() });
    return json(response, 201, { id });
  }
  const customerMatch = url.pathname.match(/^\/api\/admin\/customers\/([^/]+)$/);
  if (request.method === 'PATCH' && customerMatch) {
    const user = requireAdmin(request, response); if (!user) return; const body = await readJson(request);
    const existing = database.prepare('SELECT * FROM customers WHERE id=?').get(customerMatch[1]);
    if (!existing) return json(response, 404, { error: '客户不存在' });
    const name = typeof body.name === 'string' ? body.name.trim() : existing.name;
    if (!name || name.length > 200) return json(response, 400, { error: '客户名称无效' });
    const contact = typeof body.contact === 'string' ? body.contact.slice(0, 200) : existing.contact;
    const enabled = typeof body.enabled === 'boolean' ? Number(body.enabled) : existing.enabled;
    database.prepare('UPDATE customers SET name=?,contact=?,enabled=? WHERE id=?').run(name, contact, enabled, existing.id);
    audit(user, 'customer.updated', 'customer', existing.id, { name, enabled: Boolean(enabled) });
    return json(response, 200, { ok: true });
  }
  const systemMatch = url.pathname.match(/^\/api\/admin\/systems\/([^/]+)$/);
  if (request.method === 'PATCH' && systemMatch) {
    const user = requireAdmin(request, response); if (!user) return; const body = await readJson(request);
    if (user.role !== 'admin') return json(response,403,{error:'仅超级管理员可维护业务系统'});
    const existing = database.prepare('SELECT * FROM systems WHERE id=?').get(systemMatch[1]);
    if (!existing) return json(response, 404, { error: '业务系统不存在' });
    const name = typeof body.name === 'string' ? body.name.trim() : existing.name;
    const version = typeof body.version === 'string' ? body.version.trim() : existing.version;
    if (!name || name.length > 200 || !/^\d+\.\d+\.\d+$/.test(version)) return json(response, 400, { error: '系统名称或版本号无效' });
    const enabled = typeof body.enabled === 'boolean' ? Number(body.enabled) : existing.enabled;
    database.prepare('UPDATE systems SET name=?,version=?,enabled=? WHERE id=?').run(name, version, enabled, existing.id);
    audit(user, 'system.updated', 'system', existing.id, { name, version, enabled: Boolean(enabled) });
    return json(response, 200, { ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/licenses') {
    const user = requireAdmin(request, response); if (!user) return; const body = await readJson(request);
    const customer = database.prepare('SELECT * FROM customers WHERE id=? AND enabled=1').get(String(body.customerId ?? ''));
    const requestedSystems = body.allowedSystems === undefined ? [] : body.allowedSystems;
    if (!Array.isArray(requestedSystems) || requestedSystems.some(id => typeof id !== 'string')) return json(response, 400, { error: '授权系统无效' });
    const systems = [...new Set(requestedSystems)];
    const tools = body.allowedTools === undefined ? [] : body.allowedTools;
    const knownTools = new Set(toolCatalog.map(tool => tool.id));
    if (!Array.isArray(tools) || tools.some(id => typeof id !== 'string' || !knownTools.has(id))) return json(response, 400, { error: '授权工具无效' });
    const known = new Set(all('SELECT id FROM systems WHERE enabled=1').map((row) => row.id));
    if (!customer || (!systems.length && !tools.length) || systems.some((id) => !known.has(id))) return json(response, 400, { error: '客户无效，或尚未选择任何业务系统/工具' });
    const requestedMatters = body.allowedMatters === undefined ? {} : body.allowedMatters;
    if (!requestedMatters || typeof requestedMatters !== 'object' || Array.isArray(requestedMatters)) return json(response, 400, { error: '授权事项格式无效' });
    const allowedMatters = Object.create(null);
    for (const systemId of systems) {
      const selected = Object.hasOwn(requestedMatters, systemId) ? requestedMatters[systemId] : [];
      const knownMatters = new Set(all('SELECT id FROM system_matters WHERE system_id=? AND enabled=1', systemId).map((row) => row.id));
      if (!Array.isArray(selected) || (knownMatters.size && !selected.length) || selected.some(id => !knownMatters.has(id))) return json(response, 400, { error: `系统 ${systemId} 的业务事项授权无效` });
      allowedMatters[systemId] = [...new Set(selected)];
    }
    if (body.mode !== 'online' && body.mode !== 'offline') return json(response, 400, { error: '激活模式无效' });
    if (['allowExport','allowAutoSync','allowAutoUpdate'].some((key) => body[key] !== undefined && typeof body[key] !== 'boolean')) return json(response, 400, { error: '功能权限必须为布尔值' });
    const expiresAt = Number(body.expiresAt); if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return json(response, 400, { error: '授权有效期无效' });
    const maxDevices = Number(body.maxDevices ?? 1); const id = randomUUID();
    if (!Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 100) return json(response, 400, { error: '最大设备数必须为 1–100 的整数' });
    if (body.mode === 'offline' && (maxDevices !== 1 || typeof body.deviceId !== 'string' || !/^[a-f0-9]{64}$/.test(body.deviceId))) return json(response, 400, { error: '离线授权为单设备授权，必须填写完整设备码' });
    // Store only validated systems/matters; do not sign unvalidated extra properties.
    const result = transaction(() => {
    database.prepare(`INSERT INTO licenses(id,customer_id,mode,expires_at,allowed_systems_json,allowed_matters_json,allowed_tools_json,max_devices,allow_export,allow_auto_sync,allow_auto_update,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, customer.id, body.mode, expiresAt, JSON.stringify(systems), JSON.stringify(allowedMatters), JSON.stringify([...new Set(tools)]), maxDevices, body.allowExport ? 1 : 0, body.allowAutoSync ? 1 : 0, body.mode === 'online' && body.allowAutoUpdate ? 1 : 0, Date.now());
    const license = database.prepare('SELECT * FROM licenses WHERE id=?').get(id);
    if (body.mode === 'offline') {
      database.prepare('INSERT INTO devices(id,license_id,device_id,activated_at,last_seen_at) VALUES(?,?,?,?,?)').run(randomUUID(), id, body.deviceId, Date.now(), 0);
      audit(user, 'license.created', 'license', id, { customerId: customer.id, mode: body.mode, systems, tools, allowedMatters });
      return { id, offlineKey: offlineKey(licenseGrant(license, customer, body.deviceId)) };
    }
    const code = `DFA-${randomBytes(12).toString('base64url').toUpperCase()}`; database.prepare('INSERT INTO activation_codes(id,license_id,code_hash,created_at) VALUES(?,?,?,?)').run(randomUUID(), id, hash(code), Date.now());
    audit(user, 'license.created', 'license', id, { customerId: customer.id, mode: body.mode, systems, tools, allowedMatters });
    return { id, activationCode: code };
    });
    return json(response, 201, result);
  }
  const scopeAction = url.pathname.match(/^\/api\/admin\/licenses\/([^/]+)\/scope$/);
  if (scopeAction && request.method === 'POST') {
    if (!requireAdmin(request, response)) return;
    const body = await readJson(request);
    const user = requireAdmin(request, response); if (!user) return;
    const result = transaction(() => {
      const license = database.prepare('SELECT * FROM licenses WHERE id=?').get(scopeAction[1]);
      if (!license || license.status !== 'active') throw Object.assign(new Error('授权不存在或已停用'), { status: 404 });
      if (!database.prepare('SELECT id FROM customers WHERE id=? AND enabled=1').get(license.customer_id)) throw Object.assign(new Error('客户已停用'), { status: 409 });
      if (license.expires_at <= Date.now()) throw Object.assign(new Error('请先续期授权'), { status: 409 });
      const { before, after, changed } = prepareLicenseScope(database, toolCatalog, license, body);
      const requiresOfflineReissue = license.mode === 'offline' && changed;
      if (changed) {
        database.prepare('UPDATE licenses SET allowed_systems_json=?,allowed_tools_json=?,allowed_matters_json=? WHERE id=?')
          .run(JSON.stringify(after.allowedSystems), JSON.stringify(after.allowedTools), JSON.stringify(after.allowedMatters), license.id);
        audit(user, 'license.scope_updated', 'license', license.id, { before, after, mode: license.mode, affectsAllBoundDevices: true, requiresOfflineReissue });
      }
      return { ok: true, changed, requiresOfflineReissue };
    });
    return json(response, 200, result);
  }
  const licenseAction = url.pathname.match(/^\/api\/admin\/licenses\/([^/]+)\/(codes|offline-key|renew)$/);
  if (licenseAction && request.method === 'POST') {
    const user = requireAdmin(request, response); if (!user) return;
    const license = database.prepare('SELECT * FROM licenses WHERE id=?').get(licenseAction[1]);
    if (!license || license.status !== 'active') return json(response, 404, { error: '授权不存在或已停用' });
    const customer = database.prepare('SELECT * FROM customers WHERE id=? AND enabled=1').get(license.customer_id);
    if (!customer) return json(response, 409, { error: '客户已停用' });
    const action = licenseAction[2];
    if (action === 'renew') {
      const body = await readJson(request); const expiresAt = Number(body.expiresAt);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.max(Date.now(), license.expires_at)) return json(response, 400, { error: '续期日期必须晚于当前有效期和今天' });
      database.prepare('UPDATE licenses SET expires_at=? WHERE id=?').run(expiresAt, license.id);
      audit(user, 'license.renewed', 'license', license.id, { expiresAt }); return json(response, 200, { ok: true });
    }
    if (license.expires_at <= Date.now()) return json(response, 409, { error: '请先续期授权' });
    if (action === 'offline-key') {
      if (license.mode !== 'offline') return json(response, 400, { error: '不是离线授权' });
      const device = database.prepare("SELECT device_id FROM devices WHERE license_id=? AND status='active'").get(license.id);
      if (!device) return json(response, 409, { error: '该旧版离线授权没有设备留档，不能安全补发；请重新签发' });
      audit(user, 'license.offline_reissued', 'license', license.id);
      return json(response, 200, { offlineKey: offlineKey(licenseGrant(license, customer, device.device_id)) });
    }
    if (license.mode !== 'online') return json(response, 400, { error: '离线授权不使用激活码' });
    const active = database.prepare("SELECT count(*) n FROM devices WHERE license_id=? AND status='active'").get(license.id).n;
    if (active >= license.max_devices) return json(response, 409, { error: '设备已满，请先停用旧设备以换机' });
    const code = `DFA-${randomBytes(12).toString('base64url').toUpperCase()}`;
    transaction(() => {
      database.prepare('UPDATE activation_codes SET revoked=1 WHERE license_id=? AND used_at IS NULL').run(license.id);
      database.prepare('INSERT INTO activation_codes(id,license_id,code_hash,created_at) VALUES(?,?,?,?)').run(randomUUID(), license.id, hash(code), Date.now());
      audit(user, 'license.code_issued', 'license', license.id);
    });
    return json(response, 201, { activationCode: code });
  }
  const deviceMatch = url.pathname.match(/^\/api\/admin\/devices\/([^/]+)\/revoke$/);
  if (request.method === 'POST' && deviceMatch) {
    const user = requireAdmin(request, response); if (!user) return;
    if (!database.prepare("UPDATE devices SET status='revoked' WHERE id=? AND status='active'").run(deviceMatch[1]).changes) return json(response, 404, { error: '设备不存在或已停用' });
    audit(user, 'device.revoked', 'device', deviceMatch[1]); return json(response, 200, { ok: true });
  }
  const licenseMatch = url.pathname.match(/^\/api\/admin\/licenses\/([^/]+)\/revoke$/);
  if (request.method === 'POST' && licenseMatch) {
    const user = requireAdmin(request, response); if (!user) return;
    const result = database.prepare("UPDATE licenses SET status='revoked' WHERE id=? AND status='active'").run(licenseMatch[1]);
    if (!result.changes) return json(response, 404, { error: '授权不存在或已停用' });
    database.prepare("UPDATE devices SET status='revoked' WHERE license_id=? AND status='active'").run(licenseMatch[1]);
    audit(user, 'license.revoked', 'license', licenseMatch[1]);
    return json(response, 200, { ok: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/business-releases') {
    const user = requireAdmin(request, response); if (!user) return;
    return json(response, 200, businessReleases.list());
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/business-releases/upload') {
    const user = requireAdmin(request, response); if (!user) return;
    if (user.role !== 'admin') return json(response, 403, { error: '仅超级管理员可上传业务更新包' });
    security.limit(`business-update-upload:${user.id}`, 12, 60 * 60_000);
    return json(response, 201, await businessReleases.upload(request, response, url, user));
  }
  const businessUpdateMatch = /^\/api\/admin\/business-releases\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (request.method === 'PATCH' && businessUpdateMatch) {
    request.setTimeout(180_000);
    const user = requireAdmin(request, response); if (!user) return;
    if (user.role !== 'admin') return json(response, 403, { error: '仅超级管理员可变更业务更新发布状态' });
    const body = await readJson(request);
    if (typeof body.enabled !== 'boolean') return json(response, 400, { error: '请指定发布或下线操作' });
    await confirmSensitive(request, user, body.confirmPassword);
    return json(response, 200, await businessReleases.publish(businessUpdateMatch[1], body.enabled, request, user));
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/updates/upload') {
    const user = requireAdmin(request, response); if (!user) return;
    if (user.role !== 'admin') return json(response,403,{error:'仅超级管理员可上传安装包'});
    security.limit(`update-upload:${user.id}`, 12, 60 * 60_000);
    return json(response, 201, await updateReleases.upload(request, response, url, user));
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/updates') {
    const user = requireAdmin(request, response); if (!user) return; const body = await readJson(request);
    if (user.role !== 'admin') return json(response,403,{error:'仅超级管理员可发布版本'});
    await confirmSensitive(request,user,body.confirmPassword);
    let downloadUrl; try { downloadUrl = new URL(body.url); } catch { /* rejected below */ }
    const target = releaseTarget(body.platform, body.arch, body.variant);
    if (target?.platform === 'linux') return json(response, 400, { error: '麒麟版本必须上传完整 DEB 安装包，不能使用外链发布' });
    if (!target || body.installer !== undefined && body.installer !== target.installer || !RELEASE_VERSION_PATTERN.test(String(body.version)) || downloadUrl?.protocol !== 'https:' || downloadUrl.username || downloadUrl.password || downloadUrl.hash || !/^[a-f0-9]{64}$/.test(String(body.sha256))) return json(response, 400, { error: '平台、架构、版本、HTTPS 下载地址或 SHA256 无效' });
    if (database.prepare("SELECT id FROM updates WHERE target_type='app' AND platform=? AND arch=? AND variant=? AND version=?").get(target.platform, target.arch, target.variant ?? 'standard', body.version)) return json(response,409,{error:'该平台及架构的版本已存在，请使用新的版本号'});
    const id = randomUUID(); database.prepare('INSERT INTO updates(id,target_type,system_id,version,url,sha256,notes,published_at,platform,arch,variant) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, 'app', null, body.version, body.url, body.sha256, String(body.notes ?? '').slice(0, 1000), Date.now(), target.platform, target.arch, target.variant ?? 'standard');
    audit(user, 'update.created', 'update', id, { version: body.version, ...target });
    return json(response, 201, { ok: true });
  }
  const updateMatch = url.pathname.match(/^\/api\/admin\/updates\/([^/]+)$/);
  if (request.method === 'PATCH' && updateMatch) {
    const user = requireAdmin(request, response); if (!user) return; const body = await readJson(request);
    if (user.role !== 'admin') return json(response,403,{error:'仅超级管理员可变更版本发布状态'});
    await confirmSensitive(request,user,body.confirmPassword);
    const existing = database.prepare('SELECT * FROM updates WHERE id=?').get(updateMatch[1]);
    if (!existing) return json(response, 404, { error: '更新记录不存在' });
    const enabled = typeof body.enabled === 'boolean' ? Number(body.enabled) : existing.enabled;
    if (!await updateReleases.publish(existing.id, Boolean(enabled), request, user)) database.prepare('UPDATE updates SET enabled=? WHERE id=?').run(enabled, existing.id);
    audit(user, 'update.updated', 'update', existing.id, { enabled: Boolean(enabled), version: existing.version,
      platform: existing.platform, arch: existing.arch, variant: existing.variant });
    return json(response, 200, { ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/api/activate') {
    const body = await readJson(request); const deviceId = String(body.deviceId ?? '');
    if (!/^[a-f0-9]{64}$/.test(deviceId)) return json(response, 400, { error: '设备标识无效' });
    const row = database.prepare(`SELECT a.id code_id,a.used_at,a.used_device_id,a.revoked code_revoked,l.*,c.enabled customer_enabled,c.id customer_id_value,c.name customer_name FROM activation_codes a JOIN licenses l ON l.id=a.license_id JOIN customers c ON c.id=l.customer_id WHERE a.code_hash=?`).get(hash(String(body.key ?? '').trim()));
    if (!row || row.code_revoked || !row.customer_enabled || (row.used_at && row.used_device_id !== deviceId) || row.mode !== 'online' || row.status !== 'active' || row.expires_at <= Date.now()) return json(response, 403, { error: '激活码无效、已使用或授权已过期' });
    if (row.used_at) {
      if (!database.prepare("SELECT id FROM devices WHERE license_id=? AND device_id=? AND status='active'").get(row.id, deviceId)) return json(response, 403, { error: '设备已停用，请申请新激活码' });
      return json(response, 200, signedEnvelope(licenseGrant(row, { id: row.customer_id_value, name: row.customer_name }, deviceId)));
    }
    const existing = database.prepare("SELECT * FROM devices WHERE license_id=? AND status='active'").all(row.id);
    if (!existing.some((item) => item.device_id === deviceId) && existing.length >= row.max_devices) return json(response, 403, { error: '授权设备数量已达到上限' });
    const device = existing.find((item) => item.device_id === deviceId); const deviceRecordId = device?.id ?? randomUUID();
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare("INSERT INTO devices(id,license_id,device_id,activated_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(license_id,device_id) DO UPDATE SET status='active',last_seen_at=excluded.last_seen_at").run(deviceRecordId, row.id, deviceId, Date.now(), Date.now());
      database.prepare('UPDATE activation_codes SET used_at=?,used_device_id=? WHERE id=?').run(Date.now(), deviceId, row.code_id); database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
    const customer = { id: row.customer_id_value, name: row.customer_name };
    return json(response, 200, signedEnvelope(licenseGrant(row, customer, deviceId)));
  }
  if (request.method === 'POST' && url.pathname === '/api/license/status') {
    const body = await readJson(request); verifyClientProof(body);
    const row = database.prepare(`SELECT l.*,c.id customer_id_value,c.name customer_name,d.id device_record_id FROM licenses l JOIN customers c ON c.id=l.customer_id JOIN devices d ON d.license_id=l.id WHERE l.id=? AND d.device_id=? AND d.status='active'`).get(String(body.licenseId ?? ''), String(body.deviceId ?? ''));
    if (!row || row.mode !== 'online' || row.status !== 'active' || row.expires_at <= Date.now() || !database.prepare('SELECT id FROM customers WHERE id=? AND enabled=1').get(row.customer_id)) return json(response, 403, { error: '授权已失效或客户已停用' });
    database.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(Date.now(), row.device_record_id);
    return json(response, 200, signedEnvelope(licenseGrant(row, { id: row.customer_id_value, name: row.customer_name }, body.deviceId)));
  }
  if (request.method === 'GET' && url.pathname === '/api/updates/manifest') return json(response,403,{error:'更新查询需要设备签名授权，请升级客户端',code:'DEVICE_PROOF_REQUIRED'});
  if (request.method === 'POST' && url.pathname === '/api/updates/manifest') {
    const body = await readJson(request); verifyClientProof(body);
    const { licenseId,deviceId } = body;
    const target = releaseTarget(body.platform, body.arch, body.variant);
    if (!target) return json(response, 400, { error: '更新平台或芯片架构无效' });
    const valid = database.prepare(`SELECT l.id FROM licenses l JOIN devices d ON d.license_id=l.id JOIN customers c ON c.id=l.customer_id WHERE l.id=? AND d.device_id=? AND c.enabled=1 AND l.mode='online' AND l.allow_auto_update=1 AND l.status='active' AND d.status='active' AND l.expires_at>?`).get(licenseId, deviceId, Date.now());
    if (!valid) return json(response, 403, { error: '当前设备没有自动更新权限' });
    const appUpdate = database.prepare("SELECT id,version,url,sha256,notes,platform,arch,variant FROM updates WHERE target_type='app' AND platform=? AND arch=? AND variant=? AND enabled=1 ORDER BY published_at DESC").all(target.platform, target.arch, target.variant ?? 'standard')
      .map(updateReleases.manifest).filter(Boolean)
      .filter((item) => /^\d+\.\d+\.\d+$/.test(item.version)).sort((a,b) => {
        const left = a.version.split('.').map(Number), right = b.version.split('.').map(Number);
        return right[0]-left[0] || right[1]-left[1] || right[2]-left[2];
      })[0];
    return json(response, 200, signedEnvelope({ app: appUpdate }));
  }
  return json(response, 404, { error: '接口不存在' });
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  const requestId=randomUUID(); response.setHeader('x-request-id',requestId);
  response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('x-frame-options', 'DENY');
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  response.setHeader('referrer-policy','same-origin'); response.setHeader('permissions-policy','camera=(), microphone=(), geolocation=()');
  if (secureCookie) response.setHeader('strict-transport-security','max-age=31536000');
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (await businessReleases.serve(request, response, url)) return;
    request.setTimeout(['/api/admin/updates/upload', '/api/admin/business-releases/upload'].includes(url.pathname) ? 60_000 : 30_000);
    if (managementIps.size && (url.pathname.startsWith('/api/admin/') || !url.pathname.startsWith('/api/')) && !managementIps.has(security.ip(request))) return json(response,403,{error:'当前来源地址不在管理入口白名单内'});
    if (url.pathname.startsWith('/api/admin/') && request.headers['sec-fetch-site'] === 'cross-site') return json(response,403,{error:'请求来源不允许'});
    if (url.pathname.startsWith('/api/admin/') && !['GET','HEAD'].includes(request.method)) {
      if (request.headers.origin && request.headers.origin !== (publicOrigin ?? `${secureCookie ? 'https:' : 'http:'}//${request.headers.host}`)) return json(response, 403, { error: '请求来源不允许' });
      const installerUpload = request.method === 'POST' && ['/api/admin/updates/upload', '/api/admin/business-releases/upload'].includes(url.pathname);
      const expectedType = installerUpload ? 'application/octet-stream' : 'application/json';
      if (String(request.headers['content-type'] ?? '').toLowerCase().split(';')[0].trim() !== expectedType) return json(response, 415, { error: `仅接受 ${expectedType}` });
    }
    if (url.pathname === '/api/admin/login') security.limit(`login-request:${security.ip(request)}`,60,60_000);
    if (url.pathname === '/api/admin/session/restore') security.limit(`remember-request:${security.ip(request)}`,30,60_000);
    if (url.pathname === '/api/activate') security.limit(`activation:${security.ip(request)}`,30,60_000);
    if (['/api/license/status','/api/updates/manifest','/api/enterprises/resolve'].includes(url.pathname)) security.limit(`client-api:${security.ip(request)}`,600,60_000);
    if (url.pathname.startsWith('/api/')) return await api(request, response, url);
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); const path = resolve(publicRoot, requested);
    if (!path.startsWith(`${resolve(publicRoot)}${process.platform === 'win32' ? '\\' : '/'}`) || !existsSync(path) || !statSync(path).isFile()) { response.writeHead(404); return response.end('Not found'); }
    response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    createReadStream(path).on('error', () => response.destroy()).pipe(response);
  } catch (error) { const status = [400,403,404,408,409,413,415,429,503].includes(error?.status) ? error.status : 500;
    if (error?.retryAfterSeconds) response.setHeader('retry-after',error.retryAfterSeconds);
    if (status === 500) console.error('后台请求失败', { requestId, errorType: error?.name, method:request.method, path:(request.url??'').split('?')[0] });
    if (!response.headersSent) json(response, status, { error: status === 500 ? `服务器错误，请联系管理员并提供编号 ${requestId}` : error.message,
      ...(error.code && status !== 500 ? {code:error.code} : {}), ...(error.retryAfterSeconds ? {retryAfterSeconds:error.retryAfterSeconds} : {}),
      ...(error.attemptsRemaining !== undefined ? {attemptsRemaining:error.attemptsRemaining} : {}) }); else response.end(); }
});
server.requestTimeout = 10 * 60_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 5_000;
const establishmentImporter = establishmentImporterFromEnv(database);
server.on('listening', () => establishmentImporter?.start());
server.on('close', () => {
  enterprises.close(); const updateClose = updateReleases.close(), businessClose = businessReleases.close();
  if (establishmentImporter || updateClose || businessClose) Promise.all([establishmentImporter?.close(), updateClose, businessClose]).finally(() => database.close());
  else database.close();
});
return server;
}
