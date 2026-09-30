/**
 * Idempotent SQL migrations. Running them repeatedly must be safe.
 * Model revisions are immutable rows; Ka/Kw are frozen on a revision.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL,
  model_version INTEGER NOT NULL,
  revision_code TEXT NOT NULL UNIQUE,
  ka REAL NOT NULL CHECK (ka > 0),
  kw REAL NOT NULL CHECK (kw > 0),
  note TEXT NOT NULL DEFAULT '',
  supersedes_revision_id INTEGER,
  created_at TEXT NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS solutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL REFERENCES model_revisions(id),
  name TEXT NOT NULL,
  n_acid REAL NOT NULL DEFAULT 0,
  n_strong_acid REAL NOT NULL DEFAULT 0,
  n_strong_base REAL NOT NULL DEFAULT 0,
  volume_l REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS reagents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL REFERENCES model_revisions(id),
  name TEXT NOT NULL,
  acid_moiety_conc REAL NOT NULL DEFAULT 0,
  strong_acid_conc REAL NOT NULL DEFAULT 0,
  strong_base_conc REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS titration_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solution_id INTEGER NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  reagent_id INTEGER REFERENCES reagents(id),
  added_volume_l REAL NOT NULL,
  n_acid_after REAL NOT NULL,
  n_strong_acid_after REAL NOT NULL,
  n_strong_base_after REAL NOT NULL,
  volume_l_after REAL NOT NULL,
  ph_after REAL,
  residual_after REAL,
  converged_after INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(solution_id, seq)
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solution_id INTEGER NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  reagent_id INTEGER REFERENCES reagents(id),
  revision_id INTEGER NOT NULL REFERENCES model_revisions(id),
  total_titrant_l REAL NOT NULL,
  steps INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scan_points_run ON scan_points(run_id, step);
`,
  },
];
