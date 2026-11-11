import { randomUUID } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY';
export function validCreditCode(value) {
  if (typeof value !== 'string' || !/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(value)) return false;
  const weights = [1,3,9,27,19,26,16,17,20,29,25,13,8,24,10,30,28];
  return alphabet[(31 - weights.reduce((sum, weight, i) => sum + alphabet.indexOf(value[i]) * weight, 0) % 31) % 31] === value[17];
}
const clean = value => typeof value === 'string' ? value.trim() : '';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

// This adapter is the only paid-network boundary. Never expose credentials or upstream bodies.
export function aliyunProvider(appCode, fetcher = fetch) {
  return async keyword => {
    let response;
    try {
      response = await fetcher(`https://slycompany.market.alicloudapi.com/business2/get?${new URLSearchParams({ keyword })}`, {
        headers: { Authorization: `APPCODE ${appCode}` }, signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
    } catch { fail('企业查询网络异常或超时，请稍后重试', 502); }
    if (!response.ok) fail(`企业服务请求失败（HTTP ${response.status}），请检查额度或服务配置`, 502);
    let result;
    try { result = await response.json(); } catch { fail('企业服务返回格式异常', 502); }
    const data = result?.data?.data;
    // Explicit business failures are not treated as "not found" (and do not trigger a second paid call).
    const businessCode = result?.data?.code ?? result?.code;
    if (businessCode !== undefined && !['0','200'].includes(String(businessCode)) && !data?.companyName) {
      fail('企业服务返回业务错误，请核对服务额度及供应商状态', 502);
    }
    if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) return null;
    if (typeof data !== 'object' || !clean(data.companyName)) fail('企业服务返回内容不完整', 502);
    return { name: clean(data.companyName), creditCode: clean(data.creditNo).toUpperCase(), legalPerson: clean(data.legalPerson) };
  };
}

export function createEnterpriseStore(db, { provider, configured = false, audit, transaction, now = Date.now }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS enterprises(id TEXT PRIMARY KEY,name TEXT NOT NULL,credit_code TEXT NOT NULL UNIQUE,
      legal_person TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS enterprise_name ON enterprises(name);
    CREATE TABLE IF NOT EXISTS enterprise_requests(id TEXT PRIMARY KEY,name TEXT NOT NULL,credit_code TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',enterprise_id TEXT REFERENCES enterprises(id),source_system TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 0,queried_at INTEGER,created_at INTEGER NOT NULL,
      UNIQUE(name,credit_code));
    CREATE TABLE IF NOT EXISTS enterprise_history(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,actor TEXT NOT NULL,
      source TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS enterprise_request_time ON enterprise_requests(created_at);
    CREATE TABLE IF NOT EXISTS enterprise_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO enterprise_settings(id,enabled) VALUES(1,0);
    CREATE TABLE IF NOT EXISTS enterprise_provider_queries(keyword TEXT PRIMARY KEY,status TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '',queried_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS enterprise_provider_query_time ON enterprise_provider_queries(queried_at);
    CREATE TABLE IF NOT EXISTS enterprise_resolution_queries(request_id TEXT NOT NULL REFERENCES enterprise_requests(id) ON DELETE CASCADE,
      strategy TEXT NOT NULL,status TEXT NOT NULL,queried_at INTEGER NOT NULL,PRIMARY KEY(request_id,strategy));
  `);
  let job = null;
  let closed = false;
  const resolving = new Map(), requestTails = new Map(), querying = new Map(), waiting = [];
  let activeQueries = 0;
  const providerLimit = 240, providerConcurrency = 4;
  const get = id => db.prepare('SELECT * FROM enterprise_requests WHERE id=?').get(id);
  const entity = id => db.prepare('SELECT * FROM enterprises WHERE id=?').get(id);
  const settings = () => ({ configured, enabled: Boolean(db.prepare('SELECT enabled FROM enterprise_settings WHERE id=1').get().enabled), batchLimit: 20 });
  function history(id, actor, source, before, after) {
    db.prepare('INSERT INTO enterprise_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, actor, source, JSON.stringify(before), JSON.stringify(after), Date.now());
  }
  function mark(id, status, reason, source, actor) {
    const before = get(id);
    db.prepare('UPDATE enterprise_requests SET status=?,reason=? WHERE id=?').run(status, reason, id);
    history(id, actor, source, before, get(id));
  }
  function link(id, value, source, actor) {
    const request = get(id);
    if (request.credit_code && validCreditCode(value.credit_code) && request.credit_code !== value.credit_code) {
      mark(id, 'review', '企业名称匹配，但信用代码冲突，需人工核对', source, actor); return;
    }
    const status = value.legal_person && validCreditCode(value.credit_code) ? 'success' : 'partial';
    if (request.enterprise_id === value.id && request.status === status && (!request.reason || source.startsWith('cache'))) return;
    db.prepare("UPDATE enterprise_requests SET enterprise_id=?,status=?,reason='' WHERE id=?").run(value.id, status, id);
    history(id, actor, source, request, { ...get(id), enterprise: value });
  }
  function cached(request, actor = 'client', strategy = 'name-first') {
    // A verified code from the oversize source is stronger evidence than a possibly stale name/alias.
    // Do not inspect names at all here: identical names can legitimately refer to different companies.
    if (strategy === 'code-first' && validCreditCode(request.credit_code)) {
      const byCode = db.prepare('SELECT * FROM enterprises WHERE credit_code=?').get(request.credit_code);
      if (byCode) { link(request.id, byCode, 'cache-code', actor); return true; }
      return false;
    }
    const matches = db.prepare(`SELECT DISTINCT e.* FROM enterprises e WHERE e.name=? OR e.id IN
      (SELECT enterprise_id FROM enterprise_requests WHERE name=? AND status IN ('success','partial'))`).all(request.name, request.name);
    if (matches.length > 1) { mark(request.id, 'review', '名称对应多个企业，请人工核对', 'cache', actor); return true; }
    if (matches.length === 1) { link(request.id, matches[0], 'cache', actor); return true; }
    if (request.credit_code) {
      const byCode = db.prepare('SELECT * FROM enterprises WHERE credit_code=?').get(request.credit_code);
      if (byCode) { link(request.id, byCode, 'cache-code', actor); return true; }
    }
    return false;
  }
  function register(input, source = 'manual', deferCache = false) {
    const name = clean(input.name), explicitCode = clean(input.creditCode).toUpperCase(), applicantCode = clean(input.applicantCode).toUpperCase();
    const rawCode = validCreditCode(explicitCode) ? explicitCode : applicantCode || explicitCode;
    if (name.length > 200 || rawCode.length > 100 || (!name && !validCreditCode(rawCode))) fail('请输入企业名称或有效统一信用代码');
    // Never persist or send natural-person identity numbers supplied as an applicant credential.
    const code = validCreditCode(rawCode) ? rawCode : '';
    let row = db.prepare('SELECT * FROM enterprise_requests WHERE name=? AND credit_code=?').get(name, code);
    if (!row) {
      const id = randomUUID();
      db.prepare('INSERT INTO enterprise_requests(id,name,credit_code,source_system,created_at) VALUES(?,?,?,?,?)').run(id, name, code, source, Date.now());
      row = get(id);
    }
    if (!deferCache && ['pending','not_found','error','partial'].includes(row.status)) cached(row);
    if (validCreditCode(explicitCode) && validCreditCode(applicantCode) && explicitCode !== applicantCode && row.status !== 'review') {
      mark(row.id, 'review', '原有信用代码与申请证件号不一致，需人工核对', 'input', 'client');
    }
    return result(row.id);
  }
  function result(id) {
    const request = get(id);
    const value = request.enterprise_id && ['success','partial'].includes(request.status) ? entity(request.enterprise_id) : null;
    const configurationReason = !configured ? '后台尚未配置阿里云企业查询，已保留现有字段' : !settings().enabled ? '后台尚未开启企业查询，已保留现有字段' : '';
    return { requestId: id, status: request.status, reason: request.reason || (['pending','partial'].includes(request.status) ? configurationReason : ''), enterprise: value ? {
      id: value.id, name: value.name, creditCode: value.credit_code, legalPerson: value.legal_person,
      source: value.source, updatedAt: value.updated_at,
    } : null };
  }
  function save(id, value, source, actor, manual = false) {
    const request = get(id);
    if (!request) fail('企业查询记录不存在', 404);
    const name = clean(value.name), code = clean(value.creditCode).toUpperCase(), legalPerson = clean(value.legalPerson);
    if (!name || name.length > 200 || !validCreditCode(code) || legalPerson.length > 100) fail('标准名称、统一信用代码或法人姓名格式无效');
    if (request.credit_code && request.credit_code !== code) {
      if (manual) fail('与原始有效信用代码冲突，不能直接关联；请核实原始业务记录');
      mark(id, 'review', '查询返回代码与原始有效信用代码冲突', source, actor); return;
    }
    const linked = request.enterprise_id ? entity(request.enterprise_id) : null;
    const existing = db.prepare('SELECT * FROM enterprises WHERE credit_code=?').get(code)
      ?? (linked && !validCreditCode(linked.credit_code) ? linked : null);
    if (!manual && existing && (existing.name !== name || (existing.legal_person && legalPerson && existing.legal_person !== legalPerson))) {
      mark(id, 'review', '查询结果与已维护企业资料冲突，请人工核对', source, actor); return;
    }
    transaction(() => {
      const entityId = existing?.id ?? randomUUID();
      if (existing && !validCreditCode(existing.credit_code)) {
        db.prepare('UPDATE enterprises SET name=?,credit_code=?,legal_person=?,source=?,updated_at=? WHERE id=?')
          .run(name, code, legalPerson || existing.legal_person || '', source, Date.now(), entityId);
      } else {
        db.prepare(`INSERT INTO enterprises VALUES(?,?,?,?,?,?) ON CONFLICT(credit_code) DO UPDATE SET
          name=excluded.name,legal_person=excluded.legal_person,source=excluded.source,updated_at=excluded.updated_at`)
          .run(entityId, name, code, legalPerson || existing?.legal_person || '', source, Date.now());
      }
      history(id, actor, source, { request, enterprise: existing ?? null }, { enterprise: entity(entityId) });
      link(id, entity(entityId), source, actor);
      // Preserve each original name/code while connecting compatible aliases to the same canonical enterprise.
      const related = db.prepare(`SELECT * FROM enterprise_requests WHERE id<>? AND
        (enterprise_id=? OR credit_code=? OR (name=? AND credit_code=''))`).all(id, entityId, code, name);
      for (const row of related) if (row.status !== 'review' || row.enterprise_id === entityId) link(row.id, entity(entityId), source, actor);
    });
  }
  async function providerQuery(keyword) {
    if (querying.has(keyword)) return querying.get(keyword);
    const saved = db.prepare('SELECT * FROM enterprise_provider_queries WHERE keyword=?').get(keyword);
    // Persist cooldowns across application restarts. Empty/partial answers are not paid again on every export.
    const ttl = saved?.status === 'error' ? 15 * 60_000 : saved?.status === 'running' ? 60_000 : 24 * 60 * 60_000;
    if (saved && now() - saved.queried_at < ttl) {
      if (saved.status === 'error') fail('企业查询服务暂不可用，请稍后重试', 502);
      if (saved.status === 'running') fail('企业查询正在恢复，请稍后重试', 429);
      return saved.status === 'not_found' ? null : JSON.parse(saved.result_json);
    }
    const work = (async () => {
      if (activeQueries >= providerConcurrency) await new Promise(resolve => waiting.push(resolve));
      else activeQueries++;
      try {
        if (closed || !settings().enabled || !configured) fail('付费企业查询未配置或未开启', 409);
        if (db.prepare('SELECT count(*) n FROM enterprise_provider_queries WHERE queried_at>?').get(now() - 60_000).n >= providerLimit) {
          fail('企业查询达到每分钟安全限额，请稍后重试', 429);
        }
        db.prepare(`INSERT INTO enterprise_provider_queries(keyword,status,result_json,queried_at) VALUES(?,'running','',?)
          ON CONFLICT(keyword) DO UPDATE SET status='running',result_json='',queried_at=excluded.queried_at`).run(keyword, now());
        try {
          const raw = await provider(keyword);
          // Keep only the three permitted fields; never cache an upstream body or credential.
          const value = raw ? { name: clean(raw.name), creditCode: clean(raw.creditCode).toUpperCase(), legalPerson: clean(raw.legalPerson) } : null;
          if (value && (!value.name || value.name.length > 200 || !validCreditCode(value.creditCode) || value.legalPerson.length > 100)) {
            fail('企业服务返回的名称或统一信用代码格式无效', 502);
          }
          if (!closed) db.prepare('UPDATE enterprise_provider_queries SET status=?,result_json=? WHERE keyword=?')
            .run(value ? 'success' : 'not_found', value ? JSON.stringify(value) : '', keyword);
          return value;
        } catch (error) {
          if (!closed) db.prepare("UPDATE enterprise_provider_queries SET status='error',result_json='' WHERE keyword=?").run(keyword);
          throw error;
        }
      } finally { const next = waiting.shift(); if (next) next(); else activeQueries--; }
    })();
    querying.set(keyword, work);
    try { return await work; } finally { querying.delete(keyword); }
  }
  async function performQuery(id, user, strategy = 'name-first') {
    let row = get(id);
    if (!row || row.status === 'review') return;
    if (cached(row, user.username, strategy) && get(id).status !== 'partial') return;
    row = get(id);
    const previous = db.prepare('SELECT * FROM enterprise_resolution_queries WHERE request_id=? AND strategy=?').get(id, strategy);
    const cooldown = previous?.status === 'not_found' ? 24 * 60 * 60_000 : previous?.status === 'error' ? 15 * 60_000 : 60_000;
    if (previous && now() - previous.queried_at < cooldown) return;
    if (!settings().enabled || !configured) return;
    db.prepare('UPDATE enterprise_requests SET attempts=attempts+1,queried_at=? WHERE id=?').run(now(), id);
    db.prepare(`INSERT INTO enterprise_resolution_queries VALUES(?,?,'running',?)
      ON CONFLICT(request_id,strategy) DO UPDATE SET status='running',queried_at=excluded.queried_at`).run(id, strategy, now());
    try {
      // Only licensed oversize resolves with an actual validated source code use code-first.
      // With that identity evidence, an empty code result must not guess a different company by name.
      let source = strategy === 'code-first' ? 'aliyun-code' : 'aliyun-name';
      let value = strategy === 'code-first' ? await providerQuery(row.credit_code) : row.name ? await providerQuery(row.name) : null;
      if (closed) return;
      if (!value && strategy !== 'code-first' && row.credit_code) { value = await providerQuery(row.credit_code); source = 'aliyun-code'; }
      if (closed) return;
      // An administrator may have corrected this record while the provider was in flight.
      if (get(id).status === 'review' || (cached(get(id), user.username, strategy) && get(id).status === 'success')) return;
      if (!value && get(id).enterprise_id) mark(id, 'partial', '企业库已有部分资料，云端暂未查到补充信息', source, user.username);
      else if (!value) mark(id, 'not_found', strategy === 'code-first' ? '原系统有效信用代码未查到企业；未按名称自动关联' : '名称及可用信用代码均未查到企业', source, user.username);
      else if (source === 'aliyun-name' && clean(value.name) !== row.name && (!row.credit_code || row.credit_code !== clean(value.creditCode).toUpperCase())) mark(id, 'review', '名称查询返回不同企业名称，请核对；未自动认定为同一家企业', source, user.username);
      else save(id, value, source, user.username);
    } catch (error) {
      if (!closed && get(id).status !== 'review' && !(cached(get(id), user.username, strategy) && get(id).status === 'success')) {
        mark(id, get(id).enterprise_id ? 'partial' : error.status === 429 ? 'pending' : 'error', error.status ? error.message : '企业查询失败，请检查服务配置', 'aliyun', user.username);
      }
    } finally {
      if (!closed) db.prepare('UPDATE enterprise_resolution_queries SET status=? WHERE request_id=? AND strategy=?').run(get(id).status, id, strategy);
    }
    if (!closed && user.id) audit(user, 'enterprise.queried', 'enterprise_request', id, { status: get(id).status });
  }
  async function query(id, user, strategy = 'name-first') {
    const key = `${id}:${strategy}`;
    if (resolving.has(key)) return resolving.get(key);
    // Different callers may resolve one shared request under different policies. Serialize mutation,
    // but deduplicate only equal policies and return this execution's snapshot to its own caller.
    const work = (requestTails.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await performQuery(id, user, strategy);
      return result(id);
    });
    resolving.set(key, work); requestTails.set(id, work);
    try { return await work; } finally {
      if (resolving.get(key) === work) resolving.delete(key);
      if (requestTails.get(id) === work) requestTails.delete(id);
    }
  }
  return {
    register, result, settings,
    async resolve(inputs, source, actor) {
      // source is the authorized system/tool id from the API, never a caller-selected query option.
      const registered = transaction(() => inputs.map(input => register(input, source, true)));
      const resolved = new Map(await Promise.all([...new Set(registered.map(item => item.requestId))].map(async id => {
        const strategy = source === 'oversize-transport' && validCreditCode(get(id).credit_code) ? 'code-first' : 'name-first';
        return [id, await query(id, actor, strategy)];
      })));
      return registered.map(item => resolved.get(item.requestId));
    },
    close() { closed = true; },
    async route(request, response, url, { user, readJson, json }) {
      const base = '/api/admin/enterprises';
      if (request.method === 'GET' && url.pathname === `${base}/settings`) return json(response, 200, { ...settings(), job });
      if (request.method === 'PATCH' && url.pathname === `${base}/settings`) {
        if (user.role !== 'admin') return json(response, 403, { error: '仅超级管理员可配置付费查询' });
        const body = await readJson(request);
        if (typeof body.enabled !== 'boolean' || (body.enabled && !configured)) fail('请先在服务端配置阿里云密钥');
        db.prepare('UPDATE enterprise_settings SET enabled=? WHERE id=1').run(Number(body.enabled));
        audit(user, 'enterprise.settings', 'enterprise', 'settings', { enabled: body.enabled });
        return json(response, 200, settings());
      }
      if (request.method === 'GET' && url.pathname === base) {
        const page = Math.max(1, Math.min(100000, Math.floor(Number(url.searchParams.get('page')) || 1)));
        const keyword = `%${(url.searchParams.get('keyword') ?? '').slice(0,200)}%`, status = url.searchParams.get('status') ?? '';
        const where = `WHERE (r.name LIKE ? OR r.credit_code LIKE ? OR e.name LIKE ? OR e.legal_person LIKE ?) AND (?='' OR r.status=?)`;
        const args = [keyword,keyword,keyword,keyword,status,status];
        const from = 'FROM enterprise_requests r LEFT JOIN enterprises e ON e.id=r.enterprise_id';
        return json(response, 200, { total: db.prepare(`SELECT count(*) n ${from} ${where}`).get(...args).n,
          rows: db.prepare(`SELECT r.*,e.name standard_name,e.credit_code standard_code,e.legal_person,e.source,e.updated_at ${from} ${where} ORDER BY r.created_at DESC,r.id LIMIT 20 OFFSET ?`).all(...args, (page-1)*20) });
      }
      if (request.method === 'POST' && url.pathname === base) {
        const value = register(await readJson(request));
        audit(user, 'enterprise.created', 'enterprise_request', value.requestId);
        return json(response, 201, value);
      }
      if (request.method === 'POST' && url.pathname === `${base}/query`) {
        if (!settings().enabled || !configured) return json(response, 409, { error: '付费企业查询未配置或未开启' });
        if (job?.running) return json(response, 409, { error: '已有企业补全批次正在运行' });
        const body = await readJson(request);
        if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 20 || body.ids.some(id => typeof id !== 'string' || !get(id))) fail('请选择 1–20 条企业记录');
        const ids = [...new Set(body.ids)];
        job = { id: randomUUID(), running: true, total: ids.length, completed: 0 };
        const currentJob = job;
        void (async () => {
          try { for (const id of ids) { if (closed || !settings().enabled) break; await query(id, user); currentJob.completed++; } }
          finally { currentJob.running = false; }
        })().catch(() => { currentJob.error = '补全批次中断，请查看记录状态后重试'; });
        return json(response, 202, currentJob);
      }
      const match = url.pathname.match(/^\/api\/admin\/enterprises\/([^/]+)(\/history)?$/);
      if (match && request.method === 'GET' && match[2]) {
        return json(response, 200, db.prepare('SELECT * FROM enterprise_history WHERE request_id=? ORDER BY created_at DESC LIMIT 100').all(match[1]));
      }
      if (match && request.method === 'PATCH' && !match[2]) {
        if (job?.running) return json(response, 409, { error: '请等待当前查询批次结束再人工修正，避免结果覆盖' });
        save(match[1], await readJson(request), 'manual', user.username, true);
        audit(user, 'enterprise.corrected', 'enterprise_request', match[1]);
        return json(response, 200, result(match[1]));
      }
      return json(response, 404, { error: '企业接口不存在' });
    },
  };
}
