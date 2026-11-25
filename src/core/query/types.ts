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
  /** Date range was applied, but the source did not provide a usable date for these records. */
  undatedExcludedCount?: number;
  /** Requests skipped after exhausting timeout retries; returned rows may omit those pages/cases. */
  skippedRequestCount?: number;
}

export interface QueryContext {
  page: number;
  pageSize: number;
  filters: Record<string, unknown>;
  /** Main-process cancellation signal; never supplied by Renderer input. */
  signal?: AbortSignal;
  /** Main-process progress hook, excluded from renderer input. */
  onProgress?(progress: { current: number; total?: number; message?: string }): void;
}

export interface BusinessMatter<T = Record<string, unknown>> {
  id: string;
  name: string;
  /** Optional second-level navigation grouping inside a business system. */
  departmentId?: string;
  departmentName?: string;
  departmentOrder?: number;
  matterOrder?: number;
  description?: string;
  /** Public list field allowlist. Values outside this schema never enter a list ledger UI. */
  listColumns?: readonly { key: string; label: string; sensitive?: boolean }[];
  querySchema: QueryFieldSchema[];
  /** Whether the visible date controls already constrain the remote query. */
  dateFilter?: { mode: 'applied' | 'pending'; message: string };
  /** One-click matters hide query controls and execute with business-defined defaults. */
  executionMode?: 'interactive-query' | 'one-click-return';
  /** A catalogued matter can be browsed before its remote query is available. */
  queryAvailable?: false;
  createDefaultContext?(): QueryContext;

  /** Fields that uniquely identify one business record locally. */
  uniqueKey: string[];

  /** Optional matter-specific merge, applied before local diffing and snapshot creation. */
  mergeRecord?(incoming: T, previous: T): T;

  query(context: QueryContext): Promise<QueryPage<T>>;
  getDetail?(record: T): Promise<Record<string, unknown>>;
}
