export type SystemRecord = { id: string; name: string; version: string; enabled: number; created_at: number };
export type MatterRecord = { id: string; system_id: string; name: string; department_id?: string; department_name?: string; enabled: number; created_at: number };
export type AdminUser = { id: string; username: string; role: 'admin' | 'operator' | 'viewer'; enabled: number; created_at: number; lockedForSeconds?: number };
export type AdminSession = { id:string; ip_address:string; user_agent:string; created_at:number; last_seen_at:number; expires_at:number; current:number };
export type SecurityEvent = { id:string; event:string; username:string; ip_address:string; created_at:number };
export type CustomerRecord = { id: string; name: string; contact?: string; enabled: number; created_at: number };
export type LicenseRecord = {
  id: string; customer_id: string; customer_name: string; customer_enabled?: number; mode: 'online' | 'offline'; expires_at: number;
  allowed_systems_json: string; allowed_matters_json?: string; max_devices: number; allow_export: number;
  allowed_tools_json?: string;
  allow_auto_sync: number; allow_auto_update: number; status: string; created_at: number;
};
export type DeviceRecord = {
  id: string; license_id: string; customer_name: string; device_id: string; status: string;
  activated_at: number; last_seen_at: number;
};
export type UpdateRecord = {
  id: string; target_type: string; system_id?: string; version: string; url: string; sha256: string;
  notes?: string; published_at: number; enabled: number;
  bytes?: number | null; fileName?: string; managed?: boolean;
  status?: 'uploading' | 'draft' | 'published' | 'disabled';
  platform?: 'win32' | 'linux'; arch?: 'x64' | 'arm64'; variant?: 'standard' | 'kirin990'; installer?: 'nsis' | 'deb';
};
export type AuditRecord = { id: string; user_id: string; username: string; action: string; target_type?: string; target_id?: string; metadata_json?: string; created_at: number };
export type BootstrapData = {
  paginated?: boolean;
  summary?: { customers: number; activeLicenses: number; activeDevices: number; enabledSystems: number;
    systemLicenseCounts: Record<string, number>; recentLicenses: LicenseRecord[]; latestRelease: UpdateRecord | null };
  deployment?: 'huizhou-intranet' | 'standard';
  user?: { id: string; username: string; role: AdminUser['role']; passwordChangeRequired?:number };
  systems: SystemRecord[];
  tools: Array<{ id: string; name: string; version: string; description?: string }>;
  matters: MatterRecord[];
  customers: CustomerRecord[];
  licenses: LicenseRecord[];
  devices: DeviceRecord[];
  updates: UpdateRecord[];
  audits: AuditRecord[];
};
