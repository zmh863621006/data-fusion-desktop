const MATTER_NAME = '城市建筑垃圾处置（排放）核准';
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const compact = (value: string) => value.replace(/[\s\u3000]+/g, '');

export function isWaterBureau(value: unknown): boolean {
  return /水务局$/.test(compact(text(value)));
}

export function isDelegatedConstructionWaste(record: Record<string, unknown>): boolean {
  return record.sxmc === MATTER_NAME && isWaterBureau(record.applyer);
}

export function resolvedConstructionWasteContractor(record: Record<string, unknown>): string {
  const value = record.constructionWastePrincipal;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const evidence = value as Record<string, unknown>;
  const name = text(evidence.contractorName);
  return evidence.status === 'resolved' && name && !isWaterBureau(name) ? name : '';
}

/** Read a field label, not a fixed cell index or mentions in the permit's notes. */
export function constructionWasteContractors(tables: string[][][]): string[] {
  const names = new Set<string>();
  for (const table of tables) for (const row of table) {
    for (let index = 0; index < row.length; index++) {
      if (compact(row[index]).replace(/[:：]$/, '') !== '施工单位') continue;
      const name = row.slice(index + 1).map(text).find(Boolean) ?? '';
      if (!name || /[*＊]/.test(name) || isWaterBureau(name)
        || /^(?:无|暂无|待补充|不详|[-—/]+|施工单位|建设单位|工程名称|工程地点|统一社会信用代码)[:：]?$/.test(compact(name))) continue;
      names.add(name);
    }
  }
  return [...names];
}

/** Keep the proxy applicant and its credential for traceability, never as the contractor's identity. */
export function constructionWastePrincipalFields(
  record: Record<string, unknown>, tables: string[][][] = [], attachmentFailed = false,
): Record<string, unknown> {
  if (!isDelegatedConstructionWaste(record)) return {};
  const names = constructionWasteContractors(tables);
  const contractorName = names.length === 1 && !attachmentFailed ? names[0] : '';
  const status = attachmentFailed ? 'failed' : names.length > 1 ? 'ambiguous' : contractorName ? 'resolved' : 'missing';
  const reason = contractorName ? '' : attachmentFailed
    ? '成果附件读取失败，未确认施工单位，请人工核对'
    : names.length > 1 ? '成果附件存在多个不同施工单位，请人工核对'
    : '成果附件未取得施工单位，请人工核对';
  return {
    qymc: contractorName, xkXdrMc: contractorName,
    xydm: '', xkXdrShxym: '', frdb: '', xkFrdb: '',
    ajmc: contractorName ? `${contractorName}城市建筑废弃物排放核准证` : '',
    constructionWastePrincipal: { ruleVersion: 1, status, contractorName, reason,
      source: 'recordBean.primaryBean.cgwfj', field: '施工单位' },
    ...(!contractorName ? { enrichmentStatus: 'failed', fillStatus: '0' } : {}),
  };
}
