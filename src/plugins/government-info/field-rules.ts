/** Source rules ported from TZwzhServiceImpl, with explicit user overrides documented in docs/21-government-completion-query.md. */
import { constructionWastePrincipalFields } from './construction-waste';

export const NEW_DRAINAGE_PERMIT_MATTER = '污水排入排水管网许可证核发（新办）';
export const NEW_DRAINAGE_PERMIT_CONTENT = '根据《城镇排水与污水处理条例》（中华人民共和国国务院令第641号）以及《城镇污水排入排水管网许可管理办法》（2015年1月22日住房和城乡建设部令第21号发布，根据2022年12月1日住房和城乡建设部令第56号修正）的规定，经审查，准予在许可范围内（详见副本）向城镇排水设施排放污水。\n特发此证';

/** Keep the approved body and prefix the best available enterprise name, including on detail failure. */
export function applyFixedDrainagePermitContent<T extends Record<string, unknown>>(record: T): T {
  if (record.sxmc !== NEW_DRAINAGE_PERMIT_MATTER) return record;
  const enterpriseName = [record.qymc, record.xkXdrMc, record.applyer]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim();
  const content = `${enterpriseName ? `${enterpriseName}：` : ''}${NEW_DRAINAGE_PERMIT_CONTENT}`;
  return { ...record, xknr: content, xkNr: content };
}

export interface GovernmentReturnRecord extends Record<string, unknown> {
  cityLsh: string;
  sxmc: string;
  applyer?: string;
  cardNumber?: string;
  xkbh?: string;
  qymc?: string;
  frdb?: string;
  xydm?: string;
  xknr?: string;
  ajmc?: string;
  xkjdrq?: string;
  yxqs?: string;
  yxqe?: string;
  qylx?: string;
  fillStatus?: '0' | '1';
}

export interface RunningPrimaryBean {
  zjbh?: string;
  zzsj?: string;
  zjyxqstart?: string;
  zjyxqend?: string;
}

export interface ParsedApprovalDocument {
  paragraphs: string[];
  tables: string[][][];
}

const REQUIRED_COMPLETION_FIELDS = ['xkbh', 'qymc', 'frdb', 'xydm', 'xknr', 'ajmc', 'xkjdrq', 'yxqs'] as const;

export function calculateFillStatus(record: GovernmentReturnRecord): '0' | '1' {
  return REQUIRED_COMPLETION_FIELDS.every((key) => String(record[key] ?? '').trim()) ? '1' : '0';
}

export function applyRunningDates(record: GovernmentReturnRecord, primary: RunningPrimaryBean): GovernmentReturnRecord {
  return {
    ...record,
    xkbh: primary.zjbh ?? record.xkbh,
    xkjdrq: primary.zzsj,
    yxqs: primary.zjyxqstart,
    yxqe: primary.zjyxqend,
  };
}

export function enrichDrainagePermit(
  record: GovernmentReturnRecord,
  primary: RunningPrimaryBean,
  enterpriseName: string,
): GovernmentReturnRecord {
  const enriched = applyRunningDates(record, primary);
  return applyFixedDrainagePermitContent({
    ...enriched,
    qymc: enterpriseName,
    xknr: `${enterpriseName}：根据《城镇排水与污水处理条例》（中华人民共和国国务院令第641号）、《城镇污水排入排水管网许可管理办法》（中华人民共和国住房和城乡建设部令第21号）以及《深圳经济特区排水条例》的规定，经审查，准予在许可范围内向城镇排水设施排水。`,
    ajmc: `${enterpriseName}污水排入排水管网许可证核发`,
    qylx: '法人及非法人组织',
  });
}

function cell(document: ParsedApprovalDocument, row: number, column: number): string {
  const value = document.tables[0]?.[row]?.[column];
  if (value === undefined) throw new Error(`附件表格缺少 [${row}, ${column}] 单元格`);
  return value;
}

function splitBefore(value: string, marker: string): string {
  const index = value.indexOf(marker);
  // Java split(marker)[0] keeps the complete text when no marker exists.
  return index < 0 ? value : value.slice(0, index);
}

function splitAfter(value: string, marker: string): string {
  const index = value.indexOf(marker);
  if (index < 0) throw new Error(`附件内容缺少分隔标记：${marker}`);
  return value.split(marker)[1];
}

export function enrichConstructionWaste(
  record: GovernmentReturnRecord,
  primary: RunningPrimaryBean,
  document: ParsedApprovalDocument,
): GovernmentReturnRecord {
  const enriched = applyRunningDates(record, primary);
  return {
    ...enriched,
    xkbh: String(enriched.xkbh ?? '').replaceAll('编号：', ''),
    xknr: splitBefore(cell(document, 0, 0), '发证机关'),
    qymc: record.applyer,
    ajmc: `${record.applyer ?? ''}城市建筑废弃物排放核准证`,
    qylx: '法人及非法人组织',
    xydm: record.cardNumber,
    ...constructionWastePrincipalFields(record, document.tables),
  };
}

