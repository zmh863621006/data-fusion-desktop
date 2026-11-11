import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { createCaptcha } from './captcha.mjs';

export const PASSWORD_HINT = '密码须为 12–128 位，并包含大写字母、小写字母、数字、符号中的至少三类';
export function strongPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128
    && [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(value)).length >= 3;
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export const cookieValue = (request, name) => (request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
const normalizeIp = value => value?.startsWith('::ffff:') ? value.slice(7) : value;
export function createSecurity(db, { secureCookie = false, trustedProxies = [], captchaFactory = createCaptcha, now = Date.now } = {}) {
  const proxies = new Set(trustedProxies.map(value => {
    if (!isIP(value)) throw new Error('受信代理必须填写明确的 IP 地址');
    return normalizeIp(value);
  }));
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_rate_limits(bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_captchas(id TEXT PRIMARY KEY,answer_hash TEXT NOT NULL,client_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_security_events(id TEXT PRIMARY KEY,event TEXT NOT NULL,username TEXT NOT NULL,ip_address TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS admin_security_time ON admin_security_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_rate_expiry ON admin_rate_limits(expires_at);
    CREATE INDEX IF NOT EXISTS admin_captcha_expiry ON admin_captchas(expires_at);
  `);
  let nextCleanup = 0;
  function cleanup() {
    if (now() < nextCleanup) return;
    nextCleanup = now() + 60_000;
    db.prepare('DELETE FROM admin_rate_limits WHERE expires_at<=?').run(now());
    db.prepare('DELETE FROM admin_captchas WHERE expires_at<=?').run(now());
    db.prepare('DELETE FROM admin_security_events WHERE created_at<?').run(now() - 90 * 86400000);
  }
  function ip(request) {
    const peer = normalizeIp(request.socket.remoteAddress) ?? 'unknown';
    if (!proxies.has(peer)) return peer;
    const forwarded = request.headers['x-real-ip'];
    if (typeof forwarded !== 'string' || !isIP(forwarded)) throw Object.assign(new Error('代理来源配置错误'), { status: 400 });
    return normalizeIp(forwarded);
  }
  function event(type, request, username = '') {
    db.prepare('INSERT INTO admin_security_events VALUES(?,?,?,?,?)').run(randomUUID(), type, String(username).slice(0,80), ip(request), now());
  }
  function entry(bucket) { return db.prepare('SELECT * FROM admin_rate_limits WHERE bucket=? AND expires_at>?').get(bucket, now()); }
  function bump(bucket, windowMs, amount = 1) {
    cleanup();
    const existing = entry(bucket);
    if (!existing) db.prepare('INSERT OR REPLACE INTO admin_rate_limits VALUES(?,?,?)').run(bucket, amount, now() + windowMs);
    else db.prepare('UPDATE admin_rate_limits SET count=count+? WHERE bucket=?').run(amount,bucket);
    return entry(bucket);
  }
  function limit(bucket, maximum, windowMs, amount = 1) {
    const value = bump(bucket, windowMs, amount);
    if (value.count > maximum) throw Object.assign(new Error('请求过于频繁，请稍后重试'), { status: 429, code: 'RATE_LIMITED', retryAfterSeconds: Math.max(1, Math.ceil((value.expires_at - now()) / 1000)) });
  }
  const accountBucket = username => `login-account:${digest(username)}`;
  function lock(username) {
    const value = entry(accountBucket(username));
    return value?.count >= 5 ? Math.max(1, Math.ceil((value.expires_at - now()) / 1000)) : 0;
  }
  function checkLogin(request, username) {
    const retry = Math.max(lock(username), (() => { const source = entry(`login-ip:${ip(request)}`); return source?.count >= 30 ? Math.max(1, Math.ceil((source.expires_at - now()) / 1000)) : 0; })());
    if (retry) throw Object.assign(new Error('登录暂时受限，请在倒计时结束后重试'), { status: 429, code: 'LOGIN_LOCKED', retryAfterSeconds: retry });
  }
  function failure(request, username, type = 'login.failed') {
    const account = bump(accountBucket(username), 15 * 60_000);
    // Lock for a full 15 minutes from the fifth failure.
    if (account.count === 5) db.prepare('UPDATE admin_rate_limits SET expires_at=? WHERE bucket=?').run(now() + 15 * 60_000, accountBucket(username));
    bump(`login-ip:${ip(request)}`, 15 * 60_000);
    event(type, request, username);
    if (lock(username)) event('login.locked', request, username);
    return { attemptsRemaining: Math.max(0, 5 - account.count), retryAfterSeconds: lock(username) };
  }
  function clearFailures(username) { db.prepare('DELETE FROM admin_rate_limits WHERE bucket=?').run(accountBucket(username)); }
  function captcha(request, response) {
    limit(`captcha:${ip(request)}`, 60, 5 * 60_000);
    const client = cookieValue(request, 'df_challenge') || randomBytes(24).toString('base64url');
    const clientHash = digest(`${client}:${ip(request)}`), id = randomBytes(24).toString('base64url');
    const value = captchaFactory(), expiresAt = now() + 120_000;
    db.prepare('DELETE FROM admin_captchas WHERE client_hash=?').run(clientHash);
    db.prepare('INSERT INTO admin_captchas VALUES(?,?,?,?)').run(id, digest(`${id}:${value.answer.toUpperCase()}`), clientHash, expiresAt);
    response.setHeader('set-cookie', `df_challenge=${client}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=300${secureCookie ? '; Secure' : ''}`);
    return { id, image: value.image, expiresAt };
  }
  function verifyCaptcha(request, body) {
    const id = typeof body.captchaId === 'string' && body.captchaId.length <= 64 ? body.captchaId : '';
    const answer = typeof body.captcha === 'string' && body.captcha.length <= 10 ? body.captcha.trim().toUpperCase() : '';
    const stored = db.prepare('SELECT * FROM admin_captchas WHERE id=?').get(id);
    if (stored) db.prepare('DELETE FROM admin_captchas WHERE id=?').run(id);
    const valid = stored && stored.expires_at > now() && stored.client_hash === digest(`${cookieValue(request,'df_challenge') ?? ''}:${ip(request)}`)
      && timingSafeEqual(Buffer.from(stored.answer_hash), Buffer.from(digest(`${id}:${answer}`)));
    if (!valid) {
      event('captcha.failed', request, body.username);
      throw Object.assign(new Error('验证码错误或已失效，请重新输入'), { status: 400, code: 'CAPTCHA_INVALID' });
    }
  }
  return { ip, event, limit, checkLogin, failure, clearFailures, lock, captcha, verifyCaptcha, now };
}
