import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
const crypto = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
  decryptString: vi.fn((value: Buffer) => value.toString().slice('encrypted:'.length)),
}));
vi.mock('electron', () => ({ safeStorage: crypto }));
import { SecureSessionStore } from './session-store';
const directories: string[] = [];
afterEach(async () => {
  crypto.isEncryptionAvailable.mockReturnValue(true);
  for (const path of directories.splice(0)) if (dirname(resolve(path)) === resolve(tmpdir()) && path.startsWith(join(tmpdir(), 'fusion-vault-test-'))) {
    await rm(path, { recursive: true, force: true });
  }
});
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'fusion-vault-test-')); directories.push(dir); const path = join(dir, 'sessions.json'); return { store: new SecureSessionStore(path), path }; }

describe('secure session vault', () => {
  it('serializes concurrent writes and deletes without losing other systems', async () => {
    const { store, path } = await fixture();
    await Promise.all([store.set('a', 'fixture-secret-a'), store.set('b', 'fixture-secret-b'), store.set('c', 'fixture-secret-c')]);
    await Promise.all([store.delete('a'), store.set('b', 'new-secret-b'), store.set('d', 'fixture-secret-d')]);
    expect(await store.get('a')).toBeNull(); expect(await store.get('b')).toBe('new-secret-b'); expect(await store.get('c')).toBe('fixture-secret-c');
    const reopened = new SecureSessionStore(path); expect(await reopened.get('d')).toBe('fixture-secret-d');
    expect(await readFile(path, 'utf8')).not.toMatch(/fixture-secret|new-secret/);
  });
  it('fails closed without an encryption provider and leaves the queue usable', async () => {
    const { store } = await fixture();
    crypto.isEncryptionAvailable.mockReturnValue(false);
    await expect(store.set('a', 'fixture')).rejects.toThrow('安全存储不可用');
    crypto.isEncryptionAvailable.mockReturnValue(true);
    await store.set('a', 'valid'); await store.flush();
    expect(await store.get('a')).toBe('valid');
  });
});
