/** Canonical TLS entry; legacy HTTP client APIs remain server-side only for older installations. */
export const CLOUD_BACKEND_ORIGIN = 'https://193.112.96.168';
export function backendConfiguration(environment: Record<string, string | undefined> = {}) {
  return {
    origin: CLOUD_BACKEND_ORIGIN,
    activationUrl: environment.DATA_FUSION_ACTIVATION_URL ?? `${CLOUD_BACKEND_ORIGIN}/api/activate`,
    statusUrl: environment.DATA_FUSION_LICENSE_STATUS_URL ?? `${CLOUD_BACKEND_ORIGIN}/api/license/status`,
    updateUrl: environment.DATA_FUSION_UPDATE_URL ?? `${CLOUD_BACKEND_ORIGIN}/api/updates/manifest`,
    enterpriseUrl: environment.DATA_FUSION_ENTERPRISE_URL ?? `${CLOUD_BACKEND_ORIGIN}/api/enterprises/resolve`,
    insecureHttpOrigin: environment.DATA_FUSION_ALLOW_INSECURE_HTTP_ORIGIN,
  };
}
