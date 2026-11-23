import { AppError } from '../../core/errors/app-error';
import { normalizeCreditCode } from '../../core/enterprise/credit-code';
import type { QueryContext, QueryPage } from '../../core/query/types';
import { EQUIPMENT_CITIES } from './catalog';
import { sourceFailure, sourceText, type EquipmentReadKind, type EquipmentRow, type SpecialEquipmentClient } from './client';

const DAY = 86_400_000;
const REGISTER_CERTIFICATE = '特种设备使用登记证';
const PERSONNEL_CERTIFICATE = '特种设备安全管理和作业人员证';
const PERSONNEL_MATTER = '特种设备作业人员考核';
const DECISION_DOCUMENT = '准予行政许可决定书';
const APPLY_TYPES: Record<string, string> = {
  '1': '使用登记', '2': '更名变更', '3': '移装', '4': '仅过户', '5': '设备状态变更', '6': '换证',
  '7': '补证', '9': '注销', '10': '过户并移装', '11': '换证', '12': '产权单位更名变更', '13': '设备使用地点变更',
};

const HUIZHOU_AUTHORITIES = [
  ['惠城区', '惠州市惠城区市场监督管理局', '11441302351971239H'],
  ['惠阳区', '惠州市惠阳区市场监督管理局', '11441303MB2C47313U'],
  ['博罗县', '博罗县市场监督管理局', '114413223547593214'],
  ['龙门县', '龙门县市场监督管理局', '11441324MB2C20196D'],
  ['惠东县', '惠东县市场监督管理局', '11441323MB2C08058M'],
  ['大亚湾', '惠州大亚湾经济技术开发区管理委员会市场监督管理局', '11441300MB2E2413XP'],
  ['仲恺', '惠州仲恺高新技术产业开发区管理委员会市场监督管理局', '11441300MB2E23946P'],
  ['惠州市市场监督管理局', '惠州市市场监督管理局', '11441300MB2C90987A'],
];

function authority(value: unknown, city: string): EquipmentRow {
  const original = sourceText(value);
  const mapped = city === '441300' ? HUIZHOU_AUTHORITIES.find(([district]) => original.includes(district)) : undefined;
  const [, name = original, code = ''] = mapped ?? [];
  return { xkXkjg: name, xkXkjgdm: code, xkLydw: name, xkLydwdm: code };
}

function approvedDocument(documents: EquipmentRow[]): string {
  const numbers = new Set(documents.filter(document => {
    const name = sourceText(document.fileName);
    return name.includes(DECISION_DOCUMENT) && !name.includes('不准予');
  }).map(document => sourceText(document.number)).filter(Boolean));
  return numbers.size === 1 ? numbers.values().next().value! : '';
}

function permitDate(value: unknown): string {
  const parts = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/.exec(sourceText(value));
  if (!parts) return '';
  const date = `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`;
  const time = Date.parse(date);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? date : '';
}

function permitFields(title: string, certificate: string, category: string) {
  return { xzxkmc: title, xkXkws: DECISION_DOCUMENT, xkXkzs: certificate,
    xkXklb: category, xkZt: '1', xkCljg: '予以许可', xkZqly: '依职权' };
}

function registrationRow(application: EquipmentRow, equipment: EquipmentRow, documentNumber: string, city: string): EquipmentRow {
  const name = sourceText(application.nameOfUser), identity = sourceText(application.socialCreditCodeOfUser);
  const organization = Boolean(normalizeCreditCode(identity)) || name.length > 4;
  const certificate = sourceText(equipment.certCode);
  const identifier = sourceText(equipment.id) || sourceText(equipment.equCode) || certificate;
  const operation = APPLY_TYPES[sourceText(application.applyType)] ?? '';
  const date = permitDate(application.decisionTime);
  const content = [sourceText(equipment.equKindValue), operation].filter(Boolean).join('');
  return {
    ...permitFields(REGISTER_CERTIFICATE, REGISTER_CERTIFICATE, '登记'),
    ...authority(application.grantGov, city),
    sourceRecordId: JSON.stringify([sourceText(application.businessId), identifier]),
    xkXdrMc: name, xkXdrLb: organization ? '法人及非法人组织' : name ? '自然人' : '',
    ...(organization ? { xkXdrShxym: identity, xkFrdb: sourceText(equipment.saPerson) || sourceText(application.legalRepresentative) }
      : { xkXdrZjlx: name ? '身份证' : '', xkXdrZjhm: identity }),
    xkJdrq: date, xkYxqz: date, xkYxqzi: '2099-12-31',
    xkWsh: certificate, xkXkbh: certificate, provincialDocumentNumber: documentNumber,
    xkNr: content, ajmc: content ? name + content : '',
  };
}

