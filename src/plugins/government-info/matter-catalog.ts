export type GovernmentDepartmentId = 'water-affairs' | 'urban-management' | 'other';

export interface GovernmentMatterDefinition {
  id: string;
  name: string;
  sxType: string;
  departmentId: GovernmentDepartmentId;
  departmentName: string;
  departmentOrder: number;
  matterOrder: number;
  supportsDoublePublicityEnrichment: boolean;
  /** Verified neutral certificate fields only; does not imply complete double publicity. */
  supportsCertificateEnrichment?: boolean;
}

import catalog from './matter-catalog.json';
export const GOVERNMENT_MATTERS: readonly GovernmentMatterDefinition[] = catalog as readonly GovernmentMatterDefinition[];

export const GOVERNMENT_MATTER_BY_NAME = new Map(GOVERNMENT_MATTERS.map((matter) => [matter.name, matter]));
