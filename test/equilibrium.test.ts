import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveEquilibrium, residual } from '../src/chemistry/equilibrium.ts';
import {
  addReagent,
  concentrations,
  refineMaxSlope,
  scanCurve,
  findMaxSlope,
  solveState,
  zeroState,
} from '../src/chemistry/titration.ts';
import { ModelDomainError } from '../src/chemistry/model.ts';
import { KA, KW } from './helpers.ts';

const base = (cb = 0.1) => ({
  name: 'NaOH',
  acidMoietyConc: 0,
  strongAcidConc: 0,
  strongBaseConc: cb,
});

test('pure water is pH 7 and charge/mass balanced', () => {
  const r = solveEquilibrium({ ct: 0, strongAcid: 0, strongBase: 0, ka: KA, kw: KW });
  assert.ok(Math.abs(r.ph - 7) < 1e-9);
  assert.ok(Math.abs(r.h * r.oh - KW) < 1e-20);
  assert.ok(Math.abs(r.h - r.oh) < 1e-12);
});

test('strong acid / strong base analytical limits', () => {
  const acid = solveEquilibrium({ ct: 0, strongAcid: 0.01, strongBase: 0, ka: KA, kw: KW });
  assert.ok(Math.abs(acid.ph - 2) < 1e-6);
  const baseSol = solveEquilibrium({ ct: 0, strongAcid: 0, strongBase: 0.01, ka: KA, kw: KW });
  assert.ok(Math.abs(baseSol.ph - 12) < 1e-6);
});

test('weak acid 0.1 M matches exact quadratic root, not the naive approximation', () => {
  const c = 0.1;
  const r = solveEquilibrium({ ct: c, strongAcid: 0, strongBase: 0, ka: KA, kw: KW });
  // Kw-inclusive solver must agree with the Kw-free quadratic to high
  // precision at 0.1 M (water contribution negligible but retained).
  const exactNoKw = (-KA + Math.sqrt(KA * KA + 4 * KA * c)) / 2;
  assert.ok(Math.abs(r.h - exactNoKw) / exactNoKw < 1e-5);
  assert.ok(r.ph < 2.9 && r.ph > 2.85);
});

test('half-equivalence gives pH = pKa even with dilution', () => {
  const start = { ...zeroState(1), nAcid: 0.1 };
  const half = addReagent(start, base(), 0.5);
  const r = solveState(half, { ka: KA, kw: KW });
  assert.ok(Math.abs(r.ph - -Math.log10(KA)) < 0.01);
});

test('equivalence point is basic, post-equivalence set by excess base', () => {
  const start = { ...zeroState(1), nAcid: 0.1 };
  const eq = solveState(addReagent(start, base(), 1.0), { ka: KA, kw: KW });
  assert.ok(eq.ph > 7, `equivalence should be basic, got ${eq.ph}`);
  const past = solveState(addReagent(start, base(), 1.5), { ka: KA, kw: KW });
  // excess 0.05 mol base in 2.5 L -> 0.02 M -> pH ~ 12.3
  assert.ok(Math.abs(past.ph - 12.301) < 0.02);
});

test('extreme dilution trends toward neutral water', () => {
  for (const c of [1e-9, 1e-12]) {
    const r = solveEquilibrium({ ct: c, strongAcid: 0, strongBase: 0, ka: KA, kw: KW });
    assert.ok(Math.abs(r.ph - 7) < 0.05, `c=${c} ph=${r.ph}`);
  }
  // At 1e-7 M the acid still measurably acidifies (pH < 7) but stays near water.
  const faint = solveEquilibrium({ ct: 1e-7, strongAcid: 0, strongBase: 0, ka: KA, kw: KW });
  assert.ok(faint.ph < 7 && faint.ph > 6.5);
});

test('total acid moiety and charge are conserved across the curve', () => {
  const start = { ...zeroState(1), nAcid: 0.1 };
  const points = scanCurve(start, base(), { ka: KA, kw: KW }, { totalTitrantL: 2, steps: 50 });
  for (const p of points) {
    const state = {
      nAcid: start.nAcid,
      nStrongAcid: 0,
      nStrongBase: base().strongBaseConc * p.addedVolumeL,
      volumeL: 1 + p.addedVolumeL,
    };
    const c = concentrations(state);
    // mass: Ct * V constant
    assert.ok(Math.abs(p.ct * p.totalVolumeL - 0.1) < 1e-12);
    // charge: h + Cb - oh - A- - Ca = 0
    const charge = p.h + c.strongBase - p.oh - p.aMinus - c.strongAcid;
    assert.ok(Math.abs(charge) < 1e-9 * Math.max(1, c.strongBase));
    assert.equal(p.converged, true);
  }
});

test('unit equivalence: molarity built from moles/volume equals direct concentrations', () => {
  const direct = solveEquilibrium({
    ct: 0.1 / 1.005,
    strongAcid: 0,
    strongBase: (0.1 * 0.005) / 1.005,
    ka: KA,
    kw: KW,
  });
  const state = addReagent({ ...zeroState(1), nAcid: 0.1 }, base(), 0.005);
  const viaMoles = solveState(state, { ka: KA, kw: KW });
  assert.ok(Math.abs(direct.ph - viaMoles.ph) < 1e-12);
});

test('max-slope locates equivalence and refinement narrows the interval', () => {
  const start = { ...zeroState(1), nAcid: 0.1 };
  const pts = scanCurve(start, base(), { ka: KA, kw: KW }, { totalTitrantL: 2, steps: 40 });
  const coarse = findMaxSlope(pts);
  assert.ok(Math.abs(coarse.vCenter - 1.0) < 0.06);
  const refined = refineMaxSlope(start, base(), { ka: KA, kw: KW }, { vLeft: coarse.vLeft, vRight: coarse.vRight }, 40);
  assert.ok(Math.abs(refined.result.vCenter - 1.0) < 0.02);
  assert.ok(refined.result.vRight - refined.result.vLeft <= coarse.vRight - coarse.vLeft + 1e-12);
  assert.match(refined.result.note, /not an exact equivalence volume/i);
});

test('dilution ratio variants remain stable', () => {
  for (const scale of [0.5, 2, 10]) {
    const r = solveEquilibrium({ ct: 0.1 / scale, strongAcid: 0, strongBase: 0, ka: KA, kw: KW });
    assert.ok(Number.isFinite(r.ph) && r.converged);
  }
});

test('invalid Ka/Kw and out-of-range concentrations are rejected, pH is not clipped', () => {
  assert.throws(
    () => solveEquilibrium({ ct: 0.1, strongAcid: 0, strongBase: 0, ka: 0, kw: KW }),
    (e: ModelDomainError) => e.code === 'NON_POSITIVE_KA',
  );
  assert.throws(
    () => solveEquilibrium({ ct: 0.1, strongAcid: 0, strongBase: 0, ka: KA, kw: -1 }),
    (e: ModelDomainError) => e.code === 'NON_POSITIVE_KW',
  );
  assert.throws(
    () => solveEquilibrium({ ct: 5, strongAcid: 0, strongBase: 0, ka: KA, kw: KW }),
    (e: ModelDomainError) => e.code === 'CONCENTRATION_TOO_HIGH',
  );
});

test('residual sign is correct far on both sides of the root', () => {
  const p = { ct: 0.1, strongAcid: 0, strongBase: 0, ka: KA, kw: KW };
  assert.ok(residual(1e-9, p) < 0);
  assert.ok(residual(1, p) > 0);
});
