/**
 * Public certificate identity, explicitly approved by the user on 2026-11-04.
 * Updates require a reviewed source change; no remote response can extend this trust list.
 */
export const HRSS_SOURCE_CERTIFICATE_TRUST = {
  partition: 'persist:guangdong-hrss',
  origin: 'https://hrss.gdgov.cn',
  trustedFingerprints: [
    '99:A4:5E:36:EF:E5:CE:EA:37:77:76:CB:D3:AE:1E:3C:67:40:3E:A3:98:26:0B:D6:73:20:B7:BD:08:13:AF:6F',
  ],
  unknownCertificate: 'reject',
} as const;

/**
 * The user-provided Shenzhen portal is addressed by IP, but its government
 * certificate covers sz.gov.cn. Reviewed against the public CA chain and DNS SAN
 * on 2026-11-27. A changed certificate requires another reviewed source update.
 */
export const SHENZHEN_INTEGRATED_SOURCE_CERTIFICATE_TRUST = {
  systemId: 'shenzhen-integrated-services',
  partition: 'persist:shenzhen-integrated-services',
  origin: 'https://61.144.226.148:8001',
  certificateHostname: 'sz.gov.cn',
  fingerprint256: 'FC:8E:CF:8F:96:4F:63:01:62:99:FC:DC:0D:8B:E0:4D:FD:6D:93:C0:F1:3D:91:73:DC:3B:B8:10:25:B4:21:46',
} as const;
