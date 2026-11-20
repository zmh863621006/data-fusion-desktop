const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function reject(message, status = 400, code = 'LICENSE_SCOPE_INVALID') {
  throw Object.assign(new Error(message), { status, code });
}

function identifiers(value, label, maxCount = 500) {
  if (!Array.isArray(value) || value.length > maxCount || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) reject(`${label}格式无效`);
  return [...new Set(value)];
}

function matters(value, legacy = false) {
  if (legacy && value === null) return null;
  if (!object(value) || (!legacy && Object.keys(value).length > 100)) reject('授权事项格式无效');
  const entries = [];
  for (const [systemId, selected] of Object.entries(value)) {
    if (!systemId.trim() || systemId.length > 200) reject('业务系统标识无效');
    // In older signed grants a null/missing entry meant all matters, not none.
    if (legacy && selected === null) continue;
    entries.push([systemId, identifiers(selected, '业务事项', legacy ? Infinity : 500)]);
  }
  return Object.fromEntries(entries);
}

export function storedLicenseScope(license) {
  try {
    return {
      allowedSystems: identifiers(JSON.parse(license.allowed_systems_json), '已有业务系统', Infinity),
      allowedTools: identifiers(JSON.parse(license.allowed_tools_json ?? '[]'), '已有授权工具', Infinity),
      allowedMatters: matters(license.allowed_matters_json == null ? null : JSON.parse(license.allowed_matters_json), true),
    };
  } catch {
    reject('已有授权范围数据异常，请联系管理员核对', 409, 'LICENSE_SCOPE_CORRUPT');
  }
}

const canonical = scope => JSON.stringify([
  [...scope.allowedSystems].sort(), [...scope.allowedTools].sort(),
  scope.allowedMatters === null ? null : Object.entries(scope.allowedMatters).sort(([left], [right]) => left.localeCompare(right))
    .map(([id, selected]) => [id, [...selected].sort()]),
]);

/** Validate an explicit replacement against the latest scope inside a write transaction. */
export function prepareLicenseScope(database, toolCatalog, license, body) {
  if (Object.keys(body).some(key => !['allowedSystems', 'allowedTools', 'allowedMatters', 'expectedScope'].includes(key))) reject('本操作仅支持调整系统、工具及业务事项范围');
  const expected = body.expectedScope;
  if (!object(expected) || !['allowedSystems', 'allowedTools', 'allowedMatters'].every(key => own(expected, key))
    || Object.keys(expected).some(key => !['allowedSystems', 'allowedTools', 'allowedMatters'].includes(key))) reject('缺少原授权范围，请刷新后重试');
  const before = storedLicenseScope(license);
  const normalizedExpected = {
    allowedSystems: identifiers(expected.allowedSystems, '原业务系统', Infinity),
    allowedTools: identifiers(expected.allowedTools, '原授权工具', Infinity),
    allowedMatters: matters(expected.allowedMatters, true),
  };
  if (canonical(before) !== canonical(normalizedExpected)) reject('授权范围已被其他操作修改，请刷新后重新调整', 409, 'LICENSE_SCOPE_CONFLICT');

  const systems = identifiers(body.allowedSystems, '授权业务系统');
  const tools = identifiers(body.allowedTools, '授权工具');
  const selectedMatters = matters(body.allowedMatters);
  if (!systems.length && !tools.length) reject('请至少保留一个业务系统或工具');
  if (Object.keys(selectedMatters).some(id => !systems.includes(id)) || systems.some(id => !own(selectedMatters, id))) reject('请为所选系统明确设置业务事项，不得包含其他系统');

  const previousSystems = new Set(before.allowedSystems), previousTools = new Set(before.allowedTools);
  const knownSystems = new Map(database.prepare('SELECT id,enabled FROM systems').all().map(row => [row.id, row]));
  const knownTools = new Set(toolCatalog.map(tool => tool.id));
  if (systems.some(id => !previousSystems.has(id) && !knownSystems.get(id)?.enabled)) reject('不能新增未启用或不存在的业务系统');
  if (tools.some(id => !knownTools.has(id) && !previousTools.has(id))) reject('不能新增不存在的工具');
  for (const systemId of systems) {
    const catalog = new Map(database.prepare('SELECT id,enabled FROM system_matters WHERE system_id=?').all(systemId).map(row => [row.id, row]));
    const selected = selectedMatters[systemId];
    if (catalog.size && !selected.length) reject(`请为系统 ${systemId} 选择至少一个业务事项`);
    const retained = previousSystems.has(systemId);
    const oldMatters = before.allowedMatters && own(before.allowedMatters, systemId) ? before.allowedMatters[systemId] : undefined;
    const previousAll = retained && oldMatters === undefined;
    for (const id of selected) {
      const active = Boolean(knownSystems.get(systemId)?.enabled && catalog.get(id)?.enabled);
      const previouslyAllowed = retained && (previousAll ? catalog.has(id) : oldMatters.includes(id));
      if (!active && !previouslyAllowed) reject(`系统 ${systemId} 包含未授权的停用、未知或跨系统事项`);
    }
  }
  const after = { allowedSystems: systems, allowedTools: tools, allowedMatters: selectedMatters };
  return { before, after, changed: canonical(before) !== canonical(after) };
}
