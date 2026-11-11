import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ safeStorage: {} }));
import { configureLinuxSecretStorage, secureStorageAvailable } from './secure-storage';

describe('operating-system secret storage', () => {
  it('selects Secret Service on Linux even when a remote launch lacks desktop variables', () => {
    const commandLine = { hasSwitch: () => false, appendSwitch: vi.fn() };
    configureLinuxSecretStorage(commandLine, 'linux');
    expect(commandLine.appendSwitch).toHaveBeenCalledExactlyOnceWith('password-store', 'gnome-libsecret');
  });
  it('preserves an explicit backend choice and Windows native storage', () => {
    const commandLine = { hasSwitch: () => true, appendSwitch: vi.fn() };
    configureLinuxSecretStorage(commandLine, 'linux');
    configureLinuxSecretStorage({ ...commandLine, hasSwitch: () => false }, 'win32');
    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
  });
  it.each(['basic_text', 'unknown', undefined])('rejects unavailable Linux keyring backend: %s', backend => {
    expect(secureStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend! }, 'linux')).toBe(false);
  });
  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])('accepts a secure Linux backend: %s', backend => {
    expect(secureStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend }, 'linux')).toBe(true);
  });
  it('preserves native Windows encryption and refuses unavailable encryption', () => {
    expect(secureStorageAvailable({ isEncryptionAvailable: () => true }, 'win32')).toBe(true);
    expect(secureStorageAvailable({ isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'gnome_libsecret' }, 'linux')).toBe(false);
  });
});
