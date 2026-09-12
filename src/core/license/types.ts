export interface LicenseGrant {
  licenseId: string;
  expiresAt: number;
  allowedSystems: string[];
  allowedMatters?: Record<string, string[]>;
  maxDevices?: number;
  allowExport?: boolean;
  allowAutoSync?: boolean;
}

export interface LicenseService {
  activate(key: string): Promise<LicenseGrant>;
  getCurrent(): Promise<LicenseGrant | null>;
  validate(): Promise<boolean>;
}
