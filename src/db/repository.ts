import type { DatabaseSync } from 'node:sqlite';
import {
  CURRENT_MODEL_VERSION,
  MODEL_NAME,
  ModelDomainError,
} from '../chemistry/model.ts';
import type { Clock } from './database.ts';
import { defaultClock } from './database.ts';

export interface RevisionRow {
  id: number;
  model_name: string;
  model_version: number;
  revision_code: string;
  ka: number;
  kw: number;
  note: string;
  supersedes_revision_id: number | null;
  created_at: string;
  frozen: number;
}

export class Repository {
  private db: DatabaseSync;
  private clock: Clock;

  constructor(db: DatabaseSync, clock: Clock = defaultClock) {
    this.db = db;
    this.clock = clock;
  }

  /** Run fn inside a transaction, rolling back on any throw. */
  private inTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  ts(): string {
    return this.clock.now().toISOString();
  }

  /**
   * Create a new frozen model revision. Revisions are immutable; changing
   * Ka/Kw always produces a new revision (superseding the prior one).
   */
  createRevision(args: {
    revisionCode: string;
    ka: number;
    kw: number;
    note?: string;
    supersedesId?: number | null;
  }): RevisionRow {
    const existing = this.db
      .prepare(`SELECT id FROM model_revisions WHERE revision_code = ?`)
      .get(args.revisionCode);
    if (existing) {
      throw new ModelDomainError(
        'REVISION_CODE_EXISTS',
        `Revision code ${args.revisionCode} already exists (revisions are frozen)`,
      );
    }
    const info = this.db
      .prepare(
        `INSERT INTO model_revisions
         (model_name, model_version, revision_code, ka, kw, note, supersedes_revision_id, created_at, frozen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        MODEL_NAME,
        CURRENT_MODEL_VERSION,
        args.revisionCode,
        args.ka,
        args.kw,
        args.note ?? '',
        args.supersedesId ?? null,
        this.ts(),
      );
    return this.getRevision(Number(info.lastInsertRowid));
  }

  getRevision(id: number): RevisionRow {
    const row = this.db
      .prepare(`SELECT * FROM model_revisions WHERE id = ?`)
      .get(id) as RevisionRow | undefined;
    if (!row) {
      throw new ModelDomainError('REVISION_NOT_FOUND', `Revision ${id} not found`);
    }
    return row;
  }

  getRevisionByCode(code: string): RevisionRow {
    const row = this.db
      .prepare(`SELECT * FROM model_revisions WHERE revision_code = ?`)
      .get(code) as RevisionRow | undefined;
    if (!row) {
      throw new ModelDomainError('REVISION_NOT_FOUND', `Revision ${code} not found`);
    }
    return row;
  }

  latestRevision(): RevisionRow {
    const row = this.db
      .prepare(`SELECT * FROM model_revisions ORDER BY id DESC LIMIT 1`)
      .get() as RevisionRow | undefined;
    if (!row) {
      throw new ModelDomainError('NO_REVISION', 'No model revision exists; create one first');
    }
    return row;
  }

  listRevisions(limit: number, offset: number): { rows: RevisionRow[]; total: number } {
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM model_revisions`).get() as { c: number }
    ).c;
    const rows = this.db
      .prepare(`SELECT * FROM model_revisions ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as unknown as RevisionRow[];
    return { rows, total };
  }

  createReagent(args: {
    revisionId: number;
    name: string;
    acidMoietyConc: number;
    strongAcidConc: number;
    strongBaseConc: number;
  }) {
    this.getRevision(args.revisionId);
    const info = this.db
      .prepare(
        `INSERT INTO reagents
         (revision_id, name, acid_moiety_conc, strong_acid_conc, strong_base_conc, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.revisionId,
        args.name,
        args.acidMoietyConc,
        args.strongAcidConc,
        args.strongBaseConc,
        this.ts(),
      );
    return this.getReagent(Number(info.lastInsertRowid));
  }

  getReagent(id: number) {
    const row = this.db.prepare(`SELECT * FROM reagents WHERE id = ?`).get(id) as
      | ReagentRow
      | undefined;
    if (!row) throw new ModelDomainError('REAGENT_NOT_FOUND', `Reagent ${id} not found`);
    return row;
  }

  listReagents(limit: number, offset: number) {
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM reagents`).get() as {
      c: number;
    }).c;
    const rows = this.db
      .prepare(`SELECT * FROM reagents ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as unknown as ReagentRow[];
    return { rows, total };
  }

