import { expect, it, vi } from 'vitest';
import { createFoodDrugPlugin } from './index';
import { FOOD_DRUG_HOME, FOOD_DRUG_LICENSES, FOOD_DRUG_ORIGIN } from './catalog';

vi.mock('electron', () => ({ session: {} }));

const day = '2026-11-22';
const context = { page: 1, pageSize: 50, filters: { startDate: day, endDate: day } };
const result = (value: unknown) => Response.json({ result: value });

it.each(FOOD_DRUG_LICENSES)('paginates $name and resolves details using each actual source ID', async (matter) => {
  const requests: string[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const target = new URL(url);
    expect(target.origin).toBe(FOOD_DRUG_ORIGIN);
    expect(init).toMatchObject({ credentials: 'include', redirect: 'manual' });
    expect(new Headers(init.headers).has('cookie')).toBe(false);
    const input = new URLSearchParams(init.body as URLSearchParams | undefined);
    if (target.pathname.endsWith('/query/getData.action')) {
      const page = input.get('pageNumber');
      requests.push('list:' + page);
      expect(JSON.parse(input.get('queryJson')!)).toMatchObject({
        pageNumber: page, pageSize: '50',
        criteriaValueMap: { ITEM_TYPE: matter.itemType, SFBJ: '1', ISAGREE: '1', ISQUERY: '1', LCJSSJ: day, LCJSSJ_v0: day },
      });
      return result({ totalCount: '2', data: { rows: [{ ID: 'case-' + page, LCJSSJ: day + ' 15:20:00', BUSINESS_NAME: matter.name + '变更' }] } });
    }
    if (target.pathname.endsWith('tab_dsxk_wsxx.jsp')) {
      const id = target.searchParams.get('business_record_id');
      requests.push('tab:' + id);
      expect(target.searchParams.get('process_definition_name')).toBe(matter.workflow);
      expect(target.searchParams.get('node_name')).toBe('%B0%EC%BD%E1');
      return new Response(`<script>var xkzDetailId = "certificate-${id}";</script>`);
    }
    expect(target.pathname).toBe('/dsxk/form/loadForm.action');
    const entry = input.get('formEntryId');
    const id = input.get('detailId');
    const req = JSON.parse(target.searchParams.get('REQUEST_HIDDEN_PARAMS')!);
    expect(input.get('reqParam[business_record_id]')).toBe(req.business_record_id);
    expect(req.process_definition_name).toBe(matter.workflow);
    expect(input.get('actionType')).toBe('view');
    if (entry === 'form_b_dsxk_admin_accept') {
      expect(id).toBe(req.business_record_id);
      requests.push('accept:' + id);
      return result(JSON.stringify({ QYMC: '测试企业', FDDBR: '测试法人', SHXYDM: '91440300123456789Q',
        BUSINESS_NAME: '测试决定文书', ITEM_NAME: matter.name, SLH: '受理号-' + id, SLQJ_DETAIL: '惠东县' }));
    }
    expect(entry).toBe(matter.certificateForm);
    expect(id).toBe('certificate-' + req.business_record_id);
    requests.push('cert:' + id);
    return result({ FZRQ: day, XKZBH: '测试许可-' + id, YXQJSRQ: '2029-09-01', XKZYXJZRQ: '2030/10/2' });
  });
  const plugin = createFoodDrugPlugin({ fetcher, minimumIntervalMs: 0 });
  const page = await plugin.matters.find(item => item.id === matter.id)!.query(context);
  expect(requests).toEqual(['list:1', 'list:2', 'accept:case-1', 'tab:case-1', 'cert:certificate-case-1',
    'accept:case-2', 'tab:case-2', 'cert:certificate-case-2']);
  expect(page.total).toBe(2);
  expect(page.rows[0]).toMatchObject({ sourceRecordId: 'case-1', xkWsh: '受理号-case-1', xkXkbh: '测试许可-certificate-case-1',
    xkXkzs: matter.name, xkJdrq: day, xkYxqz: day, xkYxqzi: matter.expiry === 'YXQJSRQ' ? '2029-09-01' : '2030-10-02',
    xkXkjg: '惠州市市场监督管理局', xkLydw: '惠东县市场监督管理局' });
});

it('validates cookies via a limited query and distinguishes SSO from unavailable access', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(new URLSearchParams(init.body as URLSearchParams).get('pageSize')).toBe('1');
    return result({ totalCount: 0 });
  });
  const plugin = createFoodDrugPlugin({ fetcher, minimumIntervalMs: 0, now: () => Date.parse('2026-11-22T16:05:00Z') });
  const login = new URL(plugin.loginPage!.url);
  expect(login.origin).toBe(FOOD_DRUG_ORIGIN);
  expect(login.pathname).toBe('/sso/login');
  expect(login.searchParams.get('service')).toBe(FOOD_DRUG_HOME);
  expect(plugin.matters[0].createDefaultContext!().filters).toEqual({ startDate: day, endDate: day });
  plugin.loginPage!.onLoginPageChange!(true);
  expect((await plugin.getSessionState()).status).toBe('expired');
  expect(fetcher).not.toHaveBeenCalled();
  plugin.loginPage!.onLoginPageChange!(false);
  expect((await plugin.getSessionState()).status).toBe('authenticated');
  fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/sso/login' } }));
  expect((await plugin.getSessionState()).status).toBe('expired');
  fetcher.mockResolvedValueOnce(new Response('<html><input name="execution"><input name="_eventId"></html>'));
  expect((await plugin.getSessionState()).status).toBe('expired');
  fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
  expect((await plugin.getSessionState()).status).toBe('unverified');
});

it('rejects duplicate pages before querying details and rejects invalid dates before sending requests', async () => {
  const fetcher = vi.fn(async () => result({ totalCount: 2, data: { rows: [{ ID: 'repeated', LCJSSJ: day }] } }));
  const matter = createFoodDrugPlugin({ fetcher, minimumIntervalMs: 0 }).matters[0];
  await expect(matter.query({ ...context, filters: { startDate: '2026-02-30', endDate: day } })).rejects.toMatchObject({ code: 'QUERY_INVALID' });
  expect(fetcher).not.toHaveBeenCalled();
  await expect(matter.query(context)).rejects.toThrow('分页重复');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