function personnelRow(application: EquipmentRow, detail: EquipmentRow, documents: EquipmentRow[], city: string): EquipmentRow {
  return {
    ...permitFields(PERSONNEL_MATTER, PERSONNEL_CERTIFICATE, '普通'),
    ...authority(application.acceptOrgName, city),
    sourceRecordId: sourceText(application.id),
    xkXdrMc: sourceText(application.name), xkXdrLb: '自然人', xkXdrZjlx: '身份证', xkXdrZjhm: sourceText(application.cardNo),
    ajmc: PERSONNEL_MATTER, xkNr: sourceText(application.operationItemValue), xkWsh: approvedDocument(documents),
    xkJdrq: permitDate(application.approvalTime), xkYxqz: permitDate(detail.effectiveDateStart), xkYxqzi: permitDate(detail.effectiveDateEnd),
  };
}

type EquipmentRead = Pick<SpecialEquipmentClient, 'apiCredentials' | 'assertSession' | 'applications'
  | 'equipment' | 'registrationDocuments' | 'personnelDetails' | 'personnelDocuments'>;

export async function querySpecialEquipment(client: EquipmentRead, kind: EquipmentReadKind, context: QueryContext): Promise<QueryPage> {
  const { filters, signal, onProgress } = context;
  const start = permitDate(filters.startDate), end = permitDate(filters.endDate);
  const city = sourceText(filters.city);
  if (!start || start !== filters.startDate || !end || end !== filters.endDate || start > end) {
    throw new AppError('QUERY_INVALID', '请选择有效的许可决定日期范围');
  }
  if (!EQUIPMENT_CITIES.some(option => option.value === city)) throw new AppError('QUERY_INVALID', '请选择查询地市');
  const firstDay = Date.parse(start), lastDay = Date.parse(end);
  const days = (lastDay - firstDay) / DAY + 1;
  if (days > 366) throw new AppError('QUERY_INVALID', '单次回流最多查询 366 天，请缩小日期范围');
  const revision = client.apiCredentials().revision;
  const found = new Map<string, EquipmentRow>();
  const add = (row: EquipmentRow) => {
    const key = String(row.sourceRecordId);
    const existing = found.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(row)) throw sourceFailure('同一特种设备记录内容不一致，请在原系统核对');
    found.set(key, row);
    if (found.size > 50_000) throw sourceFailure('特种设备记录超过 50000 条，请缩小日期范围');
  };
  // The original collector sends the same date in both source fields, one day at a time.
  for (let day = firstDay; day <= lastDay; day += DAY) {
    signal?.throwIfAborted();
    const date = new Date(day).toISOString().slice(0, 10);
    onProgress?.({ current: (day - firstDay) / DAY, total: days, message: `正在回流 ${date}，已获取 ${found.size} 条` });
    const applications = await client.applications(revision, kind, date, city, signal);
    for (const application of applications) {
      signal?.throwIfAborted();
      const decided = permitDate(kind === 'registration' ? application.decisionTime : application.approvalTime);
      if (decided && (decided < start || decided > end)) continue;
      if (kind === 'registration') {
        const equipment = await client.equipment(revision, application, signal);
        if (!equipment.length) throw sourceFailure('使用登记办件未返回关联设备，请在原系统核对后重试');
        const documents = await client.registrationDocuments(revision, application, signal);
        const document = approvedDocument(documents);
        for (const item of equipment) add(registrationRow(application, item, document, city));
      } else {
        const documents = await client.personnelDocuments(revision, application, signal);
        if (documents.some(document => /不准予行政许可决定书|不予行政许可决定书/.test(sourceText(document.fileName)))) continue;
        const details = await client.personnelDetails(revision, application, signal);
        add(personnelRow(application, details, documents, city));
      }
    }
  }
  client.assertSession(revision);
  return { rows: [...found.values()], total: found.size, page: 1, pageSize: context.pageSize };
}
