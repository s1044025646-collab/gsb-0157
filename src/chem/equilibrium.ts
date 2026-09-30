/**
 * Equilibrium core for a single monoprotic weak acid HA / conjugate base A-
 * in an ideal dilute aqueous solution, optionally mixed with strong acid
 * (HX) and/or strong base (MOH).
 *
 * Model (no Henderson-Hasselbalch approximation is ever used):
 *   HA  <=> H+ + A-        Ka = h * a / [HA]
 *   H2O <=> H+ + OH-       Kw = h * oh
 *   acid mass balance:     [HA] + a = cT          (analytical acid-family total)
 *   charge balance:        h + cCat = oh + a + cAn
 * where cCat/cAn are spectator ions from the conjugate-base salt, strong
 * acid and strong base.  Define S = cCat - cAn (net strong-base-equivalent
 * spectator charge, mol/L).  Then
 *   a   = Ka * cT / (Ka + h)
 *   oh  = Kw / h
 *   f(h) = h + S - Kw/h - Ka*cT/(Ka+h) = 0
 * f is strictly increasing (f' > 0), so a unique positive root always exists
 * for physically admissible inputs.  We solve x = log10(h) with bounded
 * bisection, which is overflow-safe for arbitrarily dilute solutions.
 */

export interface SpeciesMoles {
  /** Analytical moles of the weak acid family added as HA. */
  nHA: number;
  /** Moles added as the conjugate-base salt (e.g. NaA); counter-ion tracked. */
  nA: number;
  /** Moles of strong monoprotic acid (e.g. HCl): contributes H+ + X-. */
  nStrongAcid: number;
  /** Moles of strong monohydroxy base (e.g. NaOH): contributes M+ + OH-. */
  nStrongBase: number;
}

export interface EquilibriumParams extends SpeciesMoles {
  /** Total mixed volume in litres (strictly positive). */
  volume: number;
  /** Acid dissociation constant, must be > 0 (mol/L). */
  Ka: number;
  /** Water autoionization constant, must be > 0 (mol/L)^2. */
  Kw: number;
}

export interface Speciation {
  h: number;
  oh: number;
  HA: number;
  A: number;
  pH: number;
  pOH: number;
  /** Fraction of acid family present as A-. */
  alphaA: number;
  /** Fraction of acid family present as HA. */
  alphaHA: number;
}

export interface EquilibriumResult extends Speciation {
  /** Analytical total acid-family concentration, mol/L. */
  cTotal: number;
  /** Spectator cation concentration (NaA salt + strong base), mol/L. */
  cCation: number;
  /** Spectator anion concentration (strong acid), mol/L. */
  cAnion: number;
  /** Net spectator charge S = cCation - cAnion, mol/L. */
  sNet: number;
  /**
   * Charge-balance residual in concentration units at the reported root:
   * (oh + A- + cAnion) - (h + cCation). 0 means exact balance.
   */
  chargeResidual: number;
  /** |residual| normalised by total charged species; scale-independent. */
  normalizedResidual: number;
  /** Value of the root function f(h) at the reported root (mol/L). */
  rootResidual: number;
  iterations: number;
  converged: boolean;
  /** Bracket [log10 h] that contains the root at termination. */
  bracketLogH: [number, number];
  /** Model/constant fingerprint frozen into reports. */
  Ka: number;
  Kw: number;
  volume: number;
}

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NON_FINITE"
  | "NEGATIVE_AMOUNT"
  | "NON_POSITIVE_VOLUME"
  | "NON_POSITIVE_CONSTANT"
  | "MODEL_OUT_OF_RANGE"
  | "NO_ROOT_IN_DOMAIN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_MISMATCH"
  | "SCHEME_REVISED"
  | "INVALID_PAGINATION";

export class ChemistryError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ChemistryError";
    this.code = code;
    this.details = details;
  }
}

/** Model domain limits — see README "Model assumptions". */
export const MODEL_LIMITS = {
  /** Ideal-dilute regime: analytical concentration ceiling, mol/L. */
  maxConcentration: 1.0,
  minVolume: 1e-9,
  maxVolume: 1e6,
  /** Weak-acid regime: Ka must not reach/enter strong-acid behaviour. */
  maxKa: 1.0,
  /** Kw is constrained to an aqueous, non-concentrated regime. */
  maxKw: 1e-6,
} as const;

const LOG_H_LOW = -20; // h = 1e-20 mol/L (pH 20)
const LOG_H_HIGH = 8; //  h = 1e8 mol/L — physically absurd guard
const MAX_ITERATIONS = 200;
const X_TOLERANCE = 1e-14;

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ChemistryError(
      "NON_FINITE",
      `Field '${field}' must be a finite number`,
      { field, received: String(value) },
    );
  }
  return value;
}

