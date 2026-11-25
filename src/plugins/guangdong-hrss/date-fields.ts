import { AppError } from '../../core/errors/app-error';
import { hrssDateBasis } from '../../core/hrss/date-filters';

/** Field pairs are taken from the corresponding source page's date controls. */
export function hrssListDateParameters(matterId: string, sourceId: string, startDate: string, endDate: string): Record<string, unknown> {
  if (matterId === 'poverty-alleviation-personnel') throw new AppError('QUERY_INVALID',
    '脱贫人员原站列表未提供日期条件，暂不能按日期回流；本次未发起列表查询');
  const basis = hrssDateBasis(matterId);
  if (!basis || matterId === 'unemployment') return {};
  if (basis.field === 'bae003') return { bae003: [`${startDate} 00:00:00`, `${endDate} 23:59:59`] };
  if (matterId === 'youth-internship-agreement' && sourceId === 'registration') return { bae062s: startDate, bae062e: endDate };
  if (matterId === 'youth-internship-agreement' || matterId === 'youth-internship-unit') return { cdc111Start: startDate, cdc111End: endDate };
  if (basis.field === 'cdc138') return { cdc138Begin: startDate, cdc138End: endDate };
  if (basis.field === 'adc705') return { adc705Begin: startDate, adc705End: endDate };
  return {};
}
