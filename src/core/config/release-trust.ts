/** Environment-provided test keys must never replace the trust root of a shipped app. */
export function releaseTrustedKey(embedded: string, override: string | undefined, development: boolean): string {
  return development && override ? override : embedded;
}
