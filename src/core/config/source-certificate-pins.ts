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
