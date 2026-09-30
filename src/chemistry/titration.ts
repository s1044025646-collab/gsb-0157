import { solveEquilibrium } from './equilibrium.ts';
import type {
  EquilibriumResult,
} from './model.ts';
import {
  ModelDomainError,
  validateVolume,
} from './model.ts';

/**
 * A solution is described entirely by conserved MOLE amounts and total
 * volume. Concentrations are derived at solve time, so mixing/dilution
 * always recomputes from the pooled moles over the pooled volume.
 */
export interface SolutionState {
  nAcid: number; // moles of the HA/A- weak-acid moiety (conserved)
  nStrongAcid: number; // moles of fully-dissociated strong-acid equivalents
  nStrongBase: number; // moles of fully-dissociated strong-base equivalents
  volumeL: number; // total volume (additive mixing)
}

export interface Reagent {
  name: string;
  /** Moles per litre contributed by 1 L of reagent for each bookkeeping pool. */
  acidMoietyConc: number;
  strongAcidConc: number;
  strongBaseConc: number;
}

export interface CurvePoint {
  step: number;
  addedVolumeL: number; // titrant volume beyond the scan start
  totalVolumeL: number;
  ct: number;
  strongAcid: number;
  strongBase: number;
  ph: number;
  h: number;
  oh: number;
  ha: number;
  aMinus: number;
  alpha0: number;
  alpha1: number;
  residual: number;
  converged: boolean;
}

export function zeroState(volumeL = 0): SolutionState {
  return { nAcid: 0, nStrongAcid: 0, nStrongBase: 0, volumeL };
}

export function addMoles(
  state: SolutionState,
  q: { nAcid?: number; nStrongAcid?: number; nStrongBase?: number },
): SolutionState {
  return {
    nAcid: state.nAcid + (q.nAcid ?? 0),
    nStrongAcid: state.nStrongAcid + (q.nStrongAcid ?? 0),
    nStrongBase: state.nStrongBase + (q.nStrongBase ?? 0),
    volumeL: state.volumeL,
  };
}

/** Mix in a volume of a reagent. Volumes are additive. */
export function addReagent(state: SolutionState, reagent: Reagent, volumeL: number): SolutionState {
  validateVolume(volumeL);
  if (volumeL === 0) return state;
  return {
    nAcid: state.nAcid + reagent.acidMoietyConc * volumeL,
    nStrongAcid: state.nStrongAcid + reagent.strongAcidConc * volumeL,
    nStrongBase: state.nStrongBase + reagent.strongBaseConc * volumeL,
    volumeL: state.volumeL + volumeL,
  };
}

export interface ModelParams {
  ka: number;
  kw: number;
}

export function concentrations(state: SolutionState) {
  if (state.volumeL <= 0) {
    throw new ModelDomainError('EMPTY_VOLUME', 'Cannot solve equilibrium at zero total volume');
  }
  return {
    ct: state.nAcid / state.volumeL,
    strongAcid: state.nStrongAcid / state.volumeL,
    strongBase: state.nStrongBase / state.volumeL,
  };
}

export function solveState(state: SolutionState, params: ModelParams): EquilibriumResult {
  const c = concentrations(state);
  return solveEquilibrium({ ...c, ka: params.ka, kw: params.kw });
}

export interface ScanOptions {
  /** Total titrant volume to add over the scan, in L. */
  totalTitrantL: number;
  /** Number of increments (produces steps+1 points). */
  steps: number;
}

/**
 * Scan a titration curve by repeatedly adding equal volumes of reagent.
 * Pure: does not mutate the starting state.
 */
export function scanCurve(
  start: SolutionState,
  reagent: Reagent,
  params: ModelParams,
  opts: ScanOptions,
): CurvePoint[] {
  validateVolume(opts.totalTitrantL);
  if (!Number.isInteger(opts.steps) || opts.steps < 2) {
    throw new ModelDomainError('BAD_STEP_COUNT', 'steps must be an integer >= 2');
  }
  const points: CurvePoint[] = [];
  const dv = opts.totalTitrantL / opts.steps;
  let current = start;
  for (let i = 0; i <= opts.steps; i += 1) {
    const added = dv * i;
    current =
      i === 0
        ? start
        : {
            nAcid: start.nAcid + reagent.acidMoietyConc * added,
            nStrongAcid: start.nStrongAcid + reagent.strongAcidConc * added,
            nStrongBase: start.nStrongBase + reagent.strongBaseConc * added,
            volumeL: start.volumeL + added,
          };
    const c = concentrations(current);
    const eq = solveEquilibrium({ ...c, ka: params.ka, kw: params.kw });
    points.push({
      step: i,
      addedVolumeL: added,
      totalVolumeL: current.volumeL,
      ...c,
      ph: eq.ph,
      h: eq.h,
      oh: eq.oh,
      ha: eq.ha,
      aMinus: eq.aMinus,
      alpha0: eq.alpha0,
      alpha1: eq.alpha1,
      residual: eq.residual,
      converged: eq.converged,
    });
  }
  return points;
}

