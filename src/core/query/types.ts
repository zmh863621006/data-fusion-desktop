export type QueryFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'date-range'
  | 'select'
  | 'multi-select';

export interface QueryOption {
  label: string;
  value: string | number;
}

export interface QueryFieldSchema {
  key: string;
  label: string;
  type: QueryFieldType;
  required?: boolean;
  placeholder?: string;
  options?: QueryOption[];
  defaultValue?: unknown;
}

export interface QueryPage<T = Record<string, unknown>> {
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface QueryContext {
  page: number;
  pageSize: number;
  filters: Record<string, unknown>;
}

export interface BusinessMatter<T = Record<string, unknown>> {
  id: string;
  name: string;
  description?: string;
  querySchema: QueryFieldSchema[];

  /** Fields that uniquely identify one business record locally. */
  uniqueKey: string[];

  query(context: QueryContext): Promise<QueryPage<T>>;
  getDetail?(record: T): Promise<Record<string, unknown>>;
}
