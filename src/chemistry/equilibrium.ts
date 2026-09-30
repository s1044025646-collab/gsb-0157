import type {
  EquilibriumInput,
  EquilibriumResult,
} from './model.ts';
import {
  LOGH_MAX,
  LOGH_MIN,
  LOGH_TOL,
  MAX_BISECTION_ITERS,
  ModelDomainError,
  validateEquilibriumInput,
} from './model.ts';

/**
 * Charge-balance residual as a function of free [H+] = h:
 *
 *   [H+] + [Na+] = [OH-] + [A-] + [Cl-]
 *
 * with [Na+] = C_b (strong base cation), [Cl-] = C_a (strong-acid anion),
 * [OH-] = Kw / h and [A-] = Ct * Ka / (Ka + h). Hence
 *
 *   R(h) = h + C_b - Kw/h - [A-] - C_a  (cations h + C_b minus anions
 *   OH- + A- + C_a).
 *
 * Water auto-ionisation is always present. The Henderson-Hasselbalch
 * relation is never used as the equation being solved.
 */
export function residual(h: number, p: EquilibriumInput): number {
  const oh = p.kw / h;
  const aMinus = (p.ct * p.ka) / (p.ka + h);
  return h + p.strongBase - oh - aMinus - p.strongAcid;
}

/** Species distribution from a solved h. */
export function speciesAt(h: number, p: EquilibriumInput) {
  const oh = p.kw / h;
  const denom = p.ka + h;
  const aMinus = (p.ct * p.ka) / denom;
  const ha = (p.ct * h) / denom;
  return { oh, aMinus, ha, alpha0: h / denom, alpha1: p.ka / denom };
}

/**
 * Solve for [H+] by bisection in log10(h) over a fixed, chemically
 * meaningful bracket. R -> -Inf as h -> 0 (dominated by -Kw/h) and R -> +Inf
 * as h -> Inf (dominated by +h), so the bracket always straddles a root.
 * Log spacing keeps extreme dilution and strong-acid/strong-base limits
 * numerically well conditioned without clipping pH.
 */
export function solveEquilibrium(raw: Partial<EquilibriumInput>): EquilibriumResult {
  validateEquilibriumInput(raw as EquilibriumInput);
  const p = raw as EquilibriumInput;

  // R(h) is non-monotone for tiny h because the weak-acid moiety acts as a
  // base there, producing an extraneous "basic" root. The physically
  // meaningful root of an acid/base titration is the RIGHTMOST sign crossing
  // (largest h): adding acid can only raise [H+]. Locate it by a coarse log
  // sweep from the top, then bisect the bracketing cell.
  const grid = MAX_BISECTION_ITERS;
  let lo = LOGH_MIN;
  let hi = LOGH_MAX;
  let rLo = residual(10 ** lo, p);
  const rTop = residual(10 ** hi, p);
  let rHi = rTop;
  if (!(Number.isFinite(rLo) && Number.isFinite(rTop))) {
    throw new ModelDomainError('NON_FINITE_RESIDUAL', 'Charge residual became non-finite');
  }
  if (rLo >= 0 || rTop <= 0) {
    throw new ModelDomainError(
      'ROOT_BRACKET_FAILED',
      'Could not bracket a charge-balance root inside the supported pH domain',
    );
  }
  let prevLog = hi;
  let prevR = rTop;
  let found = false;
  for (let i = 1; i <= grid; i += 1) {
    const lg = hi - ((hi - LOGH_MIN) * i) / grid;
    const r = residual(10 ** lg, p);
    if (!Number.isFinite(r)) {
      throw new ModelDomainError('NON_FINITE_RESIDUAL', 'Charge residual became non-finite');
    }
    if (prevR * r <= 0) {
      // lg < prevLog; residual at lg (low log) is r, at prevLog is prevR.
      lo = lg;
      hi = prevLog;
      rLo = r;
      rHi = prevR;
      found = true;
      break;
    }
    prevLog = lg;
    prevR = r;
  }
  if (!found) {
    throw new ModelDomainError('ROOT_BRACKET_FAILED', 'No rightmost charge-balance root located');
  }

  let iterations = 0;
  let mid = (lo + hi) / 2;
  while (hi - lo > LOGH_TOL && iterations < MAX_BISECTION_ITERS) {
    mid = (lo + hi) / 2;
    const hMid = 10 ** mid;
    const rMid = residual(hMid, p);
    iterations += 1;
    if (!Number.isFinite(rMid)) {
      throw new ModelDomainError('NON_FINITE_RESIDUAL', 'Charge residual became non-finite');
    }
    if (rMid === 0) {
      lo = mid;
      hi = mid;
      break;
    }
    // Within the bracketing cell, residual increases with log(h): negative
    // at the low-log edge (lo), positive at the high-log edge (hi).
    if (rLo * rMid <= 0) {
      hi = mid;
      rHi = rMid;
    } else {
      lo = mid;
      rLo = rMid;
    }
  }

  const logH = (lo + hi) / 2;
  const h = 10 ** logH;
  const { oh, aMinus, ha, alpha0, alpha1 } = speciesAt(h, p);
  const remResidual = residual(h, p);
  const converged = hi - lo <= LOGH_TOL && Math.abs(remResidual) <= 1e-7 * Math.max(1, p.ct);

  return {
    h,
    oh,
    ph: -Math.log10(h),
    poh: -Math.log10(oh),
    aMinus,
    ha,
    alpha0,
    alpha1,
    ct: p.ct,
    strongAcid: p.strongAcid,
    strongBase: p.strongBase,
    residual: remResidual,
    iterations,
    converged,
  };
}

/**
 * Buffer-index-like local slope dpH / dV estimated from three points
 * (central finite difference). Used only for discrete max-slope location;
 * it is NOT an exact equivalence-volume calculation.
 */
export function centralSlope(
  left: { v: number; ph: number },
  center: { v: number; ph: number },
  right: { v: number; ph: number },
): number {
  const denom = right.v - left.v;
  if (denom <= 0) return 0;
  return (right.ph - left.ph) / denom;
}
