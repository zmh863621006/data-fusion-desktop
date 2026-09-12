export type AuditEventType =
  | 'license.activated'
  | 'system.login'
  | 'system.logout'
  | 'query.started'
  | 'query.completed'
  | 'query.failed'
  | 'sync.previewed'
  | 'sync.committed'
  | 'export.created'
  | 'plugin.updated';

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  systemId?: string;
  matterId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
  list(limit?: number): Promise<AuditEvent[]>;
}
