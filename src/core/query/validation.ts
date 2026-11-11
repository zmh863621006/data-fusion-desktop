import { AppError } from '../errors/app-error';
import type { QueryFieldSchema } from './types';

export function validateFilters(schema: QueryFieldSchema[], filters: Record<string, unknown>): void {
  const errors: string[] = [];
  const fields = new Map(schema.map((field) => [field.key, field]));

  for (const key of Object.keys(filters)) {
    if (!fields.has(key)) errors.push(`不支持的查询字段：${key}`);
  }

  for (const field of schema) {
    const value = filters[field.key];
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    if (field.required && empty) {
      errors.push(`${field.label}不能为空`);
      continue;
    }
    if (empty) continue;

    if (field.type === 'text' && (typeof value !== 'string' || value.length > 2_000)) {
      errors.push(`${field.label}必须为不超过2000字的文本`);
    }
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      errors.push(`${field.label}必须为数字`);
    }
    if (field.type === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
      errors.push(`${field.label}日期格式不正确`);
    }
    if ((field.type === 'multi-select' || field.type === 'date-range') && !Array.isArray(value)) {
      errors.push(`${field.label}格式不正确`);
    }
    if (field.type === 'date-range' && Array.isArray(value)) {
      if (value.length !== 2 || value.some((item) => item !== '' && (typeof item !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item)))) {
        errors.push(`${field.label}日期范围格式不正确`);
      } else if (value[0] && value[1] && String(value[0]) > String(value[1])) {
        errors.push(`${field.label}开始日期不能晚于结束日期`);
      }
    }
    if (field.type === 'select' && field.options && !field.options.some((option) => option.value === value)) {
      errors.push(`${field.label}选项无效`);
    }
    if (field.type === 'multi-select' && Array.isArray(value) && field.options) {
      if (value.length > 100 || value.some((item) => !field.options?.some((option) => option.value === item))) {
        errors.push(`${field.label}选项无效`);
      }
    }
  }

  if (errors.length) throw new AppError('QUERY_INVALID', errors.join('；'), { errors });
}
