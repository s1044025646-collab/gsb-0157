import { resolve } from 'node:path';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { openDatabase, runMigrations } from '../db/database.ts';
import { Repository } from '../db/repository.ts';
import { TitrationService } from '../service.ts';
import { MODEL_ASSUMPTIONS } from '../chemistry/model.ts';
import { distributionRows } from '../chemistry/titration.ts';

function usage(): never {
  console.log(`weak-acid titration CLI

Usage:
  cli init-db
  cli revision <code> <ka> <kw> [note]
  cli reagent <revisionId> <name> <acidMoietyConc> <strongAcidConc> <strongBaseConc>
  cli solution <revisionId> <name> <nAcid> <nStrongAcid> <nStrongBase> <volumeL> [idempotencyKey]
  cli equilibrium <solutionId>
  cli titrate <solutionId> <reagentId|null> <volumeL>
  cli scan <solutionId> <reagentId|null> <totalTitrantL> <steps>
  cli max-slope <solutionId> <reagentId|null> <totalTitrantL> <steps>
  cli refine <solutionId> <reagentId|null> <vLeft> <vRight> [subSteps]
  cli compare <solutionId> <kaA> <kwA> <kaB> <kwB>
  cli export <solutionId> <reagentId|null> <totalTitrantL> <steps> <outCsv>
  cli assumptions

All amounts are mol, concentrations mol/L, volumes L. pH is never clipped.
`);
  process.exit(0);
}

function f(x: number, digits = 6): string {
  return Number.isFinite(x) ? x.toFixed(digits) : String(x);
}

