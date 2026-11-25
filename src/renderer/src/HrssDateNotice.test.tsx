import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { HrssBatchDateNotice, HrssDateNotice } from './HrssDateNotice';
import { hrssDateFilter, hrssReturnDateDetails } from '../../core/hrss/date-filters';

it('states verified dates while hiding notices for the authorized poverty original-list scope', () => {
  const notice = renderToStaticMarkup(<HrssDateNotice condition={hrssDateFilter('job-seeking-startup-subsidy')} />);
  expect(notice).toContain('日期筛选已生效'); expect(notice).toContain('按所选申请日期'); expect(notice).toContain('role="status"');
  const mixed = renderToStaticMarkup(<HrssDateNotice condition={hrssDateFilter('youth-internship-agreement')} />);
  expect(mixed).toContain('查询列表按见习开始日期');
  const batch = renderToStaticMarkup(<HrssBatchDateNotice details={hrssReturnDateDetails('poverty-alleviation-personnel', { startDate: '2026-10-01', endDate: '2026-10-31' })} />);
  expect(renderToStaticMarkup(<HrssDateNotice condition={hrssDateFilter('poverty-alleviation-personnel')} />)).toBe('');
  expect(batch).toBe('');
  const expansion = renderToStaticMarkup(<HrssDateNotice condition={hrssDateFilter('one-time-job-expansion-subsidy')} />);
  expect(expansion).toContain('日期筛选待接入');
  expect(renderToStaticMarkup(<HrssBatchDateNotice />)).toBe('');
});