export function enrichWaterTableDocument(
  record: GovernmentReturnRecord,
  primary: RunningPrimaryBean,
  document: ParsedApprovalDocument,
  publicWaterFacility = false,
): GovernmentReturnRecord {
  const documentName = cell(document, 0, 1);
  const rawContent = cell(document, 4, 1);
  const xknr = publicWaterFacility
    ? splitBefore(rawContent, '深圳市南山区水务局')
    : documentName === '深圳市南山区水务局'
      ? `深圳市南山区水务${splitAfter(rawContent, '深圳市南山区水务')}`
      : splitBefore(rawContent, '深圳市南山区水务');
  return {
    ...applyRunningDates(record, primary),
    xknr,
    qymc: record.applyer,
    ajmc: `${documentName}${cell(document, 3, 1)}`,
    qylx: '法人及非法人组织',
    xydm: cell(document, 1, 1),
  };
}

export function enrichSoilWaterConservation(
  record: GovernmentReturnRecord,
  primary: RunningPrimaryBean,
  document: ParsedApprovalDocument,
): GovernmentReturnRecord {
  if (!String(primary.zjbh ?? '').includes('深南水准予告')) {
    return enrichWaterTableDocument(record, primary, document);
  }
  const text = document.paragraphs.join('');
  const afterTitle = splitAfter(text, '深圳市南山区水务局准予行政许可决定书');
  const enterprisePrefix = splitBefore(afterTitle, '我局收到你单位');
  const matterPart = splitBefore(splitAfter(afterTitle, '我局收到你单位'), '申请（');
  return {
    ...applyRunningDates(record, primary),
    xknr: splitBefore(afterTitle, '附件'),
    qymc: record.applyer,
    ajmc: `${enterprisePrefix}${matterPart}`,
    qylx: '法人及非法人组织',
  };
}

export function extractContentByType(content: string, type: string): string | undefined {
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.match(new RegExp(`(${escaped})[^；，。、]+`))?.[0].replace(/㎡/g, '平方米');
}

export function enrichGreenSpaceOccupation(record: GovernmentReturnRecord, primary: RunningPrimaryBean, opinion: string): GovernmentReturnRecord {
  let xknr = opinion;
  let ajmc = '';
  if (opinion.includes('占用') && opinion.includes('改变')) {
    ajmc = '改变城市绿地使用性质、临时占用城市绿地';
  } else if (opinion.includes('占用')) {
    ajmc = '临时占用城市绿地';
    xknr = sliceThroughArea(opinion, '临时占用城市绿地');
  } else if (opinion.includes('改变')) {
    ajmc = '改变城市绿地使用性质';
    xknr = sliceThroughArea(opinion, '改变城市绿地使用');
  }
  return { ...applyRunningDates(record, primary), qymc: record.applyer, qylx: '法人及非法人组织', ajmc, xknr };
}

function sliceThroughArea(content: string, startMarker: string): string {
  const start = content.indexOf(startMarker);
  const end = content.indexOf('㎡', start);
  if (start < 0 || end < 0) throw new Error('审批意见缺少原项目规则需要的面积标记');
  return content.slice(start, end + 1).replace(/㎡/g, '平方米');
}

export function enrichTreeFellingRelocation(
  record: GovernmentReturnRecord,
  primary: RunningPrimaryBean,
  opinion: string,
): GovernmentReturnRecord[] {
  const base = { ...applyRunningDates(record, primary), qymc: record.applyer, qylx: '法人及非法人组织' };
  const records: GovernmentReturnRecord[] = [];
  const documentNumber = String(base.xkbh ?? '');
  if (documentNumber.includes('、')) {
    const [first, shortSecond] = documentNumber.split('、');
    const second = first.slice(0, first.length - shortSecond.length) + shortSecond;
    records.push(applyTreeOpinion({ ...base, cityLsh: `${record.cityLsh}_001`, xkbh: first }, opinion, true));
    base.xkbh = second;
  }
  records.push(applyTreeOpinion(base, opinion, false));
  return records;
}

function applyTreeOpinion(record: GovernmentReturnRecord, opinion: string, greenPart: boolean): GovernmentReturnRecord {
  const rules = greenPart
    ? [
      { all: ['占用', '改变'], name: '改变城市绿地使用性质、临时占用城市绿地', types: ['临时', '改变'] },
      { all: ['占用'], name: '临时占用城市绿地', types: ['临时'] },
      { all: ['改变'], name: '改变城市绿地使用性质', types: ['改变'] },
    ]
    : [
      { all: ['砍伐', '迁移'], name: '砍伐、迁移城市树木', types: ['砍伐', '迁移'] },
      { all: ['砍伐'], name: '砍伐城市树木', types: ['砍伐'] },
      { all: ['迁移'], name: '迁移城市树木', types: ['迁移'] },
    ];
  const rule = rules.find((candidate) => candidate.all.every((keyword) => opinion.includes(keyword)));
  if (!rule) return record;
  return {
    ...record,
    ajmc: rule.name,
    xknr: rule.types.map((type) => extractContentByType(opinion, type)).join('、'),
  };
}
