import { safeStorage } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { secureStorageAvailable } from './secure-storage';

export interface SystemCredentials {
  account: string;
  password: string;
}

interface StoredCredentials {
  version: 1;
  systems: Record<string, string>;
}

export class SecureCredentialStore {
  constructor(private readonly storagePath: string) {}

  async get(systemId: string): Promise<SystemCredentials | null> {
    const stored = await this.read();
    const encrypted = stored.systems[systemId];
    if (!encrypted) return null;
    if (!secureStorageAvailable()) throw new Error('当前系统安全存储不可用，请解锁系统密钥环后重试，或手动登录业务系统');
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))) as SystemCredentials;
    } catch {
      throw new Error('业务系统登录配置无法解密，请重新配置账号密码');
    }
  }

  async set(systemId: string, credentials: SystemCredentials): Promise<void> {
    if (!secureStorageAvailable()) throw new Error('当前系统安全存储不可用，请解锁系统密钥环后再保存业务系统密码');
    const stored = await this.read();
    stored.systems[systemId] = safeStorage.encryptString(JSON.stringify(credentials)).toString('base64');
    await mkdir(dirname(this.storagePath), { recursive: true });
    const temporary = `${this.storagePath}.tmp`;
    await writeFile(temporary, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.storagePath);
  }

  private async read(): Promise<StoredCredentials> {
    try {
      const value = JSON.parse(await readFile(this.storagePath, 'utf8')) as StoredCredentials;
      return value?.version === 1 && value.systems ? value : { version: 1, systems: {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, systems: {} };
      throw error;
    }
  }
}