function num(x: string): number {
  const v = Number(x);
  if (!Number.isFinite(v)) throw new Error(`Not a number: ${x}`);
  return v;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') usage();

  const root = resolve(process.cwd());
  const db = openDatabase(join(root, 'data', 'app.sqlite'));
  runMigrations(db);
  const repo = new Repository(db);
  const svc = new TitrationService(repo);

  switch (cmd) {
    case 'init-db':
      console.log('[ok] migrations applied (idempotent)');
      break;

    case 'revision': {
      const [code, ka, kw, ...note] = args;
      const rev = repo.createRevision({
        revisionCode: code!,
        ka: num(ka!),
        kw: num(kw!),
        note: note.join(' '),
      });
      console.log(`[ok] frozen revision #${rev.id} ${rev.revision_code} Ka=${rev.ka} Kw=${rev.kw}`);
      break;
    }

    case 'reagent': {
      const [rid, name, ac, sa, sb] = args;
      const r = repo.createReagent({
        revisionId: num(rid!),
        name: name!,
        acidMoietyConc: num(ac!),
        strongAcidConc: num(sa!),
        strongBaseConc: num(sb!),
      });
      console.log(`[ok] reagent #${r.id} ${r.name}`);
      break;
    }

    case 'solution': {
      const [rid, name, na, sa, sb, v, key] = args;
      const { row, replayed } = repo.createSolution({
        revisionId: num(rid!),
        name: name!,
        nAcid: num(na!),
        nStrongAcid: num(sa!),
        nStrongBase: num(sb!),
        volumeL: num(v!),
        idempotencyKey: key,
      });
      console.log(
        `[${replayed ? 'replayed' : 'created'}] solution #${row.id} ${row.name} V=${f(row.volume_l, 4)} L`,
      );
      break;
    }

    case 'equilibrium': {
      const out = svc.equilibrium(num(args[0]!));
      const e = out.equilibrium;
      console.log(`solution #${out.solutionId} (revision ${out.revision.code}, Ka/Kw frozen)`);
      console.log(
        `  Ct=${f(e.ct)} M  strongAcid=${f(e.strongAcid)} M  strongBase=${f(e.strongBase)} M`,
      );
      console.log(`  pH=${f(e.ph)}  pOH=${f(e.poh)}  [H+]=${e.h.toExponential(4)}  [OH-]=${e.oh.toExponential(4)}`);
      console.log(
        `  HA=${f(e.ha)} (alpha0=${f(e.alpha0, 5)})  A-=${f(e.aMinus)} (alpha1=${f(e.alpha1, 5)})`,
      );
      console.log(`  residual=${e.residual.toExponential(3)} converged=${e.converged} iters=${e.iterations}`);
      break;
    }

    case 'titrate': {
      const [sid, rid, v] = args;
      const out = svc.addTitrant(num(sid!), rid === 'null' ? null : num(rid!), num(v!));
      console.log('BEFORE:', `V=${f(out.before.volumeL, 5)} L pH=${f(out.before.ph)} residual=${out.before.residual.toExponential(2)}`);
      console.log(`added ${f(num(v!), 5)} L`);
      console.log('AFTER :', `V=${f(out.after.volumeL, 5)} L pH=${f(out.after.ph)} residual=${out.after.residual.toExponential(2)}`);
      break;
    }

    case 'scan':
    case 'max-slope': {
      const [sid, rid, total, stepsStr] = args;
      const out = svc.scan(
        num(sid!),
        rid === 'null' ? null : num(rid!),
        num(total!),
        num(stepsStr!),
      );
      if (cmd === 'scan') {
        for (const p of out.points) {
          console.log(
            `step=${String(p.step).padStart(3)} Vadd=${f(p.addedVolumeL, 5)} Vtot=${f(p.totalVolumeL, 5)} pH=${f(p.ph)}`,
          );
        }
      } else {
        const ms = svc.maxSlope(out.points);
        console.log(`max |dpH/dV| interval V in [${f(ms.vLeft, 5)}, ${f(ms.vRight, 5)}] L`);
        console.log(`center=${f(ms.vCenter, 6)} L slope=${ms.absSlope.toExponential(4)} /L (${ms.direction})`);
        console.log(`NOTE: ${ms.note}`);
      }
      console.log(`run #${out.runId}${out.replayed ? ' (replayed)' : ''}`);
      break;
    }

    case 'refine': {
      const [sid, rid, vl, vr, sub] = args;
      const out = svc.refine(
        num(sid!),
        rid === 'null' ? null : num(rid!),
        { vLeft: num(vl!), vRight: num(vr!) },
        sub ? num(sub) : 20,
      );
      console.log(`refined center=${f(out.result.vCenter, 7)} L slope=${out.result.absSlope.toExponential(4)} /L`);
      console.log(`NOTE: ${out.result.note}`);
      break;
    }

    case 'compare': {
      const [sid, kaA, kwA, kaB, kwB] = args;
      const out = svc.compare(num(sid!), num(kaA!), num(kwA!), num(kaB!), num(kwB!));
      console.log(`A Ka=${out.a.ka} Kw=${out.a.kw} -> pH=${f(out.a.ph)}`);
      console.log(`B Ka=${out.b.ka} Kw=${out.b.kw} -> pH=${f(out.b.ph)}`);
      console.log(`delta pH (B-A) = ${f(out.deltaPh)}`);
      break;
    }

    case 'export': {
      const [sid, rid, total, stepsStr, outPath] = args;
      const out = svc.scan(num(sid!), rid === 'null' ? null : num(rid!), num(total!), num(stepsStr!));
      const rows = distributionRows(out.points);
      const header = Object.keys(rows[0]!).join(',');
      const csv = [header, ...rows.map((r) => Object.values(r).join(','))].join('\n');
      writeFileSync(resolve(outPath!), csv);
      console.log(`[ok] wrote ${rows.length} rows to ${outPath}`);
      break;
    }

    case 'assumptions':
      MODEL_ASSUMPTIONS.forEach((a, i) => console.log(`${i + 1}. ${a}`));
      break;

    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
  }
  db.close();
}

main().catch((err) => {
  console.error(`[error] ${err.code ?? 'ERROR'}: ${err.message}`);
  process.exit(1);
});
