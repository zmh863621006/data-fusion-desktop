PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS local_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  data_json TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(system_id, matter_id, record_key)
);

CREATE INDEX IF NOT EXISTS idx_local_records_system_matter
  ON local_records(system_id, matter_id);
CREATE INDEX IF NOT EXISTS idx_local_records_updated_at
  ON local_records(updated_at);

CREATE TABLE IF NOT EXISTS record_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_record_versions_key
  ON record_versions(system_id, matter_id, record_key, captured_at DESC);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  status TEXT NOT NULL,
  query_json TEXT,
  total_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_system_matter
  ON sync_runs(system_id, matter_id, started_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  system_id TEXT,
  matter_id TEXT,
  task_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at
  ON audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  system_id TEXT,
  matter_id TEXT,
  status TEXT NOT NULL,
  progress_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error_message TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_tasks_created_at
  ON runtime_tasks(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_tasks_success_snapshot
  ON runtime_tasks(system_id, matter_id, type, status, finished_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS task_output_rows (
  task_id TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  system_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY(task_id, row_no),
  FOREIGN KEY(task_id) REFERENCES runtime_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_output_rows_task
  ON task_output_rows(task_id, row_no);
