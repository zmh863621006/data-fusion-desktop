import type { SignedLicenseEnvelope } from '../license/signed-license';
import { applyFixedDrainagePermitContent, calculateFillStatus, type GovernmentReturnRecord } from '../../plugins/government-info/field-rules';
import { normalizeCreditCode as code } from './credit-code';
import { readOversizeApplicationEvidence } from '../../plugins/oversize-transport/application';
import { isDelegatedConstructionWaste, resolvedConstructionWasteContractor } from '../../plugins/government-info/construction-waste';

interface EnterpriseInput { name: string; creditCode: string; applicantCode: string }
export interface EnterpriseResult {
  requestId: string; status: string; reason: string;
  enterprise: { id: string; name: string; creditCode: string; legalPerson: string; source: string; updatedAt: number } | null;
}
interface Evidence {
  requestId: string; status: string; reason: string; input: EnterpriseInput;
  enterprise?: EnterpriseResult['enterprise']; before: Record<string, unknown>; applied: Record<string, unknown>;
  identity?: Record<string, string>;
}
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
function evidence(row: Record<string, unknown>): Evidence | undefined {
  const value = row.enterpriseEnrichment;
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Evidence;
  return entry.input && typeof entry.input.name === 'string' && entry.before && entry.applied ? entry : undefined;
}
function identityKeys(systemId: string): [string[], string[], string[]] {
  return systemId === 'government-info'
    ? [['xkXdrMc', 'qymc'], ['xkXdrShxym', 'xydm'], ['xkFrdb', 'frdb']]
    : [['xkXdrMc'], ['xkXdrShxym'], ['xkFrdb']];
}
export function enterpriseInput(systemId: string, row: Record<string, unknown>): EnterpriseInput | null {
  if (!['government-info', 'oversize-transport', 'online-car-permit', 'health-publicity'].includes(systemId)) return null;
  if (systemId === 'oversize-transport' && readOversizeApplicationEvidence(row.oversizeApplicationEnrichment)?.status === 'conflict') return null;
  const government = systemId === 'government-info';
  const delegated = government && isDelegatedConstructionWaste(row);
  if (delegated && !resolvedConstructionWasteContractor(row)) return null;
  if ([row.qylx, row.xkXdrLb].some(value => text(value) === '自然人')) return null;
  const category = text(row.xkXdrLb || (government ? row.qylx : ''));
  if (category === '自然人' || (!government && category !== '法人及非法人组织'
    && !(['oversize-transport', 'health-publicity'].includes(systemId) && category === '个体工商户'))) return null;
  const previous = evidence(row);
  const [nameKeys, creditKeys, legalKeys] = identityKeys(systemId);
  // Already complete source/manual records need no backend access (and no paid-provider lookup).
  if (creditKeys.some(key => code(row[key])) && legalKeys.some(key => text(row[key]))) return null;
  // Re-query original identity, but respect a subsequent user edit of identity fields.
  const identityUnchanged = previous && (previous.identity
    ? Object.entries(previous.identity).every(([key,value])=>text(row[key])===value)
    : [...nameKeys, ...creditKeys].every(key => key in previous.applied ? row[key] === previous.applied[key]
      : !text(row[key]) || text(row[key]) === (nameKeys.includes(key) ? previous.input.name : previous.input.creditCode)));
  if (identityUnchanged) return systemId === 'oversize-transport'
    ? { ...previous.input, creditCode: creditKeys.map(key => code(row[key])).find(Boolean) || previous.input.creditCode }
    : delegated ? { ...previous.input, applicantCode: '' } : previous.input;
  const name = nameKeys.map(key => text(row[key])).find(Boolean) || (government && !delegated ? text(row.applyer) : '');
  const creditCode = creditKeys.map(key => code(row[key])).find(Boolean) || '', applicantCode = government && !delegated ? code(row.cardNumber) : '';
  if (!name && !creditCode && !applicantCode) return null;
  if (government && !category && !creditCode && !applicantCode && !/(公司|企业|集团|厂|店|中心|医院|学校|协会|合作社|事务所|委员会|局|院)/.test(name)) return null;
  return { name, creditCode, applicantCode };
}

