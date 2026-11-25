import type { BusinessMatter } from '../../core/query/types';
import { hrssTaskDateLabel } from '../../core/hrss/date-filters';

export function HrssDateNotice({ condition }: { condition: NonNullable<BusinessMatter['dateFilter']> }) {
  if (!condition.message) return null;
  return <div id="hrss-date-condition-note" className={`hrss-date-condition ${condition.mode}`} role="status">
    <strong>{condition.mode === 'pending' ? '日期筛选待接入' : '日期筛选已生效'}</strong><span>{condition.message}</span>
  </div>;
}

export function HrssBatchDateNotice({ details }: { details?: Record<string, unknown> }) {
  if (details?.dateFilterStatus !== 'pending' || details.dateScope === 'original-list-no-date') return null;
  return <div className="hrss-date-condition pending" role="status"><strong>日期筛选待接入</strong><span>{hrssTaskDateLabel(details)}</span></div>;
}
