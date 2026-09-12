import type { QueryFieldSchema, QueryPage } from '../query/types';
import type { SessionStatus } from '../session/types';

export interface SystemSummaryDto {
  id: string;
  name: string;
  version: string;
  description?: string;
  session: {
    status: SessionStatus;
    expiresAt?: number;
    displayName?: string;
  };
}

export interface MatterSummaryDto {
  id: string;
  name: string;
  description?: string;
  querySchema: QueryFieldSchema[];
  uniqueKey: string[];
}

export interface MatterQueryRequestDto {
  systemId: string;
  matterId: string;
  page: number;
  pageSize: number;
  filters: Record<string, unknown>;
}

export type MatterQueryResponseDto = QueryPage<Record<string, unknown>>;

export interface SyncPreviewDto {
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
}