export interface MaxSlopeResult {
  /** Interval [vLeft, vRight] bracketing the discrete maximum |dpH/dV|. */
  vLeft: number;
  vRight: number;
  vCenter: number;
  slope: number;
  absSlope: number;
  direction: 'up' | 'down';
  /** Explicit disclaimer: this is a sampling estimate, not an equivalence V. */
  note: string;
}

/**
 * Locate the maximum |dpH/dV| over discrete samples using central
 * differences. The result is a sampling estimate of the steepest sampled
 * interval and must never be reported as an exact chemical equivalence
 * volume.
 */
export function findMaxSlope(points: CurvePoint[]): MaxSlopeResult {
  if (points.length < 3) {
    throw new ModelDomainError('NOT_ENOUGH_POINTS', 'Need at least 3 curve points for slope estimation');
  }
  let best = 1;
  let bestSlope = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const left = points[i - 1]!;
    const center = points[i]!;
    const right = points[i + 1]!;
    const slope = (right.ph - left.ph) / (right.addedVolumeL - left.addedVolumeL);
    if (Math.abs(slope) > Math.abs(bestSlope)) {
      bestSlope = slope;
      best = i;
    }
  }
  const left = points[best - 1]!;
  const center = points[best]!;
  const right = points[best + 1]!;
  return {
    vLeft: left.addedVolumeL,
    vRight: right.addedVolumeL,
    vCenter: center.addedVolumeL,
    slope: bestSlope,
    absSlope: Math.abs(bestSlope),
    direction: bestSlope >= 0 ? 'up' : 'down',
    note:
      'Discrete central-difference estimate from sampled points; not an exact equivalence volume.',
  };
}

/**
 * Refine the max-slope interval by re-scanning only the bracketing window
 * with a finer uniform grid. Returns the refined estimate alongside the
 * refined points so callers can iterate or inspect convergence.
 */
export function refineMaxSlope(
  start: SolutionState,
  reagent: Reagent,
  params: ModelParams,
  window: { vLeft: number; vRight: number },
  subSteps = 20,
): { result: MaxSlopeResult; points: CurvePoint[] } {
  const width = window.vRight - window.vLeft;
  if (!(width > 0)) {
    throw new ModelDomainError('BAD_WINDOW', 'Refinement window must have positive width');
  }
  const shifted = addReagent(start, reagent, window.vLeft);
  const points = scanCurve(shifted, reagent, params, {
    totalTitrantL: width,
    steps: subSteps,
  }).map((p) => ({ ...p, addedVolumeL: p.addedVolumeL + window.vLeft }));
  return { result: findMaxSlope(points), points };
}

/** Solve two parameter sets over the same state for parameter comparison. */
export function compareParams(
  state: SolutionState,
  a: ModelParams & { label: string },
  b: ModelParams & { label: string },
) {
  const ea = solveState(state, { ka: a.ka, kw: a.kw });
  const eb = solveState(state, { ka: b.ka, kw: b.kw });
  return {
    a: { label: a.label, ka: a.ka, kw: a.kw, ph: ea.ph, residual: ea.residual, converged: ea.converged },
    b: { label: b.label, ka: b.ka, kw: b.kw, ph: eb.ph, residual: eb.residual, converged: eb.converged },
    deltaPh: eb.ph - ea.ph,
  };
}

/** Fractional species distribution over a curve (export helper). */
export function distributionRows(points: CurvePoint[]) {
  return points.map((p) => ({
    step: p.step,
    addedVolumeL: p.addedVolumeL,
    totalVolumeL: p.totalVolumeL,
    ph: p.ph,
    ct: p.ct,
    ha: p.ha,
    aMinus: p.aMinus,
    alphaHA: p.alpha0,
    alphaA: p.alpha1,
    oh: p.oh,
    h: p.h,
  }));
}
