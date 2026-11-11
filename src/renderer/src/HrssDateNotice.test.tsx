import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { HrssBatchDateNotice, HrssDateNotice } from './HrssDateNotice';
import { hrssDateFilter, hrssReturnDateDetails } from '../../core/hrss/date-filters';

it('labels selected dates as pending both before running and in a historical batch', () => {
  const notice = renderToStaticMarkup(<HrssDateNotice condition={hrssDateFilter('job-seeking-startup-subsidy')} />);
  expect(notice).toContain('日期筛选待接入'); expect(notice).toContain('仍按原列表条件回流'); expect(notice).toContain('role="status"');
  const batch = renderToStaticMarkup(<HrssBatchDateNotice details={hrssReturnDateDetails('job-seeking-startup-subsidy', { startDate: '2026-10-01', endDate: '2026-10-31' })} />);
  expect(batch).toContain('所选 2026-10-01 至 2026-10-31'); expect(batch).toContain('日期筛选待接入');
  expect(renderToStaticMarkup(<HrssBatchDateNotice />)).toBe('');
});
