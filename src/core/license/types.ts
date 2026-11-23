export interface LicenseGrant {
  licenseId: string;
  activationMode?: 'online' | 'offline';
  customerId?: string;
  customerName?: string;
  issuedAt?: number;
  notBefore?: number;
  expiresAt: number;
  allowedSystems: string[];
  allowedTools?: string[];
  allowedMatters?: Record<string, string[]>;
  maxDevices?: number;
  deviceId?: string;
  allowExport?: boolean;
  allowAutoSync?: boolean;
  allowAutoUpdate?: boolean;
}

export type LicenseState = 'missing' | 'active' | 'expired' | 'invalid';
export type LicenseIdentity = Pick<LicenseGrant, 'licenseId' | 'customerName' | 'activationMode' | 'expiresAt'>;

export interface LicenseStatus {
  state: LicenseState;
  grant?: LicenseGrant;
  /** Verified identification fields for an expired or revoked grant. */
  identity?: LicenseIdentity;
  deviceId: string;
  message?: string;
  development?: boolean;
}

export interface LicenseService {
  activate(key: string): Promise<LicenseGrant>;
  getCurrent(): Promise<LicenseGrant | null>;
  validate(): Promise<boolean>;
  getStatus(): Promise<LicenseStatus>;
  deactivate(): Promise<void>;
  refreshOnline?(): Promise<LicenseGrant | null>;
}
