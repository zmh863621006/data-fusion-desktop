/** Let the browser own saved credentials; never persist the password in application storage. */
export function offerBrowserPasswordSave(username: string, password: string): void {
  if (!window.isSecureContext || !navigator.credentials?.store) return;
  const PasswordCredential = (window as Window & {
    PasswordCredential?: new (data: { id: string; password: string; name: string }) => Credential;
  }).PasswordCredential;
  if (!PasswordCredential) return;
  try {
    void navigator.credentials.store(new PasswordCredential({
      id: username, password, name: '数据融合管理后台',
    })).catch(() => {
      // The browser or user may decline. Login must still complete normally.
    });
  } catch {
    // Browser password saving is optional; its native form fallback remains available.
  }
}
