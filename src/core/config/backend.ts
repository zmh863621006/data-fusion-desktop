/** Canonical TLS entry; legacy HTTP client APIs remain server-side only for older installations. */
export const CLOUD_BACKEND_ORIGIN = 'https://193.112.96.168';
export function backendConfiguration(environment: Record<string, string | undefined> = {}, managed?: { origin: string; revision: number }) {
  let origin = CLOUD_BACKEND_ORIGIN;
  if (managed) {
    const candidate = new URL(managed.origin);
    if (candidate.protocol !== 'https:' || candidate.origin !== managed.origin || candidate.username || candidate.password
      || !Number.isSafeInteger(managed.revision) || managed.revision < 1) throw new Error('受管后台地址配置无效');
    origin = candidate.origin;
  }
  return {
    origin,
    activationUrl: environment.DATA_FUSION_ACTIVATION_URL ?? `${origin}/api/activate`,
    statusUrl: environment.DATA_FUSION_LICENSE_STATUS_URL ?? `${origin}/api/license/status`,
    updateUrl: environment.DATA_FUSION_UPDATE_URL ?? `${origin}/api/updates/manifest`,
    enterpriseUrl: environment.DATA_FUSION_ENTERPRISE_URL ?? `${origin}/api/enterprises/resolve`,
    insecureHttpOrigin: environment.DATA_FUSION_ALLOW_INSECURE_HTTP_ORIGIN,
  };
}
