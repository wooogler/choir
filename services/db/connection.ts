import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Logger } from 'services/common/logger';

let database: Database.Database | null = null;
let databasePath: string | null = null;

function resolveDatabasePath(): string {
  const configured = process.env.DATABASE_URL || process.env.SQLITE_DATABASE_PATH || 'file:data/choir.db';
  if (configured.startsWith('file:')) {
    return path.resolve(process.cwd(), configured.slice('file:'.length));
  }

  return path.resolve(process.cwd(), configured);
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
  `);
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
