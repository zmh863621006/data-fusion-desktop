import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { HrssBatchDateNotice, HrssDateNotice } from './HrssDateNotice';
import { hrssDateFilter, hrssReturnDateDetails } from '../../core/hrss/date-filters';

it('states the verified date basis before running and explains the blocked poverty query', () => {
  const notice = renderToStaticMarkup(<HrssDateNotice condition={hrssDateFilter('job-seeking-startup-subsidy')} />);
  expect(notice).toContain('日期筛选已生效'); expect(notice).toContain('按所选申请日期'); expect(notice).toContain('role="status"');
  const mixed = renderToStaticMarkup(<HrssDateNotice condition={hrssDateFilter('youth-internship-agreement')} />);
  expect(mixed).toContain('查询列表按见习开始日期');
  const batch = renderToStaticMarkup(<HrssBatchDateNotice details={hrssReturnDateDetails('poverty-alleviation-personnel', { startDate: '2026-10-01', endDate: '2026-10-31' })} />);
  expect(batch).toContain('所选 2026-10-01 至 2026-10-31'); expect(batch).toContain('已暂停回流');
  expect(renderToStaticMarkup(<HrssBatchDateNotice />)).toBe('');
});
