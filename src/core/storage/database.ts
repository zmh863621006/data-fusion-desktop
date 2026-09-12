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
