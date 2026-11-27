import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const crypto = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true), getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value: string) => Buffer.from(`synthetic-encrypted:${value}`),
  decryptString: (value: Buffer) => value.toString().slice('synthetic-encrypted:'.length),
}));
vi.mock('electron', () => ({ safeStorage: crypto }));
import { SecureCredentialStore } from './credential-store';
const directories: string[] = [];
afterEach(async () => {
  crypto.isEncryptionAvailable.mockReturnValue(true);
  for (const path of directories.splice(0)) {
    if (dirname(resolve(path)) === resolve(tmpdir()) && path.startsWith(join(tmpdir(), 'fusion-credential-test-'))) await rm(path, { recursive: true, force: true });
  }
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'fusion-credential-test-')); directories.push(path);
  const file = join(path, 'credentials.secure.json'); return { file, store: new SecureCredentialStore(file) };
}
it('preserves independent systems during concurrent configuration changes and after reopening', async () => {
  const { file, store } = await fixture();
  const one = { account: 'synthetic-one', password: 'synthetic-password-one' };
  const two = { account: 'synthetic-two', password: 'synthetic-password-two' };
  const writes = [store.set('shenzhen-one-window', one), store.set('shenzhen-housing-rental', two), store.set('shenzhen-one-window', { ...one, password: 'synthetic-updated' })];
  await store.flush(); await Promise.all(writes);
  const reopened = new SecureCredentialStore(file);
  expect(await reopened.get('shenzhen-one-window')).toEqual({ ...one, password: 'synthetic-updated' });
  expect(await reopened.get('shenzhen-housing-rental')).toEqual(two);
  expect(await readFile(file, 'utf8')).not.toMatch(/synthetic-one|synthetic-two|synthetic-password|synthetic-updated/);
});
it('retains secure-storage failure behavior without breaking later saves', async () => {
  const { store } = await fixture(); crypto.isEncryptionAvailable.mockReturnValue(false);
  await expect(store.set('one', { account: 'synthetic', password: 'synthetic' })).rejects.toThrow('安全存储不可用');
  crypto.isEncryptionAvailable.mockReturnValue(true);
  await store.set('two', { account: 'synthetic', password: 'synthetic' });
  expect(await store.get('two')).toEqual({ account: 'synthetic', password: 'synthetic' });
  expect(await store.get('one')).toBeNull();
});
