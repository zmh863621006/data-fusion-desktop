export interface OneWindowDetailSection {
  status: 'complete' | 'absent' | 'failed';
  data: unknown;
  message?: string;
}

export interface OneWindowField {
  key: string;
  label: string;
  options?: Array<{ value: string; label: string }>;
}

export interface OneWindowHtmlData {
  fields: Array<{ key: string; label: string; value: string }>;
  tables: string[][][];
  text: string;
}

export interface OneWindowFormData {
  name: string;
  version: string;
  data: Record<string, unknown>;
  fields: OneWindowField[];
  metadata: Record<string, unknown>;
  displayData: Record<string, unknown>;
  schema: unknown;
}

export interface OneWindowRecord extends Record<string, unknown> {
  bsnum: string;
  receiveNumber: string;
  matterName: string;
  applicant: string;
  applicantId: string;
  organizationName: string;
  status: string;
  statusLabel: string;
  receivedAt: string;
  submittedAt: string;
  finishedAt: string;
  creditCode: string;
  legalPerson: string;
  collectedAt: number;
  detailStatus: 'complete' | 'partial';
  detailFailures: string[];
  sourceList: Record<string, unknown>;
  details: Record<string, OneWindowDetailSection>;
}