/** Validate constants and amounts; enforce the ideal-dilute model domain. */
export function validateParams(p: EquilibriumParams): void {
  const nHA = finiteNumber(p.nHA, "nHA");
  const nA = finiteNumber(p.nA, "nA");
  const nStrongAcid = finiteNumber(p.nStrongAcid, "nStrongAcid");
  const nStrongBase = finiteNumber(p.nStrongBase, "nStrongBase");
  const volume = finiteNumber(p.volume, "volume");
  const Ka = finiteNumber(p.Ka, "Ka");
  const Kw = finiteNumber(p.Kw, "Kw");

  for (const [name, v] of [
    ["nHA", nHA],
    ["nA", nA],
    ["nStrongAcid", nStrongAcid],
    ["nStrongBase", nStrongBase],
  ] as const) {
    if (v < 0) {
      throw new ChemistryError("NEGATIVE_AMOUNT", `Field '${name}' must be >= 0`, {
        field: name,
        received: v,
      });
    }
  }
  if (volume <= 0) {
    throw new ChemistryError(
      "NON_POSITIVE_VOLUME",
      "Field 'volume' must be strictly positive (L)",
      { received: volume },
    );
  }
  if (Ka <= 0 || Kw <= 0) {
    throw new ChemistryError(
      "NON_POSITIVE_CONSTANT",
      "Ka and Kw must be strictly positive",
      { Ka, Kw },
    );
  }
  if (volume < MODEL_LIMITS.minVolume || volume > MODEL_LIMITS.maxVolume) {
    throw new ChemistryError("MODEL_OUT_OF_RANGE", "Volume outside model domain", {
      volume,
      allowed: [MODEL_LIMITS.minVolume, MODEL_LIMITS.maxVolume],
    });
  }
  if (Ka > MODEL_LIMITS.maxKa) {
    throw new ChemistryError(
      "MODEL_OUT_OF_RANGE",
      "Ka exceeds the weak-acid regime of this model",
      { Ka, maxKa: MODEL_LIMITS.maxKa },
    );
  }
  if (Kw > MODEL_LIMITS.maxKw) {
    throw new ChemistryError("MODEL_OUT_OF_RANGE", "Kw outside the aqueous model domain", {
      Kw,
      maxKw: MODEL_LIMITS.maxKw,
    });
  }

  const checks: Array<[string, number]> = [
    ["acid-family total", nHA + nA],
    ["strong acid", nStrongAcid],
    ["strong base", nStrongBase],
  ];
  for (const [label, n] of checks) {
    const c = n / volume;
    if (c > MODEL_LIMITS.maxConcentration * (1 + 1e-12)) {
      throw new ChemistryError(
        "MODEL_OUT_OF_RANGE",
        `${label} concentration ${c.toExponential(3)} mol/L exceeds ideal-dilute ceiling`,
        { concentration: c, maxConcentration: MODEL_LIMITS.maxConcentration },
      );
    }
  }
}

/** Root function f(h); all arithmetic uses h directly (x only for bracketing). */
function rootFunction(h: number, cTotal: number, sNet: number, Ka: number, Kw: number): number {
  return h + sNet - Kw / h - (Ka * cTotal) / (Ka + h);
}

/**
 * Solve the equilibrium. Bounded bisection on x = log10 h.
 * pH is never clipped: extreme dilute/concentrated cases may yield pH
 * outside [0, 14]; inputs beyond the declared domain are rejected instead.
 */
export function solveEquilibrium(p: EquilibriumParams): EquilibriumResult {
  validateParams(p);

  const cTotal = (p.nHA + p.nA) / p.volume;
  const cCation = (p.nA + p.nStrongBase) / p.volume;
  const cAnion = p.nStrongAcid / p.volume;
  const sNet = cCation - cAnion;
  const { Ka, Kw } = p;

  let lo = LOG_H_LOW;
  let hi = LOG_H_HIGH;
  let fLo = rootFunction(10 ** lo, cTotal, sNet, Ka, Kw);
  let fHi = rootFunction(10 ** hi, cTotal, sNet, Ka, Kw);

  if (!(fLo < 0) || !(fHi > 0)) {
    throw new ChemistryError(
      "NO_ROOT_IN_DOMAIN",
      "No equilibrium root inside the numerical domain; input outside model range",
      { fLo, fHi, bracket: [lo, hi] },
    );
  }

  let iterations = 0;
  let mid = 0;
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    iterations = i;
    mid = (lo + hi) / 2;
    if (hi - lo <= X_TOLERANCE) break;
    const fMid = rootFunction(10 ** mid, cTotal, sNet, Ka, Kw);
    if (fMid === 0) {
      lo = mid;
      hi = mid;
      break;
    }
    if (fMid < 0) lo = mid;
    else hi = mid;
  }

  const logH = (lo + hi) / 2;
  const h = 10 ** logH;
  const oh = Kw / h;
  const A = cTotal > 0 ? (Ka * cTotal) / (Ka + h) : 0;
  const HA = cTotal - A;

  const rootResidual = rootFunction(h, cTotal, sNet, Ka, Kw);
  // Charge balance: (h + cCation) - (oh + A + cAnion) == f(h) == 0.
  const lhs = h + cCation;
  const rhs = oh + A + cAnion;
  const chargeResidual = rhs - lhs;
  const scale = Math.max(h, oh, A, cCation, cAnion, 1e-30);
  const normalizedResidual = Math.abs(chargeResidual) / scale;
  const converged =
    hi - lo <= X_TOLERANCE * 2 &&
    normalizedResidual < 1e-9 &&
    Math.abs(rootResidual) / scale < 1e-9;

  return {
    h,
    oh,
    HA,
    A,
    pH: -Math.log10(h),
    pOH: -Math.log10(oh),
    alphaA: cTotal > 0 ? A / cTotal : 0,
    alphaHA: cTotal > 0 ? HA / cTotal : 0,
    cTotal,
    cCation,
    cAnion,
    sNet,
    chargeResidual,
    normalizedResidual,
    rootResidual,
    iterations,
    converged,
    bracketLogH: [lo, hi],
    Ka,
    Kw,
    volume: p.volume,
  };
}

/** Convenience: solve straight from post-mix concentrations (used by curves). */
export function solveFromConcentrations(
  volume: number,
  cTotal: number,
  sNet: number,
  Ka: number,
  Kw: number,
): EquilibriumResult {
  return solveEquilibrium({
    nHA: Math.max(cTotal - Math.max(sNet, 0), 0) * volume,
    nA: Math.max(sNet, 0) * volume,
    nStrongAcid: Math.max(-sNet, 0) * volume,
    nStrongBase: 0,
    volume,
    Ka,
    Kw,
  });
}
