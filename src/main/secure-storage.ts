import { safeStorage } from 'electron';

interface StorageBackend {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
}

interface PasswordStoreSwitches {
  hasSwitch(name: string): boolean;
  appendSwitch(name: string, value: string): void;
}

/** UKUI launches from SSH may lack desktop environment variables. Use the same
 * Secret Service backend as a normal desktop launch, never Chromium basic_text. */
export function configureLinuxSecretStorage(commandLine: PasswordStoreSwitches, platform = process.platform): void {
  if (platform === 'linux' && !commandLine.hasSwitch('password-store')) commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

/** Linux basic_text uses a public fixed password and must never store credentials. */
export function secureStorageAvailable(storage: StorageBackend = safeStorage, platform = process.platform): boolean {
  if (!storage.isEncryptionAvailable()) return false;
  if (platform !== 'linux') return true;
  const backend = storage.getSelectedStorageBackend?.();
  return backend === 'gnome_libsecret' || backend === 'kwallet' || backend === 'kwallet5' || backend === 'kwallet6';
}
