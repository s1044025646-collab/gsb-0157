import {
  addReagent,
  compareParams,
  distributionRows,
  findMaxSlope,
  refineMaxSlope,
  scanCurve,
  solveState,
} from './chemistry/titration.ts';
import type { CurvePoint, Reagent, SolutionState } from './chemistry/titration.ts';
import { ModelDomainError } from './chemistry/model.ts';
import type { ReagentRow, RevisionRow, SolutionRow } from './db/repository.ts';
import { Repository } from './db/repository.ts';

export function stateFromRow(s: SolutionRow): SolutionState {
  return {
    nAcid: s.n_acid,
    nStrongAcid: s.n_strong_acid,
    nStrongBase: s.n_strong_base,
    volumeL: s.volume_l,
  };
}

export function reagentFromRow(r: ReagentRow): Reagent {
  return {
    name: r.name,
    acidMoietyConc: r.acid_moiety_conc,
    strongAcidConc: r.strong_acid_conc,
    strongBaseConc: r.strong_base_conc,
  };
}

export function paramsFromRevision(r: RevisionRow) {
  return { ka: r.ka, kw: r.kw };
}

export class TitrationService {
  private repo: Repository;

  constructor(repo: Repository) {
    this.repo = repo;
  }

  private revisionFor(solution: SolutionRow): RevisionRow {
    return this.repo.getRevision(solution.revision_id);
  }

  equilibrium(solutionId: number) {
    const sol = this.repo.getSolution(solutionId);
    const rev = this.revisionFor(sol);
    const eq = solveState(stateFromRow(sol), paramsFromRevision(rev));
    return {
      solutionId: sol.id,
      revision: { code: rev.revision_code, ka: rev.ka, kw: rev.kw, frozen: true },
      state: stateFromRow(sol),
      equilibrium: eq,
    };
  }

  addTitrant(solutionId: number, reagentId: number | null, addedVolumeL: number) {
    const sol = this.repo.getSolution(solutionId);
    const rev = this.revisionFor(sol);
    let state = stateFromRow(sol);
    let reagent: Reagent = {
      name: 'pure-water',
      acidMoietyConc: 0,
      strongAcidConc: 0,
      strongBaseConc: 0,
    };
    if (reagentId !== null) {
      const rrow = this.repo.getReagent(reagentId);
      if (rrow.revision_id !== sol.revision_id) {
        throw new ModelDomainError(
          'REVISION_MISMATCH',
          'Reagent and solution must belong to the same frozen revision',
        );
      }
      reagent = reagentFromRow(rrow);
    }
    const before = solveState(state, paramsFromRevision(rev));
    state = addReagent(state, reagent, addedVolumeL);
    const after = solveState(state, paramsFromRevision(rev));
    const step = this.repo.addStep({
      solutionId,
      reagentId,
      addedVolumeL,
      nAcidAfter: state.nAcid,
      nStrongAcidAfter: state.nStrongAcid,
      nStrongBaseAfter: state.nStrongBase,
      volumeAfter: state.volumeL,
      phAfter: after.ph,
      residualAfter: after.residual,
      convergedAfter: after.converged,
    });
    return {
      before: { ph: before.ph, volumeL: before ? sol.volume_l : 0, residual: before.residual },
      after: { ph: after.ph, volumeL: state.volumeL, residual: after.residual },
      step,
    };
  }

  scan(
    solutionId: number,
    reagentId: number | null,
    totalTitrantL: number,
    steps: number,
    idempotencyKey?: string,
  ) {
    const sol = this.repo.getSolution(solutionId);
    const rev = this.revisionFor(sol);
    let reagent: Reagent = {
      name: 'pure-water',
      acidMoietyConc: 0,
      strongAcidConc: 0,
      strongBaseConc: 0,
    };
    if (reagentId !== null) reagent = reagentFromRow(this.repo.getReagent(reagentId));
    const points: CurvePoint[] = scanCurve(
      stateFromRow(sol),
      reagent,
      paramsFromRevision(rev),
      { totalTitrantL, steps },
    );
    const { runId, replayed } = this.repo.saveScanRun({
      solutionId,
      reagentId,
      revisionId: rev.id,
      totalTitrantL,
      steps,
      idempotencyKey,
      points,
    });
    return { runId, replayed, points };
  }

  maxSlope(points: CurvePoint[]) {
    return findMaxSlope(points);
  }

  refine(solutionId: number, reagentId: number | null, window: { vLeft: number; vRight: number }, subSteps: number) {
    const sol = this.repo.getSolution(solutionId);
    const rev = this.revisionFor(sol);
    let reagent: Reagent = {
      name: 'pure-water',
      acidMoietyConc: 0,
      strongAcidConc: 0,
      strongBaseConc: 0,
    };
    if (reagentId !== null) reagent = reagentFromRow(this.repo.getReagent(reagentId));
    return refineMaxSlope(
      stateFromRow(sol),
      reagent,
      paramsFromRevision(rev),
      window,
      subSteps,
    );
  }

  compare(solutionId: number, kaA: number, kwA: number, kaB: number, kwB: number) {
    const sol = this.repo.getSolution(solutionId);
    return compareParams(
      stateFromRow(sol),
      { label: 'A', ka: kaA, kw: kwA },
      { label: 'B', ka: kaB, kw: kwB },
    );
  }

  distribution(points: CurvePoint[]) {
    return distributionRows(points);
  }
}
