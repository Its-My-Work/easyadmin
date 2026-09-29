import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'easyadmin.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      token_enc TEXT NOT NULL,
      insecure_tls INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '#6366f1',
      tags TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_seen INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      username TEXT,
      panel_id INTEGER,
      panel_name TEXT,
      action TEXT NOT NULL,
      target TEXT,
      ok INTEGER NOT NULL DEFAULT 1,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts DESC);
    CREATE TABLE IF NOT EXISTS user_panels (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      panel_id INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, panel_id)
    );
    CREATE TABLE IF NOT EXISTS stats_history (
      panel_id INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL, cpu REAL, mem REAL, disk REAL
    );
    CREATE INDEX IF NOT EXISTS stats_history_pt ON stats_history(panel_id, ts);
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT NOT NULL, config_enc TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT NOT NULL, config_enc TEXT NOT NULL,
      origin TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      target TEXT NOT NULL, action TEXT NOT NULL,
      mode TEXT NOT NULL, time TEXT, days TEXT NOT NULL DEFAULT '', interval_min INTEGER,
      last_run INTEGER, last_status TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      panel_id INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
      type TEXT NOT NULL, project TEXT NOT NULL, name TEXT NOT NULL, action TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_used INTEGER
    );
  `);
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('totp_secret_enc')) db.exec('ALTER TABLE users ADD COLUMN totp_secret_enc TEXT');
  if (!cols.includes('display_name')) db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  if (!cols.includes('disabled')) db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('last_login')) db.exec('ALTER TABLE users ADD COLUMN last_login INTEGER');
  const scols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!scols.includes('ip')) db.exec('ALTER TABLE sessions ADD COLUMN ip TEXT');
  if (!scols.includes('ua')) db.exec('ALTER TABLE sessions ADD COLUMN ua TEXT');
  if (!scols.includes('last_used')) db.exec('ALTER TABLE sessions ADD COLUMN last_used INTEGER');
  db.exec('UPDATE schedules SET last_run = NULL WHERE last_status IS NULL AND last_run = created_at'); // раньше время создания хранилось как «последний запуск»
  if (!cols.includes('oidc_sub')) db.exec('ALTER TABLE users ADD COLUMN oidc_sub TEXT');
  if (!cols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_oidc_sub ON users(oidc_sub) WHERE oidc_sub IS NOT NULL');
  if (!cols.includes('totp_enabled')) db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0');
  return db;
}
