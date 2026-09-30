import type { Reagent } from './titration.ts';

/**
 * Pedagogical, FICTIONAL example solutions/reagents. Names and constants
 * are chosen for teaching, not as certified real-world preparation
 * instructions. All values are molar (mol/L) at the frozen model constants.
 */
export interface TeachingFixture {
  key: string;
  description: string;
  ka: number;
  kw: number;
  solution: {
    name: string;
    /** Initial amounts (mol) and volume (L). */
    nAcid: number;
    nStrongAcid: number;
    nStrongBase: number;
    volumeL: number;
  };
  titrant: Reagent;
  /** Expected qualitative landmarks for test cross-checks. */
  expected: {
    initialPhApprox: number;
    halfEquivalenceTitrantL: number;
    equivalenceTitrantL: number;
    equivalencePhIsBasic: boolean;
  };
}

export const FIXTURES: TeachingFixture[] = [
  {
    key: 'demo-acetoid',
    description:
      'Fictional weak acid "acetoid" (Ka=1.8e-5) 0.100 M in 1.000 L, titrated by 0.100 M strong base.',
    ka: 1.8e-5,
    kw: 1e-14,
    solution: {
      name: 'acetoid-0p100M-1L',
      nAcid: 0.1,
      nStrongAcid: 0,
      nStrongBase: 0,
      volumeL: 1,
    },
    titrant: { name: 'strong-base-0p100M', acidMoietyConc: 0, strongAcidConc: 0, strongBaseConc: 0.1 },
    expected: {
      initialPhApprox: 2.88,
      halfEquivalenceTitrantL: 0.5,
      equivalenceTitrantL: 1.0,
      equivalencePhIsBasic: true,
    },
  },
  {
    key: 'demo-dilute',
    description:
      'Same fictional acid but 1.00 mM in 0.100 L (extreme-dilution regime where water matters), 0.010 M base.',
    ka: 1.8e-5,
    kw: 1e-14,
    solution: {
      name: 'acetoid-1mM-100mL',
      nAcid: 0.001 * 0.1,
      nStrongAcid: 0,
      nStrongBase: 0,
      volumeL: 0.1,
    },
    titrant: { name: 'strong-base-0p010M', acidMoietyConc: 0, strongAcidConc: 0, strongBaseConc: 0.01 },
    expected: {
      initialPhApprox: 5.14,
      halfEquivalenceTitrantL: 0.005,
      equivalenceTitrantL: 0.01,
      equivalencePhIsBasic: true,
    },
  },
];

export function getFixture(key: string): TeachingFixture {
  const f = FIXTURES.find((x) => x.key === key);
  if (!f) throw new Error(`Unknown fixture ${key}`);
  return f;
}
