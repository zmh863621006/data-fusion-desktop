import { AppError } from '../errors/app-error';
import type { QueryFieldSchema } from './types';

export function validateFilters(schema: QueryFieldSchema[], filters: Record<string, unknown>): void {
  const errors: string[] = [];

  for (const field of schema) {
    const value = filters[field.key];
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    if (field.required && empty) {
      errors.push(`${field.label}不能为空`);
      continue;
    }
    if (empty) continue;

    if (field.type === 'number' && typeof value !== 'number') errors.push(`${field.label}必须为数字`);
    if ((field.type === 'multi-select' || field.type === 'date-range') && !Array.isArray(value)) {
      errors.push(`${field.label}格式不正确`);
    }
    if (field.type === 'select' && field.options && !field.options.some((option) => option.value === value)) {
      errors.push(`${field.label}选项无效`);
    }
  }

  if (errors.length) throw new AppError('QUERY_INVALID', errors.join('；'), { errors });
}
