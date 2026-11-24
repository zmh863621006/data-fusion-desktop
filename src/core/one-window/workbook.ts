import ExcelJS from 'exceljs';

export interface OneWindowWorkbookOptions {
  businessName?: string;
  batchId?: string;
  collectedAt?: number;
  startDate?: string;
  endDate?: string;
}

const CELL_TEXT_LIMIT = 30_000;
const MAX_SHEET_ROWS = 1_048_576;
const SECRET_KEY = /^(?:access[-_]?token|refresh[-_]?token|authorization|cookies?|session[-_]?id|password|pwd|plainpass|pdata|securitytoken|x-oss-security-token)$/i;
const SECRET_QUERY = /^(?:access[-_]?token|refresh[-_]?token|authorization|session[-_]?id|password|pwd|signature|ossaccesskeyid|securitytoken|x-oss-.+)$/i;

const SUMMARY_COLUMNS = [
  ['bsnum', '申办流水号'], ['receiveNumber', '受理编号'], ['matterName', '业务事项'], ['applicant', '申请主体'],
  ['applicantId', '申请主体证件编号'], ['creditCode', '统一社会信用代码'], ['legalPerson', '法定代表人'],
  ['organizationName', '办理部门'], ['statusLabel', '办理状态'], ['receivedAt', '接收／受理时间'],
  ['submittedAt', '提交时间'], ['finishedAt', '办结时间'], ['collectedAt', '采集时间'], ['detailStatus', '详情采集状态'],
] as const;

const SECTION_NAMES: Record<string, string> = {
  identifiers: '关联编号', base: '主体基本信息', item: '事项信息', opinions: '办理意见', form: '电子表单',
  materials: '申请材料', files: '受理文件', licenses: '证照目录', processFiles: '过程文件', printFiles: '打印文件',
  delivery: '送达信息', ems: '邮寄信息', businessFlow: '办理流程', serviceList: '办理服务',
};

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY.test(key)) { url.searchParams.delete(key); changed = true; }
    }
    if (url.username || url.password) { url.username = ''; url.password = ''; changed = true; }
    return changed ? url.href : value;
  } catch { return value; }
}

/** Retains JSON business data while excluding credentials from the exported workbook. */
function businessData(value: unknown, parents = new Set<object>()): unknown {
  if (typeof value === 'string') return safeUrl(value);
  if (!value || typeof value !== 'object') return value;
  if (parents.has(value)) throw new Error('办件详情包含循环数据，无法生成表格');
  if (parents.size > 100) throw new Error('办件详情层级过深，无法生成表格');
  parents.add(value);
  const result = Array.isArray(value)
    ? value.map(item => businessData(item, parents))
    : Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key)).map(([key, item]) => [key, businessData(item, parents)]));
  parents.delete(value);
  return result;
}

function chunks(value: string): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + CELL_TEXT_LIMIT);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    result.push(value.slice(offset, end));
    offset = end;
  }
  return result.length ? result : [''];
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function displayed(value: unknown): string {
  const valueText = text(value);
  return valueText.length > CELL_TEXT_LIMIT ? valueText.slice(0, CELL_TEXT_LIMIT - 16) + '…（完整值见详情）' : valueText;
}

