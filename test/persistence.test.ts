import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, runMigrations } from '../src/db/database.ts';
import { Repository } from '../src/db/repository.ts';
import type { SolutionRow } from '../src/db/repository.ts';
import { ModelDomainError } from '../src/chemistry/model.ts';
import { solveState } from '../src/chemistry/titration.ts';
import { cleanup, fakeClock, freshRepo, KA, KW, openFileRepo, tempDbPath } from './helpers.ts';

test('revisions freeze positive Ka/Kw; duplicate code rejected', () => {
  const repo = freshRepo();
  const r1 = repo.createRevision({ revisionCode: 'v1', ka: KA, kw: KW });
  assert.equal(r1.frozen, 1);
  assert.throws(
    () => repo.createRevision({ revisionCode: 'v1', ka: KA, kw: KW }),
    (e: ModelDomainError) => e.code === 'REVISION_CODE_EXISTS',
  );
  const r2 = repo.createRevision({ revisionCode: 'v2', ka: KA, kw: 2e-14, supersedesId: r1.id });
  assert.equal(r2.supersedes_revision_id, r1.id);
});

test('solution creation is idempotent on key', () => {
  const repo = freshRepo();
  const rev = repo.createRevision({ revisionCode: 'v1', ka: KA, kw: KW });
  const args = {
    revisionId: rev.id,
    name: 's',
    nAcid: 0.1,
    nStrongAcid: 0,
    nStrongBase: 0,
    volumeL: 1,
    idempotencyKey: 'k-1',
  };
  const a = repo.createSolution(args);
  const b = repo.createSolution(args);
  assert.equal(a.row.id, b.row.id);
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true);
});

test('titration step updates state and records history atomically', () => {
  const repo = freshRepo();
  const rev = repo.createRevision({ revisionCode: 'v1', ka: KA, kw: KW });
  const reagent = repo.createReagent({
    revisionId: rev.id,
    name: 'base',
    acidMoietyConc: 0,
    strongAcidConc: 0,
    strongBaseConc: 0.1,
  });
  const { row: sol } = repo.createSolution({
    revisionId: rev.id,
    name: 's',
    nAcid: 0.1,
    nStrongAcid: 0,
    nStrongBase: 0,
    volumeL: 1,
  });
  repo.addStep({
    solutionId: sol.id,
    reagentId: reagent.id,
    addedVolumeL: 0.5,
    nAcidAfter: 0.1,
    nStrongAcidAfter: 0,
    nStrongBaseAfter: 0.05,
    volumeAfter: 1.5,
    phAfter: 4.74,
    residualAfter: 0,
    convergedAfter: true,
  });
  const updated = repo.getSolution(sol.id);
  assert.equal(updated.n_strong_base, 0.05);
  assert.equal(updated.volume_l, 1.5);
  assert.equal(repo.listSteps(sol.id).length, 1);
});

test('failed step rolls back both the mutation and the history row', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  const repo = new Repository(db);
  const rev = repo.createRevision({ revisionCode: 'v1', ka: KA, kw: KW });
  const { row: sol } = repo.createSolution({
    revisionId: rev.id,
    name: 's',
    nAcid: 0.1,
    nStrongAcid: 0,
    nStrongBase: 0,
    volumeL: 1,
  });
  const before = repo.getSolution(sol.id);
  assert.throws(() =>
    repo.addStep({
      solutionId: sol.id,
      reagentId: 999, // FK violation
      addedVolumeL: 0.5,
      nAcidAfter: 0.1,
      nStrongAcidAfter: 0,
      nStrongBaseAfter: 0.05,
      volumeAfter: 1.5,
      phAfter: null,
      residualAfter: null,
      convergedAfter: null,
    }),
  );
  const after = repo.getSolution(sol.id);
  assert.equal(after.volume_l, before.volume_l);
  assert.equal(after.n_strong_base, 0);
  assert.equal(repo.listSteps(sol.id).length, 0);
});

test('state survives close/reopen and old revision reproduces identical pH', () => {
  const path = tempDbPath();
  try {
    const { db, repo } = openFileRepo(path, fakeClock());
    const v1 = repo.createRevision({ revisionCode: 'frozen-v1', ka: KA, kw: KW });
    const { row: sol } = repo.createSolution({
      revisionId: v1.id,
      name: 'keep',
      nAcid: 0.1,
      nStrongAcid: 0,
      nStrongBase: 0,
      volumeL: 1,
    });
    const expected = solveState(
      { nAcid: 0.1, nStrongAcid: 0, nStrongBase: 0, volumeL: 1 },
      { ka: KA, kw: KW },
    ).ph;
    db.close();

    const reopened = openDatabase(path);
    runMigrations(reopened); // idempotent re-run
    const repo2 = new Repository(reopened);
    const solRow = repo2.getSolution(sol.id) as SolutionRow;
    const revRow = repo2.getRevision(solRow.revision_id);
    assert.equal(revRow.revision_code, 'frozen-v1');
    const again = solveState(
      {
        nAcid: solRow.n_acid,
        nStrongAcid: solRow.n_strong_acid,
        nStrongBase: solRow.n_strong_base,
        volumeL: solRow.volume_l,
      },
      { ka: revRow.ka, kw: revRow.kw },
    ).ph;
    assert.equal(again, expected);
    reopened.close();
  } finally {
    cleanup(path);
  }
});

test('pagination limits and offsets revisions', () => {
  const repo = freshRepo();
  for (let i = 0; i < 5; i += 1) {
    repo.createRevision({ revisionCode: `r${i}`, ka: KA, kw: KW });
  }
  const page1 = repo.listRevisions(2, 0);
  assert.equal(page1.total, 5);
  assert.equal(page1.rows.length, 2);
  const page3 = repo.listRevisions(2, 4);
  assert.equal(page3.rows.length, 1);
});

test('scan run is idempotent and points persist', () => {
  const repo = freshRepo();
  const rev = repo.createRevision({ revisionCode: 'v1', ka: KA, kw: KW });
  const { row: sol } = repo.createSolution({
    revisionId: rev.id,
    name: 's',
    nAcid: 0.1,
    nStrongAcid: 0,
    nStrongBase: 0,
    volumeL: 1,
  });
  const payload = Array.from({ length: 4 }, (_, i) => ({ step: i, ph: 3 + i }));
  const a = repo.saveScanRun({
    solutionId: sol.id,
    reagentId: null,
    revisionId: rev.id,
    totalTitrantL: 1,
    steps: 3,
    idempotencyKey: 'scan-1',
    points: payload,
  });
  const b = repo.saveScanRun({
    solutionId: sol.id,
    reagentId: null,
    revisionId: rev.id,
    totalTitrantL: 1,
    steps: 3,
    idempotencyKey: 'scan-1',
    points: payload,
  });
  assert.equal(a.runId, b.runId);
  assert.equal(b.replayed, true);
  const page = repo.getScanPoints(a.runId, 2, 1);
  assert.equal(page.total, 4);
  assert.equal(page.rows.length, 2);
  assert.equal(page.rows[0]!.step, 1);
});
