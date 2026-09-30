/**
 * Model definition, frozen constants, parameter validation and assumptions
 * for a single monoprotic weak acid / conjugate-base system in an ideal
 * dilute aqueous solution.
 */

export const MODEL_NAME = 'ideal-dilute-monoprotic';
export const CURRENT_MODEL_VERSION = 1;

/**
 * Domain of the log10(H+) bracket used by the bounded root finder.
 * h = 10^LOGH_MIN is effectively zero chemically; 10^LOGH_MAX = 10 M
 * is far beyond the ideal-solution regime and acts as a hard guard rail.
 */
export const LOGH_MIN = -30;
export const LOGH_MAX = 1;

/** Root-finder tolerances. */
export const LOGH_TOL = 1e-12;
export const MAX_BISECTION_ITERS = 240;

/**
 * Ideal dilute-solution validity limits (mol/L for concentrations, L for
 * volume). Outside these the model refuses to report a pH rather than
 * extrapolate.
 */
export const LIMITS = {
  maxAnalyticalConc: 1.0, // above ~1 M, activity coefficients cannot be ignored
  maxIonicStrength: 2.0,
  minVolumeL: 1e-9,
  maxVolumeL: 1e4,
  maxKa: 1.0, // Ka >= 1 means the acid is effectively strong, out of weak-acid scope
  minKa: 1e-14,
  maxKw: 1e-10,
  minKw: 1e-17,
} as const;

export interface EquilibriumInput {
  /** Analytical (total) acid+conjugate-base concentration C_t in mol/L. */
  ct: number;
  /** Strong acid proton-equivalent concentration C_a in mol/L (>= 0). */
  strongAcid: number;
  /** Strong base hydroxide-equivalent concentration C_b in mol/L (>= 0). */
  strongBase: number;
  /** Acid dissociation constant Ka (mol/L scale), > 0. */
  ka: number;
  /** Water auto-ionisation constant Kw (mol/L)^2, > 0. */
  kw: number;
}

export interface EquilibriumResult {
  h: number;
  oh: number;
  ph: number;
  poh: number;
  aMinus: number;
  ha: number;
  alpha0: number;
  alpha1: number;
  ct: number;
  strongAcid: number;
  strongBase: number;
  residual: number;
  iterations: number;
  converged: boolean;
}

export class ModelDomainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ModelDomainError';
    this.code = code;
  }
}

function isFiniteNonNeg(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

/**
 * Validate equilibrium parameters. Ka and Kw MUST be strictly positive.
 * Throws ModelDomainError with a stable machine-readable code.
 */
export function validateEquilibriumInput(p: Partial<EquilibriumInput>): void {
  const numKeys: (keyof EquilibriumInput)[] = [
    'ct',
    'strongAcid',
    'strongBase',
    'ka',
    'kw',
  ];
  for (const key of numKeys) {
    const v = p[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new ModelDomainError('NON_FINITE_PARAMETER', `Parameter ${key} must be a finite number`);
    }
  }
  const { ct, strongAcid, strongBase, ka, kw } = p as EquilibriumInput;
  for (const [key, v] of [
    ['ct', ct],
    ['strongAcid', strongAcid],
    ['strongBase', strongBase],
  ] as const) {
    if (!isFiniteNonNeg(v)) {
      throw new ModelDomainError('NEGATIVE_CONCENTRATION', `Concentration ${key} must be >= 0`);
    }
  }
  if (ka <= 0) {
    throw new ModelDomainError('NON_POSITIVE_KA', 'Ka must be strictly positive');
  }
  if (kw <= 0) {
    throw new ModelDomainError('NON_POSITIVE_KW', 'Kw must be strictly positive');
  }
  if (ka < LIMITS.minKa || ka > LIMITS.maxKa) {
    throw new ModelDomainError(
      'KA_OUT_OF_RANGE',
      `Ka=${ka} lies outside supported weak-acid interval [${LIMITS.minKa}, ${LIMITS.maxKa}]`,
    );
  }
  if (kw < LIMITS.minKw || kw > LIMITS.maxKw) {
    throw new ModelDomainError(
      'KW_OUT_OF_RANGE',
      `Kw=${kw} lies outside supported interval [${LIMITS.minKw}, ${LIMITS.maxKw}]`,
    );
  }
  const maxConc = Math.max(ct, strongAcid, strongBase);
  if (maxConc > LIMITS.maxAnalyticalConc) {
    throw new ModelDomainError(
      'CONCENTRATION_TOO_HIGH',
      `Analytical concentration ${maxConc} M exceeds ideal-dilute limit ${LIMITS.maxAnalyticalConc} M`,
    );
  }
  const ionic = strongAcid + strongBase + Math.min(ct, 1);
  if (ionic > LIMITS.maxIonicStrength) {
    throw new ModelDomainError(
      'IONIC_STRENGTH_TOO_HIGH',
      `Estimated ionic strength ${ionic} M exceeds limit ${LIMITS.maxIonicStrength} M`,
    );
  }
}

export function validateVolume(v: number): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ModelDomainError('NON_FINITE_VOLUME', 'Volume must be a finite number');
  }
  if (v < 0) {
    throw new ModelDomainError('NEGATIVE_VOLUME', `Volume ${v} L must be >= 0`);
  }
  if (v > 0 && v < LIMITS.minVolumeL) {
    throw new ModelDomainError('VOLUME_TOO_SMALL', `Volume ${v} L is below ${LIMITS.minVolumeL} L`);
  }
  if (v > LIMITS.maxVolumeL) {
    throw new ModelDomainError('VOLUME_TOO_LARGE', `Volume ${v} L is above ${LIMITS.maxVolumeL} L`);
  }
}

export const MODEL_ASSUMPTIONS: string[] = [
  'Ideal dilute aqueous solution: activities approximated by molar concentrations, activity coefficients = 1.',
  'Exactly one monoprotic weak acid HA and its conjugate base A- are tracked; no other equilibria.',
  'No chemical equation balancing is performed; analytical amounts are supplied directly.',
  'Strong acid and strong base are assumed fully dissociated; their counter-ions enter charge balance only.',
  'Water auto-ionisation (Kw) is always retained; Henderson-Hasselbalch is never used as the solver.',
  'Mixing is instantaneous and volumes are additive; concentrations recomputed from total moles and total volume.',
  'pH is reported from the solved free H+ and is never clipped to [0, 14].',
];
