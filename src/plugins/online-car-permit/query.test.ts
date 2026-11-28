import { describe, expect, it } from 'vitest';
import { mapOnlineCarPermit, queryOnlineCarPermits } from './query';
import { enterpriseInput, applyEnterpriseResult } from '../../core/enterprise/service';

describe('online car permit return', () => {
  it('recognizes service centres and sole traders by verified credit code and enriches their missing legal person', () => {
    const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY';
    const prefix = '92440300123456789';
    const sum = [1,3,9,27,19,26,16,17,20,29,25,13,8,24,10,30,28].reduce((total, weight, i) => total + alphabet.indexOf(prefix[i]) * weight, 0);
    const individualCode = prefix + alphabet[(31 - sum % 31) % 31];
    for (const [companyId, category] of [['91440300123456789Q', '法人及非法人组织'], [individualCode, '个体工商户']]) {
      const row = mapOnlineCarPermit({ companyName: '深圳市测试汽车服务中心', companyId });
      expect(row).toMatchObject({ xkXdrLb: category, xkXdrShxym: companyId, xkXdrZjhm: '', xkXdrZjlx: '' });
      const input = enterpriseInput('online-car-permit', row)!;
      expect(input).toEqual({ name: '深圳市测试汽车服务中心', creditCode: companyId, applicantCode: '' });
      const filled = applyEnterpriseResult('online-car-permit', row, input, { requestId: 'fixture', status: 'success', reason: '',
        enterprise: { id: 'fixture', name: input.name, creditCode: companyId, legalPerson: '测试法人', source: 'test', updatedAt: 1 } });
      expect(filled).toMatchObject({ xkXdrLb: category, xkFrdb: '测试法人' });
    }
  });
  it('keeps individual identity documents out of enterprise lookup and uses names only as a fallback', () => {
    const person = mapOnlineCarPermit({ companyName: '测试人员', companyId: '11010519491231002X' });
    expect(person).toMatchObject({ xkXdrLb: '自然人', xkXdrShxym: '', xkXdrZjhm: '11010519491231002X', xkXdrZjlx: '身份证' });
    expect(enterpriseInput('online-car-permit', person)).toBeNull();
    const centre = mapOnlineCarPermit({ companyName: '测试汽车服务中心', companyId: '' });
    expect(enterpriseInput('online-car-permit', centre)).toEqual({ name: '测试汽车服务中心', creditCode: '', applicantCode: '' });
  });
  it('maps a vehicle permit to the original double-publicity template', () => {
    const value = mapOnlineCarPermit({
      id: '1', companyName: '惠州测试运输有限公司', companyId: '91441300TEST', certificate: '粤交运管许可惠字001号',
      createTime: '2026-09-18', cardbegindate: '2026-09-18', cardenddate: '2034-09-17',
    });
    expect(value).toMatchObject({
      xzxkmc: '网络预约出租汽车运输证许可', xkXdrMc: '惠州测试运输有限公司',
      xkXdrLb: '法人及非法人组织', xkXdrShxym: '91441300TEST', xkWsh: '粤交运管许可惠字001号',
      xkJdrq: '2026-09-18', xkXkjg: '惠州市交通运输局',
    });
  });

  it('queries the user-selected date range', async () => {
    const calls: string[][] = [];
    const result = await queryOnlineCarPermits({ fetchRecords: async (start, end) => { calls.push([start, end]); return []; } }, {
      page: 1, pageSize: 50, filters: { startDate: '2026-09-14', endDate: '2026-09-18' },
    });
    expect(calls).toEqual([['2026-09-14', '2026-09-18']]);
    expect(result.total).toBe(0);
  });
});
