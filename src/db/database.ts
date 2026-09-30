import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.ts';

export interface Clock {
  now(): Date;
  randomUUID(): string;
}

export const defaultClock: Clock = {
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
};

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/** Apply all pending migrations. Safe to run repeatedly. */
export function runMigrations(db: DatabaseSync): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  );
  const get = db.prepare(`SELECT value FROM schema_meta WHERE key = 'user_version'`);
  const row = get.get() as { value: string } | undefined;
  let current = row ? Number(row.value) : 0;
  const upsert = db.prepare(
    `INSERT INTO schema_meta(key, value) VALUES ('user_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  for (const m of MIGRATIONS) {
    if (m.version <= current) {
      db.exec(m.sql); // still execute: CREATE ... IF NOT EXISTS is idempotent
      continue;
    }
    const tx = db.exec.bind(db, m.sql);
    tx();
    current = m.version;
    upsert.run(String(current));
  }
  return current;
}