  /**
   * Create a solution. Idempotent on idempotency_key: a repeated submit with
   * the same key returns the previously created row unchanged.
   */
  createSolution(args: {
    revisionId: number;
    name: string;
    nAcid: number;
    nStrongAcid: number;
    nStrongBase: number;
    volumeL: number;
    idempotencyKey?: string;
  }): { row: SolutionRow; replayed: boolean } {
    this.getRevision(args.revisionId);
    if (args.idempotencyKey) {
      const found = this.db
        .prepare(`SELECT * FROM solutions WHERE idempotency_key = ?`)
        .get(args.idempotencyKey) as SolutionRow | undefined;
      if (found) return { row: found, replayed: true };
    }
    const info = this.db
      .prepare(
        `INSERT INTO solutions
         (revision_id, name, n_acid, n_strong_acid, n_strong_base, volume_l, created_at, updated_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.revisionId,
        args.name,
        args.nAcid,
        args.nStrongAcid,
        args.nStrongBase,
        args.volumeL,
        this.ts(),
        this.ts(),
        args.idempotencyKey ?? null,
      );
    return { row: this.getSolution(Number(info.lastInsertRowid)), replayed: false };
  }

  getSolution(id: number): SolutionRow {
    const row = this.db.prepare(`SELECT * FROM solutions WHERE id = ?`).get(id) as
      | SolutionRow
      | undefined;
    if (!row) throw new ModelDomainError('SOLUTION_NOT_FOUND', `Solution ${id} not found`);
    return row;
  }

  listSolutions(limit: number, offset: number) {
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM solutions`).get() as {
      c: number;
    }).c;
    const rows = this.db
      .prepare(`SELECT * FROM solutions ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as unknown as SolutionRow[];
    return { rows, total };
  }

  nextStepSeq(solutionId: number): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM titration_steps WHERE solution_id = ?`)
      .get(solutionId) as { next: number };
    return row.next;
  }

  listSteps(solutionId: number) {
    return this.db
      .prepare(`SELECT * FROM titration_steps WHERE solution_id = ? ORDER BY seq ASC`)
      .all(solutionId) as unknown as StepRow[];
  }

  /**
   * Append a titration step inside a transaction. The state mutation and
   * step record commit together; any failure rolls both back.
   */
  addStep(args: {
    solutionId: number;
    reagentId: number | null;
    addedVolumeL: number;
    nAcidAfter: number;
    nStrongAcidAfter: number;
    nStrongBaseAfter: number;
    volumeAfter: number;
    phAfter: number | null;
    residualAfter: number | null;
    convergedAfter: boolean | null;
  }): StepRow {
    const id = this.inTransaction(() => {
      const sol = this.getSolution(args.solutionId);
      const seq = this.nextStepSeq(args.solutionId);
      const info = this.db
        .prepare(
          `INSERT INTO titration_steps
           (solution_id, seq, reagent_id, added_volume_l, n_acid_after, n_strong_acid_after,
            n_strong_base_after, volume_l_after, ph_after, residual_after, converged_after, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.solutionId,
          seq,
          args.reagentId,
          args.addedVolumeL,
          args.nAcidAfter,
          args.nStrongAcidAfter,
          args.nStrongBaseAfter,
          args.volumeAfter,
          args.phAfter,
          args.residualAfter,
          args.convergedAfter === null ? null : args.convergedAfter ? 1 : 0,
          this.ts(),
        );
      this.db
        .prepare(
          `UPDATE solutions SET n_acid = ?, n_strong_acid = ?, n_strong_base = ?, volume_l = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          args.nAcidAfter,
          args.nStrongAcidAfter,
          args.nStrongBaseAfter,
          args.volumeAfter,
          this.ts(),
          args.solutionId,
        );
      void sol;
      return Number(info.lastInsertRowid);
    });
    return this.db.prepare(`SELECT * FROM titration_steps WHERE id = ?`).get(id) as unknown as StepRow;
  }

  saveScanRun(args: {
    solutionId: number;
    reagentId: number | null;
    revisionId: number;
    totalTitrantL: number;
    steps: number;
    idempotencyKey?: string;
    points: unknown[];
  }): { runId: number; replayed: boolean } {
    if (args.idempotencyKey) {
      const found = this.db
        .prepare(`SELECT id FROM scan_runs WHERE idempotency_key = ?`)
        .get(args.idempotencyKey) as { id: number } | undefined;
      if (found) return { runId: found.id, replayed: true };
    }
    const runId = this.inTransaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO scan_runs
           (solution_id, reagent_id, revision_id, total_titrant_l, steps, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.solutionId,
          args.reagentId,
          args.revisionId,
          args.totalTitrantL,
          args.steps,
          args.idempotencyKey ?? null,
          this.ts(),
        );
      const runId = Number(info.lastInsertRowid);
      const ins = this.db.prepare(
        `INSERT INTO scan_points (run_id, step, payload) VALUES (?, ?, ?)`,
      );
      args.points.forEach((p, i) => ins.run(runId, i, JSON.stringify(p)));
      return runId;
    });
    return { runId, replayed: false };
  }

  getScanPoints(runId: number, limit: number, offset: number) {
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM scan_points WHERE run_id = ?`).get(runId) as {
        c: number;
      }
    ).c;
    const rows = this.db
      .prepare(`SELECT step, payload FROM scan_points WHERE run_id = ? ORDER BY step ASC LIMIT ? OFFSET ?`)
      .all(runId, limit, offset) as { step: number; payload: string }[];
    return {
      total,
      rows: rows.map((r) => ({ step: r.step, point: JSON.parse(r.payload) })),
    };
  }
}

export interface ReagentRow {
  id: number;
  revision_id: number;
  name: string;
  acid_moiety_conc: number;
  strong_acid_conc: number;
  strong_base_conc: number;
  created_at: string;
}

export interface SolutionRow {
  id: number;
  revision_id: number;
  name: string;
  n_acid: number;
  n_strong_acid: number;
  n_strong_base: number;
  volume_l: number;
  created_at: string;
  updated_at: string;
  idempotency_key: string | null;
}

export interface StepRow {
  id: number;
  solution_id: number;
  seq: number;
  reagent_id: number | null;
  added_volume_l: number;
  n_acid_after: number;
  n_strong_acid_after: number;
  n_strong_base_after: number;
  volume_l_after: number;
  ph_after: number | null;
  residual_after: number | null;
  converged_after: number | null;
  created_at: string;
}
