import { AppError } from '../../core/errors/app-error';
import type { QueryContext, QueryPage } from '../../core/query/types';

export interface MarketAccessQueryTransport {
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
}

interface RemoteQueryResult {
  _data?: unknown;
  _paging?: {
    total?: string | number;
    pageNo?: string | number;
    pageSize?: string | number;
  };
}

interface RemoteQueryResponse {
  _error?: string;
  commonApplyList?: RemoteQueryResult;
}

const EMPTY_CONDITION = {
  applyno: '',
  subjectName: '',
  isVague: '1',
  opertype: '',
  curstepstate: '',
  linkman: '',
  curoper: '',
  regorg: '',
  appform: '',
  industryco: '',
  dom: '',
  uniscid: '',
  startappdate: '',
  endappdate: '',
  startaccdate: '',
  endaccdate: '',
  startapprdate: '',
  endapprdate: '',
  pastcuroper: '',
  cp: true,
  id: false,
  nmzyhzs: false,
  hzsfzzg: false,
  isDom: '0',
  state: '',
  enttypes: '',
  cerno: '',
  changeitem: '',
  catids: 'cp',
  namepermitflag: '',
  estmethodflag: '',
  idtocpdirflag: '',
  idtocpsetflag: '',
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function dateRange(value: unknown): [string, string] {
  if (!Array.isArray(value)) return ['', ''];
  return [text(value[0]), text(value[1])];
}

export function buildBusinessQueryPayload(context: QueryContext): Record<string, unknown> {
  const filters = context.filters;
  const applyDate = dateRange(filters.applyDate);
  const acceptDate = dateRange(filters.acceptDate);
  const approveDate = dateRange(filters.approveDate);
  const categories = Array.isArray(filters.subjectCategories)
    ? filters.subjectCategories.filter((value): value is string => typeof value === 'string')
    : [];
  const cp = categories.length === 0 || categories.includes('cp');
  const id = categories.includes('id');
  const nmzyhzs = categories.includes('nmzyhzs');
  const hzsfzzg = categories.includes('hzsfzzg');
  const catids = [cp ? 'cp' : '', id ? 'id' : ''].filter(Boolean).join(',');
  let enttypes = text(filters.enttypes);
  if (nmzyhzs && catids !== 'cp,id') enttypes = [enttypes, '9100'].filter(Boolean).join(',');
  if (hzsfzzg && catids !== 'cp,id') enttypes = [enttypes, '9200'].filter(Boolean).join(',');

  const condition = {
    ...EMPTY_CONDITION,
    applyno: text(filters.applyno),
    subjectName: text(filters.subjectName),
    isVague: text(filters.nameMatch) || '1',
    linkman: text(filters.linkman),
    curoper: text(filters.curoper),
    pastcuroper: text(filters.pastcuroper),
    cerno: text(filters.cerno),
    dom: text(filters.dom),
    uniscid: text(filters.uniscid),
    opertype: text(filters.opertype),
    state: text(filters.state),
    regorg: text(filters.regorg),
    appform: text(filters.appform),
    industryco: text(filters.industryco),
    changeitem: text(filters.changeitem),
    startappdate: applyDate[0],
    endappdate: applyDate[1],
    startaccdate: acceptDate[0],
    endaccdate: acceptDate[1],
    startapprdate: approveDate[0],
    endapprdate: approveDate[1],
    cp,
    id,
    nmzyhzs,
    hzsfzzg,
    catids,
    enttypes,
  };

  const meaningful = Object.entries(condition).some(([key, value]) => {
    if (['cp', 'id', 'nmzyhzs', 'hzsfzzg', 'catids', 'isVague', 'isDom'].includes(key)) return false;
    return value !== '' && value !== false;
  });
  if (!meaningful) throw new AppError('QUERY_INVALID', '请至少输入一个查询条件');

  return {
    commonApplyList: {
      _paging: {
        pageNo: String(context.page),
        pageSize: String(context.pageSize),
        total: '',
      },
      _condition: condition,
    },
  };
}

export async function queryBusinessApplications(
  transport: MarketAccessQueryTransport,
  context: QueryContext,
): Promise<QueryPage<Record<string, unknown>>> {
  const response = await transport.post<RemoteQueryResponse>(
    '/common/solrInfoQuery/getApplyProcessList.do',
    buildBusinessQueryPayload(context),
    context.signal,
  );
  if (response._error) throw new AppError('REMOTE_REQUEST_FAILED', response._error);
  const result = response.commonApplyList;
  if (!result || !Array.isArray(result._data)) {
    throw new AppError('REMOTE_REQUEST_FAILED', '市场准入系统返回的数据格式不正确');
  }
  const rows = result._data.filter(
    (row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row),
  );
  return {
    rows,
    page: Number(result._paging?.pageNo ?? context.page),
    pageSize: Number(result._paging?.pageSize ?? context.pageSize),
    total: Number(result._paging?.total ?? rows.length),
  };
}
