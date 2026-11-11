export type OperationalLogLevel = 'info' | 'warn' | 'error';

export interface OperationalLogEntry {
  timestamp: number;
  level: OperationalLogLevel;
  source: string;
  message: string;
}

export interface OperationalLogQuery {
  limit?: number;
  level?: OperationalLogLevel | 'all';
  keyword?: string;
}