export function applyEnterpriseResult(systemId: string, row: Record<string, unknown>, input: EnterpriseInput, result: EnterpriseResult): Record<string, unknown> {
  const oldEvidence = evidence(row), government = systemId === 'government-info';
  const previous = oldEvidence && JSON.stringify(oldEvidence.input) === JSON.stringify(input) ? oldEvidence : undefined;
  const [nameKeys, creditKeys, legalKeys] = identityKeys(systemId);
  const next = { ...row };
  const before = { ...previous?.before }, applied: Record<string, unknown> = { ...previous?.applied };
  for (const [key,value] of Object.entries(applied)) if (row[key] !== value) delete applied[key];
  const value = result.enterprise;
  let status = result.status, reason = result.reason;
  if (value && ['success', 'partial'].includes(status)) {
    const currentCodes = [...creditKeys.map(key => code(row[key])), input.applicantCode].filter(Boolean);
    if (!code(value.creditCode) || currentCodes.some(currentCode => currentCode !== value.creditCode)) { status = 'review'; reason = '业务信用代码与企业库冲突或返回代码无效，未回填'; }
    else {
      const fields: [string, string][] = [...nameKeys.map(key => [key, value.name] as [string, string]),
        ...creditKeys.map(key => [key, value.creditCode] as [string, string]), ...legalKeys.map(key => [key, value.legalPerson] as [string, string])];
      for (const [key, field] of fields) {
        const old = row[key];
        const managed = previous && key in previous.applied && old === previous.applied[key];
        // Canonical name is allowed after server identity verification; manual nonempty business fields are preserved.
        const replaceName = government && nameKeys.includes(key) && text(old) === input.name;
        if (field && (!text(old) || managed || replaceName)) {
          if (!(key in before)) before[key] = old ?? '';
          next[key] = field; applied[key] = field;
        } else if (field && text(old) && text(old) !== field) {
          status = 'review'; reason = '业务记录已有字段与企业库不同，保留原值待核对';
        }
      }
    }
  }
  if (systemId === 'oversize-transport' && ['success', 'partial'].includes(status) && code(next.xkXdrShxym)) {
    next.xkXdrLb = text(next.xkXdrShxym).startsWith('92') ? '个体工商户' : '法人及非法人组织';
  }
  const identity = Object.fromEntries([...nameKeys, ...creditKeys, ...(government ? ['cardNumber', 'applyer'] : [])].map(key=>[key,text(next[key])]));
  next.enterpriseEnrichment = { requestId: result.requestId, status, reason, input, enterprise: value ?? previous?.enterprise ?? null, before, applied, identity } satisfies Evidence;
  if (government) next.fillStatus = calculateFillStatus(next as GovernmentReturnRecord);
  return government ? applyFixedDrainagePermitContent(next) : next;
}

/** A source re-fetch must not wipe the enterprise fields previously obtained while online. */
export function mergeEnterpriseRecord(systemId: string, incoming: Record<string, unknown>, previous: Record<string, unknown>): Record<string, unknown> {
  const old = evidence(previous), current = evidence(incoming), input = enterpriseInput(systemId, incoming);
  if (!old || !input || JSON.stringify(old.input) !== JSON.stringify(input)) return incoming;
  let next = incoming;
  if (!current && old.enterprise && (['success','partial'].includes(old.status) || Object.keys(old.applied).length > 0)) {
    next = applyEnterpriseResult(systemId, incoming, input, { requestId: old.requestId, status: old.enterprise.legalPerson ? 'success' : 'partial', reason: old.reason, enterprise: old.enterprise });
  }
  const government = systemId === 'government-info';
  // Preserve a subsequent manual edit, even if a fresh cache result arrived with the new source record.
  for (const legalKey of identityKeys(systemId)[2]) {
    if (legalKey in old.applied && text(previous[legalKey]) && previous[legalKey] !== old.applied[legalKey]) {
      next = { ...next, [legalKey]: previous[legalKey] };
      const updated = evidence(next);
      if (updated) next.enterpriseEnrichment = { ...updated, status: 'review', reason: '保留已人工修改的法人字段，请核对' };
    }
  }
  if (government && next !== incoming) next.fillStatus = calculateFillStatus(next as GovernmentReturnRecord);
  return next;
}

