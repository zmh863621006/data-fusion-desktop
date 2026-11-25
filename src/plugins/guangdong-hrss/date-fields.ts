import { hrssDateBasis } from '../../core/hrss/date-filters';

/** Field pairs are taken from the corresponding source page's date controls. */
export function hrssListDateParameters(matterId: string, sourceId: string, startDate: string, endDate: string): Record<string, unknown> {
  // The user authorized the original list scope until the source exposes a verified date filter.
  if (matterId === 'poverty-alleviation-personnel') return {};
  const basis = hrssDateBasis(matterId);
  if (!basis || matterId === 'unemployment') return {};
  if (basis.field === 'bae003') return { bae003: [`${startDate} 00:00:00`, `${endDate} 23:59:59`] };
  if (matterId === 'youth-internship-agreement' && sourceId === 'registration') return { bae062s: startDate, bae062e: endDate };
  if (matterId === 'youth-internship-agreement' || matterId === 'youth-internship-unit') return { cdc111Start: startDate, cdc111End: endDate };
  if (basis.field === 'cdc138') return { cdc138Begin: startDate, cdc138End: endDate };
  if (basis.field === 'adc705') return { adc705Begin: startDate, adc705End: endDate };
  return {};
}
