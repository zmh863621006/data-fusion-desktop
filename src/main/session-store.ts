import { safeStorage } from 'electron';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { secureStorageAvailable } from './secure-storage';

interface StoredSessions {
  version: 1;
  values: Record<string, string>;
}

/** Stores browser/API session snapshots encrypted with the operating-system account. */
export class SecureSessionStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly storagePath: string) {}

  async get(key: string): Promise<string | null> {
    await this.pending;
    const stored = await this.read();
    const encrypted = stored.values[key];
    if (!encrypted) return null;
    if (!secureStorageAvailable()) throw new Error('当前系统安全存储不可用，无法恢复登录会话，请解锁系统密钥环或重新登录');
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    return this.enqueue(async () => {
      if (!secureStorageAvailable()) throw new Error('当前系统安全存储不可用，无法保存登录会话，请解锁系统密钥环后重试');
      const stored = await this.read();
      stored.values[key] = safeStorage.encryptString(value).toString('base64');
      await this.write(stored);
    });
  }

  async delete(key: string): Promise<void> {
    return this.enqueue(async () => {
      const stored = await this.read();
      if (!(key in stored.values)) return;
      delete stored.values[key];
      if (!Object.keys(stored.values).length) {
        await unlink(this.storagePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        return;
      }
      await this.write(stored);
    });
  }

  async flush(): Promise<void> { await this.pending; }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => {});
    return result;
  }

  private async write(value: StoredSessions): Promise<void> {
    await mkdir(dirname(this.storagePath), { recursive: true });
    const temporary = `${this.storagePath}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.storagePath);
  }

  private async read(): Promise<StoredSessions> {
    try {
      const value = JSON.parse(await readFile(this.storagePath, 'utf8')) as StoredSessions;
      return value?.version === 1 && value.values ? value : { version: 1, values: {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, values: {} };
      throw error;
    }
  }
}