export class EnterpriseEnrichmentService {
  private cache = new Map<string, { at: number; value: EnterpriseResult }>();
  private inFlight = new Map<string, Promise<EnterpriseResult>>();
  private unavailableUntil = 0;
  constructor(private readonly endpoint: string | undefined,
    private readonly authorization: () => Promise<{ proof: SignedLicenseEnvelope; deviceId: string } | null>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly insecureHttpOrigin?: string) {}

  async enrich(systemId: string, matterId: string, rows: Record<string, unknown>[], signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const inputs = rows.map(row => enterpriseInput(systemId, row));
    if (!inputs.some(Boolean)) return rows;
    const results = new Map<string, EnterpriseResult>();
    const inputKey = (input: EnterpriseInput) => JSON.stringify(input);
    let unavailable: EnterpriseResult = { requestId: '', status: 'error', reason: '企业补全服务暂不可用，已保留原系统字段，请稍后重试', enterprise: null };
    try {
      if (!this.endpoint) throw new Error('Enterprise endpoint not configured');
      if (Date.now() < this.unavailableUntil) throw new Error('Enterprise endpoint cooling down');
      const url = new URL(this.endpoint);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.origin === this.insecureHttpOrigin))) throw new Error('Enterprise endpoint must use HTTPS or an explicitly configured HTTP origin');
      const auth = await this.authorization(); if (!auth) {
        unavailable = { ...unavailable, reason: '企业补全需要有效的后台连接授权，已保留原系统字段' };
        throw new Error('Enterprise authorization unavailable');
      }
      const prefix = `${auth.proof.signature}:${systemId}:${matterId}:`;
      const key = (input: EnterpriseInput) => prefix + JSON.stringify(input);
      const unique = [...new Map(inputs.filter((item): item is EnterpriseInput => Boolean(item)).map(input => [key(input), input])).values()];
      for (const [id, entry] of this.cache) if (Date.now() - entry.at > 30_000) this.cache.delete(id);
      const missing = unique.filter(input => !this.cache.has(key(input)));
      // Four companies fit the backend provider's concurrency window. Await each cloud lookup before
      // returning to the save pipeline, while retaining earlier successful batches if a later one fails.
      for (let offset = 0; offset < missing.length; offset += 4) {
        if (signal?.aborted || Date.now() < this.unavailableUntil) break;
        const batch = missing.slice(offset, offset + 4);
        const fresh = batch.filter(input => !this.inFlight.has(key(input)));
        if (fresh.length) {
          const request = (async () => {
            const response = await this.fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...auth, systemId, matterId, items: fresh }), redirect: 'error',
              signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
            if (!response.ok) throw new Error('Enterprise service unavailable');
            const body = await response.json() as { results: EnterpriseResult[] };
            if (!Array.isArray(body.results) || body.results.length !== fresh.length
              || body.results.some(result => !result || typeof result.requestId !== 'string' || typeof result.status !== 'string')) throw new Error('Invalid enterprise response');
            return body.results;
          })().catch(() => {
            if (!signal?.aborted) {
              this.unavailableUntil = Date.now() + 30_000;
              console.warn('企业补全服务暂不可用，保留业务原数据，30 秒后可重试');
            }
            return fresh.map(() => unavailable);
          });
          fresh.forEach((input, index) => {
            const id = key(input);
            this.inFlight.set(id, request.then(values => {
              const value = values[index];
              if (value.requestId) this.cache.set(id, { at: Date.now(), value });
              return value;
            }).finally(() => this.inFlight.delete(id)));
          });
        }
        await Promise.all(batch.map(async input => {
          const value = this.cache.get(key(input))?.value ?? await this.inFlight.get(key(input));
          if (value) results.set(inputKey(input), value);
        }));
      }
      for (const input of unique) {
        const value = this.cache.get(key(input))?.value;
        if (value) results.set(inputKey(input), value);
      }
      if (this.cache.size > 5000) this.cache.clear();
    } catch {
      this.unavailableUntil = Math.max(this.unavailableUntil, Date.now() + 30_000);
      // Never log names, codes, credentials or upstream response bodies.
    }
    if (signal?.aborted) unavailable = { ...unavailable, reason: '企业补全已取消，已保留原系统字段' };
    return rows.map((row, index) => {
      const input = inputs[index];
      return input ? applyEnterpriseResult(systemId, row, input, results.get(inputKey(input)) ?? unavailable) : row;
    });
  }
}
