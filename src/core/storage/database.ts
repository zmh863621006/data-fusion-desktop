import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export interface DatabaseDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DatabaseMigration {
  version: number;
  name: string;
  up: (database: DatabaseDriver) => Promise<void>;
}

export async function applyMigrations(database: DatabaseDriver, migrations: DatabaseMigration[]): Promise<void> {
  await database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const rows = await database.all<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.version));

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    await database.transaction(async () => {
      await migration.up(database);
      await database.run(
        'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, Date.now()],
      );
    });
  }
}

function sqlParams(params: unknown[]): SQLInputValue[] {
  return params.map((value) => {
    if (value === undefined) return null;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      ArrayBuffer.isView(value)
    ) {
      return value as SQLInputValue;
    }
    throw new TypeError('Unsupported SQLite parameter type');
  });
}

export class NodeSqliteDriver implements DatabaseDriver {
  private readonly database: DatabaseSync;
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const load = createRequire(join(dirname(process.execPath), 'data-fusion-runtime.cjs'));
    if (Number(process.versions.node.split('.')[0]) >= 22) {
      const native = load('node:sqlite') as typeof import('node:sqlite');
      this.database = new native.DatabaseSync(path, { allowExtension: false });
    } else {
      // Load the fixed, ABI-matched compatibility resource rather than a module
      // selected by an environment variable or by the renderer.
      if (!process.resourcesPath) throw new Error('兼容版数据库组件未就绪，请重新安装应用');
      const LegacyDatabase = load(join(process.resourcesPath, 'legacy-runtime', 'node_modules', 'better-sqlite3'));
      this.database = new LegacyDatabase(path) as DatabaseSync;
    }
  }

  async exec(sql: string): Promise<void> {
    return this.serialized(() => { this.database.exec(sql); });
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowid?: number | bigint }> {
    return this.serialized(() => {
      const result = this.database.prepare(sql).run(...sqlParams(params));
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    });
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.serialized(() => this.database.prepare(sql).get(...sqlParams(params)) as T | undefined);
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.serialized(() => this.database.prepare(sql).all(...sqlParams(params)) as T[]);
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) return work();
    return this.serialized(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const result = await this.transactionContext.run(true, work);
        this.database.exec('COMMIT');
        return result;
      } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    });
  }

  /** Independent reads/writes must not join or observe another asynchronous transaction. */
  private async serialized<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) return work();
    const previous = this.transactionQueue;
    let release!: () => void;
    this.transactionQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;

    try { return await work(); } finally { release(); }
  }

  async close(): Promise<void> {
    return this.serialized(() => { this.database.close(); });
  }
}
