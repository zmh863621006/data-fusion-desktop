import { describe, expect, it } from 'vitest';
import { mapOnlineCarPermit, queryOnlineCarPermits } from './query';

describe('online car permit return', () => {
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
