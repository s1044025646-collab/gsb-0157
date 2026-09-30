import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, runMigrations } from '../src/db/database.ts';
import type { Clock } from '../src/db/database.ts';
import { Repository } from '../src/db/repository.ts';

export function freshRepo(db: DatabaseSync = new DatabaseSync(':memory:')): Repository {
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
 return new Repository(db);
}

export function tempDbPath(): string {
  return join(tmpdir(), `wat-test-${Math.random().toString(36).slice(2)}-${process.pid}.sqlite`);
}

export function openFileRepo(path: string, clock?: Clock): { db: DatabaseSync; repo: Repository } {
  const db = openDatabase(path);
  runMigrations(db);
  return { db, repo: new Repository(db, clock) };
}

export function cleanup(path: string): void {
  try {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  } catch {
    /* ignore */
  }
}

/** Fixed clock + id generator for repeatable tests. */
export function fakeClock(iso = '2026-01-01T00:00:00.000Z', seed = 0): Clock {
  let n = seed;
  return {
    now: () => new Date(iso),
    randomUUID: () => `fixed-uuid-${n++}`,
  };
}

export const KA = 1.8e-5;
export const KW = 1e-14;
