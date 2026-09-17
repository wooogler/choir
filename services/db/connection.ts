import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Logger } from 'services/common/logger';

let database: Database.Database | null = null;
let databasePath: string | null = null;

function toSqlitePath(value: string): string {
  return path.resolve(process.cwd(), value.startsWith('file:') ? value.slice('file:'.length) : value);
}

function resolveDatabasePath(): string {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    // A non-file URL scheme (e.g. a PaaS-injected postgres://) is NOT a SQLite
    // path — resolving it as a filename silently created a bogus db file. Ignore
    // it and fall back to the SQLite-specific setting / default.
    if (!databaseUrl.startsWith('file:') && /^[a-z][a-z0-9+.-]*:\/\//i.test(databaseUrl)) {
      Logger.warn('Ignoring non-file DATABASE_URL for SQLite; using SQLITE_DATABASE_PATH/default', {
        scheme: databaseUrl.split('://')[0],
      });
    } else {
      return toSqlitePath(databaseUrl);
    }
  }

  return toSqlitePath(process.env.SQLITE_DATABASE_PATH || 'file:data/choir.db');
}

/**
 * SQLite has no `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, so a column added to a
 * table that already exists in the wild has to be guarded by hand. Checking
 * `PRAGMA table_info` keeps `initializeSchema` idempotent (it runs on every
 * open) without needing a `schema_migrations` row per column.
 */
function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  Logger.info('SQLite column added.', { table, column });
}

function initializeSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS slack_installations (
      installation_id TEXT PRIMARY KEY,
      team_id TEXT,
      enterprise_id TEXT,
      installation_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspace_configs (
      workspace_id TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_type TEXT NOT NULL,
      session_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_type, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions (session_type);

    CREATE TABLE IF NOT EXISTS app_state (
      state_key TEXT PRIMARY KEY,
      state_type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_app_state_type ON app_state (state_type);

    -- Awareness dashboard (Part B). Privacy-scrubbed Q&A analytics: only a
    -- paraphrased (not raw) question, a per-workspace-salted user hash (for
    -- k-anonymity counting, never a raw userId), and week-level time. created_at
    -- is kept for internal ordering/retention but is never exposed via the API.
    CREATE TABLE IF NOT EXISTS qa_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      label TEXT NOT NULL,
      representative TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_qa_topics_workspace ON qa_topics (workspace_id);

    CREATE TABLE IF NOT EXISTS qa_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      iso_week TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      can_answer INTEGER NOT NULL DEFAULT 0,
      search_results INTEGER NOT NULL DEFAULT 0,
      user_hash TEXT NOT NULL,
      paraphrase TEXT NOT NULL,
      embedding BLOB,
      topic_id INTEGER REFERENCES qa_topics(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_qa_events_ws_week ON qa_events (workspace_id, iso_week);
    CREATE INDEX IF NOT EXISTS idx_qa_events_ws_hash ON qa_events (workspace_id, user_hash);

    CREATE TABLE IF NOT EXISTS qa_event_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES qa_events(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      section_id TEXT,
      heading_path TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_qa_event_chunks_event ON qa_event_chunks (event_id);
  `);

  // Localized display labels for a topic: a JSON object keyed by locale,
  // `{"ko":{"label":…,"representative":…}}`, holding only the non-English
  // translations (the columns above stay the English clustering key). One JSON
  // column instead of a column per language, so adding a locale needs no
  // migration. Added here rather than in the CREATE above because qa_topics
  // already exists on deployed databases.
  addColumnIfMissing(db, 'qa_topics', 'labels_json', 'TEXT');
}

export function getDatabase(): Database.Database {
  const nextPath = resolveDatabasePath();

  if (database && databasePath === nextPath) {
    return database;
  }

  if (database) {
    database.close();
  }

  fs.mkdirSync(path.dirname(nextPath), { recursive: true });
  database = new Database(nextPath);
  databasePath = nextPath;

  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  initializeSchema(database);

  Logger.info('SQLite database initialized.', { databasePath: nextPath });
  return database;
}

export function closeDatabase(): void {
  if (database) {
    database.close();
    database = null;
    databasePath = null;
  }
}
