/**
 * Deterministic, repeatable end-to-end demonstration run entirely inside
 * this project (data/demo.sqlite). Uses the teaching FICTIONAL fixtures.
 * Prints before/after state, a curve, max-slope estimate, refinement, a
 * parameter comparison and a CSV distribution export.
 */
import { rmSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openDatabase, runMigrations } from '../src/db/database.ts';
import { Repository } from '../src/db/repository.ts';
import { TitrationService } from '../src/service.ts';
import { FIXTURES } from '../src/chemistry/fixtures.ts';
import { distributionRows } from '../src/chemistry/titration.ts';
import { MODEL_ASSUMPTIONS } from '../src/chemistry/model.ts';

const root = resolve(process.cwd());
const dbPath = join(root, 'data', 'demo.sqlite');
for (const suffix of ['', '-wal', '-shm']) {
  const p = dbPath + suffix;
  if (existsSync(p)) rmSync(p, { force: true });
}

const db = openDatabase(dbPath);
runMigrations(db);
const repo = new Repository(db);
const svc = new TitrationService(repo);

const f = FIXTURES[0]!;
console.log('=== Weak-acid titration backend: repeatable demo ===');
console.log(`fictional case: ${f.key} — ${f.description}\n`);
console.log('Model assumptions:');
MODEL_ASSUMPTIONS.forEach((a, i) => console.log(`  ${i + 1}. ${a}`));
console.log('');

const rev = repo.createRevision({ revisionCode: 'demo-v1', ka: f.ka, kw: f.kw, note: f.key });
const reagent = repo.createReagent({
  revisionId: rev.id,
  name: f.titrant.name,
  acidMoietyConc: f.titrant.acidMoietyConc,
  strongAcidConc: f.titrant.strongAcidConc,
  strongBaseConc: f.titrant.strongBaseConc,
});
const { row: sol } = repo.createSolution({
  revisionId: rev.id,
  name: f.solution.name,
  nAcid: f.solution.nAcid,
  nStrongAcid: f.solution.nStrongAcid,
  nStrongBase: f.solution.nStrongBase,
  volumeL: f.solution.volumeL,
  idempotencyKey: 'demo-solution',
});

const initial = svc.equilibrium(sol.id);
console.log(
  `initial: V=${initial.state.volumeL} L  pH=${initial.equilibrium.ph.toFixed(4)}  ` +
    `residual=${initial.equilibrium.residual.toExponential(2)} converged=${initial.equilibrium.converged}`,
);

const half = svc.addTitrant(sol.id, reagent.id, f.expected.halfEquivalenceTitrantL);
console.log(
  `add titrant to half-equivalence: before pH=${half.before.ph.toFixed(4)} -> after pH=${half.after.ph.toFixed(4)} ` +
    `(V ${half.before.volumeL} -> ${half.after.volumeL} L)`,
);

// Scan from a fresh copy so the stored solution above is not swept to the end.
const { row: curveSol } = repo.createSolution({
  revisionId: rev.id,
  name: f.solution.name + '-curve',
  nAcid: f.solution.nAcid,
  nStrongAcid: f.solution.nStrongAcid,
  nStrongBase: f.solution.nStrongBase,
  volumeL: f.solution.volumeL,
  idempotencyKey: 'demo-curve',
});
const scan = svc.scan(curveSol.id, reagent.id, 2 * f.expected.equivalenceTitrantL, 40, 'demo-scan');
const ms = svc.maxSlope(scan.points);
console.log(
  `\ncoarse max-slope interval: V in [${ms.vLeft.toFixed(4)}, ${ms.vRight.toFixed(4)}] L, ` +
    `center=${ms.vCenter.toFixed(4)} L, |dpH/dV|=${ms.absSlope.toExponential(3)} /L`,
);
console.log(`NOTE: ${ms.note}`);
const refined = svc.refine(curveSol.id, reagent.id, { vLeft: ms.vLeft, vRight: ms.vRight }, 40);
console.log(`refined center = ${refined.result.vCenter.toFixed(5)} L (still a discrete estimate, not exact Veq)`);

const cmp = svc.compare(curveSol.id, f.ka, f.kw, 2 * f.ka, f.kw);
console.log(`\nparameter comparison Ka doubled: pH ${cmp.a.ph.toFixed(4)} -> ${cmp.b.ph.toFixed(4)} (Δ ${cmp.deltaPh.toFixed(4)})`);

const csvPath = join(root, 'data', 'demo-distribution.csv');
const rows = distributionRows(scan.points);
writeFileSync(csvPath, [Object.keys(rows[0]!).join(','), ...rows.map((r) => Object.values(r).join(','))].join('\n'));
console.log(`\nwrote species distribution: ${csvPath} (${rows.length} rows)`);
console.log(`demo database: ${dbPath}`);
db.close();
