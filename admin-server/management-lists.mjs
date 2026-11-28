export function pageOptions(params) {
  const integer = (name, fallback, max) => {
    const value = Number(params.get(name));
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(max, Math.floor(value))) : fallback;
  };
  return { page: integer('page', 1, 100000), pageSize: integer('pageSize', 20, 100) };
}

export function createManagementLists(db, describeUpdate) {
  db.exec(`CREATE INDEX IF NOT EXISTS customers_created_page ON customers(created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS licenses_created_page ON licenses(created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS devices_activated_page ON devices(activated_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS updates_published_page ON updates(published_at DESC,id DESC);`);
  const licenseFrom = 'FROM licenses l JOIN customers c ON c.id=l.customer_id';
  const licenseFields = 'l.*,c.name customer_name,c.enabled customer_enabled';
  function list(kind, params) {
    const { page, pageSize } = pageOptions(params), clauses = [], args = [];
    const text = key => (params.get(key) ?? '').trim().slice(0, 200);
    const equal = (field, key) => { if (text(key)) { clauses.push(`${field}=?`); args.push(text(key)); } };
    const contains = (field, key) => { if (text(key)) { clauses.push(`instr(lower(coalesce(${field},'')),lower(?))>0`); args.push(text(key)); } };
    let from, fields, order;
    if (kind === 'customers') {
      from = 'FROM customers c'; fields = 'c.*'; order = 'c.created_at DESC,c.id DESC';
      contains('c.name', 'name'); contains('c.contact', 'contact'); equal('c.enabled', 'enabled'); equal('c.id', 'id');
    } else if (kind === 'licenses') {
      from = licenseFrom; fields = licenseFields; order = 'l.created_at DESC,l.id DESC';
      contains('c.name', 'customer_name'); equal('l.mode', 'mode'); equal('l.customer_id', 'customerId'); equal('l.id', 'id');
      const ref = text('reference').toLowerCase().replace('...', '…');
      if (ref) {
        clauses.push(`(lower(l.id)=? OR EXISTS(SELECT 1 FROM devices d WHERE d.license_id=l.id AND
          (lower(d.device_id)=? OR lower(substr(d.device_id,1,12)||'…'||substr(d.device_id,-8))=?)))`);
        args.push(ref, ref, ref);
      }
      const component = text('component');
      if (component) {
        const split = component.indexOf(':'), type = component.slice(0, split), id = component.slice(split + 1);
        if (!['system', 'tool'].includes(type) || !id) clauses.push('0');
        else {
          const column = type === 'system' ? 'l.allowed_systems_json' : 'l.allowed_tools_json';
          clauses.push(`EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END) WHERE value=?)`); args.push(id);
        }
      }
      const status = text('status');
      if (status === 'active') { clauses.push("l.status='active' AND c.enabled=1 AND l.expires_at>?"); args.push(Date.now()); }
      else if (status === 'expired') { clauses.push("l.status<>'revoked' AND c.enabled=1 AND l.expires_at<=?"); args.push(Date.now()); }
      else if (status === 'customerDisabled') clauses.push("l.status<>'revoked' AND c.enabled=0");
      else if (status) equal('l.status', 'status');
    } else if (kind === 'devices') {
      from = 'FROM devices d JOIN licenses l ON l.id=d.license_id JOIN customers c ON c.id=l.customer_id';
      fields = 'd.*,c.name customer_name'; order = 'd.activated_at DESC,d.id DESC';
      contains('c.name', 'customer_name'); contains('d.device_id', 'device_id'); equal('d.status', 'status'); equal('d.license_id', 'licenseId');
    } else if (kind === 'updates') {
      from = 'FROM updates u LEFT JOIN update_artifacts a ON a.update_id=u.id'; fields = 'u.*'; order = 'u.published_at DESC,u.id DESC';
      contains('u.version', 'version'); contains('u.notes', 'notes');
      for (const key of ['platform', 'arch', 'variant']) equal(`u.${key}`, key);
      equal("CASE WHEN a.state='uploading' THEN 'uploading' WHEN u.enabled=1 THEN 'published' WHEN a.update_id IS NULL OR a.published_once=1 THEN 'disabled' ELSE 'draft' END", 'status');
    } else throw new Error('Unknown management list');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = db.prepare(`SELECT count(*) n ${from} ${where}`).get(...args).n;
    const rows = db.prepare(`SELECT ${fields} ${from} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    return { page, pageSize, total, rows: kind === 'updates' ? rows.map(describeUpdate) : rows };
  }
  function summary() {
    const count = sql => db.prepare(sql).get().n;
    const latest = db.prepare("SELECT * FROM updates WHERE target_type='app' AND enabled=1 ORDER BY published_at DESC,id DESC LIMIT 1").get();
    const systemLicenseCounts = Object.fromEntries(db.prepare(`SELECT j.value id,count(*) n FROM licenses l,
      json_each(CASE WHEN json_valid(l.allowed_systems_json) THEN l.allowed_systems_json ELSE '[]' END) j GROUP BY j.value`).all().map(row => [row.id, row.n]));
    return {
      customers: count('SELECT count(*) n FROM customers'),
      activeLicenses: db.prepare(`SELECT count(*) n ${licenseFrom} WHERE l.status='active' AND c.enabled=1 AND l.expires_at>?`).get(Date.now()).n,
      activeDevices: count("SELECT count(*) n FROM devices WHERE status='active'"),
      enabledSystems: count('SELECT count(*) n FROM systems WHERE enabled=1'), systemLicenseCounts,
      recentLicenses: db.prepare(`SELECT ${licenseFields} ${licenseFrom} ORDER BY l.created_at DESC,l.id DESC LIMIT 6`).all(),
      latestRelease: latest ? describeUpdate(latest) : null,
    };
  }
  return { list, summary };
}