function sheetStyle(sheet: ExcelJS.Worksheet, headers: readonly string[], widths?: number[]) {
  sheet.columns = headers.map((header, index) => ({ header, width: widths?.[index] ?? 22 }));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.getRow(1).height = 28;
  sheet.getRow(1).font = { name: '微软雅黑', bold: true, color: { argb: 'FF1D1D1F' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F3F7' } };
  sheet.getRow(1).alignment = { vertical: 'middle' };
}

class WorkbookRows {
  private current: ExcelJS.Worksheet;
  private sequence = 1;

  constructor(private readonly workbook: ExcelJS.Workbook, private readonly name: string,
    private readonly headers: readonly string[], private readonly widths?: number[]) {
    this.current = workbook.addWorksheet(name);
    sheetStyle(this.current, headers, widths);
  }

  add(values: unknown[]) {
    if (this.current.rowCount >= MAX_SHEET_ROWS) {
      this.finishSheet();
      this.current = this.workbook.addWorksheet(this.name + '-' + ++this.sequence);
      sheetStyle(this.current, this.headers, this.widths);
    }
    // Plain string values remain Excel text even when they start with '=' or '+'.
    const row = this.current.addRow(values);
    row.alignment = { vertical: 'top', wrapText: true };
  }

  private finishSheet() {
    this.current.autoFilter = { from: { row: 1, column: 1 }, to: { row: this.current.rowCount, column: this.headers.length } };
  }

  finish() { this.finishSheet(); }
}

function pointerPart(value: string): string { return value.replace(/~/g, '~0').replace(/\//g, '~1'); }

/** Every scalar and empty container has a path and explicit type. Large values span numbered rows. */
function fieldRows(rows: WorkbookRows, bsnum: string, section: string, path: string, value: unknown, label = '') {
  if (value && typeof value === 'object' && Object.keys(value).length) {
    for (const [key, item] of Object.entries(value)) fieldRows(rows, bsnum, section, path + '/' + pointerPart(key), item, label);
    return;
  }
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const pieces = chunks(text(value));
  pieces.forEach((piece, index) => rows.add([bsnum, section, path, label, type, index + 1, pieces.length, piece]));
}

function sectionData(section: unknown): unknown {
  return object(section) && 'status' in section && 'data' in section ? section.data : section;
}

function day(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value ? value : undefined;
}

function fileSegment(value: string, max: number): string {
  return [...value.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')].slice(0, max).join('');
}

export function oneWindowWorkbookFilename(options: OneWindowWorkbookOptions = {}): string {
  const start = day(options.startDate), end = day(options.endDate);
  const period = start && end ? `${start}至${end}` : start ? `${start}起` : end ? `截至${end}` : '全部办件';
  const business = fileSegment(options.businessName ?? '一窗受理平台', 60) || '一窗受理平台';
  const batch = options.batchId ? '-' + fileSegment(options.batchId, 48) : '';
  return `业务详情-${business}-${period}${batch}.xlsx`;
}

/** Exports structured business details and a chunked JSON copy that can be reconstructed exactly. */
export async function createOneWindowWorkbook(records: readonly object[], options: OneWindowWorkbookOptions = {}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '数据融合助手';
  const generatedAt = options.collectedAt ?? Date.now();
  if (!Number.isFinite(generatedAt) || !Number.isFinite(new Date(generatedAt).getTime())) throw new Error('回流批次时间无效');
  workbook.created = new Date(generatedAt);
  workbook.modified = new Date(generatedAt);
  const summary = new WorkbookRows(workbook, '办件总览', SUMMARY_COLUMNS.map(([, label]) => label));
  const sections = new WorkbookRows(workbook, '详情采集情况', ['申办流水号', '详情分组', '采集状态', '说明']);
  const fields = new WorkbookRows(workbook, '完整业务字段', ['申办流水号', '详情分组', '字段路径', '字段名称', '值类型', '分段序号', '分段总数', '字段值'], [28, 20, 52, 26, 14, 12, 12, 64]);
  const specifications = new WorkbookRows(workbook, '广告规格', ['申办流水号', '序号', '广告形式', '其他形式', '广告材质', '其他材质', '长度', '宽度', '厚度', '下沿距地高度']);
  const complete = new WorkbookRows(workbook, '完整数据JSON', ['申办流水号', '记录序号', '分段序号', '分段总数', 'JSON内容'], [28, 14, 14, 14, 100]);
  for (const [index, input] of records.entries()) {
    if (!object(input)) throw new Error('办件详情格式无效');
    const record = businessData(input) as Record<string, unknown>;
    const bsnum = text(record.bsnum);
    if (!bsnum.trim()) throw new Error('办件详情缺少申办流水号');
    summary.add(SUMMARY_COLUMNS.map(([key]) => key === 'detailStatus'
      ? record[key] === 'complete' ? '完整' : '部分详情待补充'
      : displayed(record[key])));
    const details = object(record.details) ? record.details : {};
    const form = sectionData(details.form);
    const formData = object(form) && object(form.data) ? form.data : {};
    const formFields = object(form) && Array.isArray(form.fields) ? form.fields : [];
    const labels = new Map(formFields.filter(object).map(field => [text(field.key), text(field.label)]));
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'details') { fieldRows(fields, bsnum, key === 'sourceList' ? '原系统列表' : '办件摘要', '/' + pointerPart(key), value); continue; }
      for (const [section, data] of Object.entries(details)) {
        const name = SECTION_NAMES[section] ?? section;
        if (object(data) && typeof data.status === 'string') {
          sections.add([bsnum, name, data.status === 'complete' ? '已采集' : data.status === 'absent' ? '原系统无数据' : '采集失败', displayed(data.message)]);
        }
        if (section === 'form' && object(form)) {
          const { data: values, ...metadata } = form;
          fieldRows(fields, bsnum, name, '/details/form', metadata);
          for (const [field, value] of Object.entries(formData)) {
            fieldRows(fields, bsnum, name, '/details/form/data/' + pointerPart(field), value, labels.get(field));
          }
        } else fieldRows(fields, bsnum, name, '/details/' + pointerPart(section), data);
      }
    }
    const displayData = object(form) && object(form.displayData) ? form.displayData : formData;
    const adverts = displayData.XingShiCaiZhiJiGuiGe;
    if (Array.isArray(adverts)) {
      adverts.forEach((advert, rowIndex) => {
        if (object(advert)) specifications.add([bsnum, rowIndex + 1, ...Array.from({ length: 8 }, (_, column) => displayed(advert['code' + column]))]);
      });
    }
    const json = JSON.stringify(record);
    const pieces = chunks(json);
    pieces.forEach((piece, part) => complete.add([bsnum, index + 1, part + 1, pieces.length, piece]));
  }
  for (const rows of [summary, sections, fields, specifications, complete]) rows.finish();
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
