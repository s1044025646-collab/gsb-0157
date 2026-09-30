import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { freshRepo } from './helpers.ts';
import { buildApp, listenLocal } from '../src/api/app.ts';

let baseUrl: string;
let server: Server;

before(async () => {
  server = buildApp(freshRepo());
  const { port, host } = await listenLocal(server);
  baseUrl = `http://${host}:${port}`;
});

after(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(baseUrl + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = await res.json();
  return { status: res.status, body };
}

let revisionId = 0;
let solutionId = 0;
let reagentId = 0;

test('health and assumptions', async () => {
  const h = await api('/health');
  assert.equal(h.status, 200);
  const a = await api('/assumptions');
  assert.ok(Array.isArray(a.body.assumptions));
  assert.match(a.body.numerical.note, /not an exact equivalence volume/i);
});

test('create revision rejects non-positive Ka', async () => {
  const bad = await api('/revisions', {
    method: 'POST',
    body: JSON.stringify({ revisionCode: 'bad', ka: 0, kw: 1e-14 }),
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'NON_POSITIVE_KA');

  const ok = await api('/revisions', {
    method: 'POST',
    body: JSON.stringify({ revisionCode: 'r1', ka: 1.8e-5, kw: 1e-14 }),
  });
  assert.equal(ok.status, 201);
  revisionId = ok.body.revision.id;
});

test('invalid json yields INVALID_JSON', async () => {
  const r = await api('/revisions', { method: 'POST', body: '{not json' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'INVALID_JSON');
});

test('create reagent and solution, idempotent solution submit', async () => {
  const rg = await api('/reagents', {
    method: 'POST',
    body: JSON.stringify({
      revisionId,
      name: 'NaOH-0.1',
      acidMoietyConc: 0,
      strongAcidConc: 0,
      strongBaseConc: 0.1,
    }),
  });
  assert.equal(rg.status, 201);
  reagentId = rg.body.reagent.id;

  const payload = {
    revisionId,
    name: 'acid',
    nAcid: 0.1,
    nStrongAcid: 0,
    nStrongBase: 0,
    volumeL: 1,
    idempotencyKey: 'sol-1',
  };
  const first = await api('/solutions', { method: 'POST', body: JSON.stringify(payload) });
  const second = await api('/solutions', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(first.body.solution.id, second.body.solution.id);
  assert.equal(second.body.replayed, true);
  solutionId = first.body.solution.id;
});

test('equilibrium gives expected weak-acid pH', async () => {
  const r = await api(`/solutions/${solutionId}/equilibrium`);
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.body.equilibrium.ph - 2.875) < 0.01);
  assert.equal(r.body.equilibrium.converged, true);
});

test('titrate to half equivalence -> pH ~ pKa, shows before/after', async () => {
  const r = await api(`/solutions/${solutionId}/titrate`, {
    method: 'POST',
    body: JSON.stringify({ reagentId, volumeL: 0.5 }),
  });
  assert.equal(r.status, 201);
  assert.ok(Math.abs(r.body.after.ph - 4.7447) < 0.01);
  assert.ok(r.body.before.ph < r.body.after.ph);
});

test('revision mismatch is rejected', async () => {
  const other = await api('/revisions', {
    method: 'POST',
    body: JSON.stringify({ revisionCode: 'r2', ka: 2e-5, kw: 1e-14 }),
  });
  const s = await api('/solutions', {
    method: 'POST',
    body: JSON.stringify({
      revisionId: other.body.revision.id,
      name: 'x',
      nAcid: 0.1,
      nStrongAcid: 0,
      nStrongBase: 0,
      volumeL: 1,
    }),
  });
  const r = await api(`/solutions/${s.body.solution.id}/titrate`, {
    method: 'POST',
    body: JSON.stringify({ reagentId, volumeL: 0.1 }),
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'REVISION_MISMATCH');
});

test('scan, max-slope, refine, compare and distribution', async () => {
  const s = await api('/solutions', {
    method: 'POST',
    body: JSON.stringify({
      revisionId,
      name: 'curve',
      nAcid: 0.1,
      nStrongAcid: 0,
      nStrongBase: 0,
      volumeL: 1,
    }),
  });
  const id = s.body.solution.id;
  const scan = await api(`/solutions/${id}/scan`, {
    method: 'POST',
    body: JSON.stringify({ reagentId, totalTitrantL: 2, steps: 40 }),
  });
  assert.equal(scan.status, 201);
  assert.equal(scan.body.points.length, 41);

  const ms = await api('/analyze/max-slope', {
    method: 'POST',
    body: JSON.stringify({ points: scan.body.points }),
  });
  assert.ok(Math.abs(ms.body.maxSlope.vCenter - 1) < 0.06);

  const rf = await api(`/solutions/${id}/refine`, {
    method: 'POST',
    body: JSON.stringify({ reagentId, vLeft: ms.body.maxSlope.vLeft, vRight: ms.body.maxSlope.vRight, subSteps: 40 }),
  });
  assert.equal(rf.status, 200);

  const cmp = await api(`/solutions/${id}/compare`, {
    method: 'POST',
    body: JSON.stringify({ kaA: 1.8e-5, kwA: 1e-14, kaB: 3e-5, kwB: 1e-14 }),
  });
  assert.equal(cmp.status, 200);
  assert.ok(Math.abs(cmp.body.deltaPh) > 0);

  const dist = await api('/export/distribution', {
    method: 'POST',
    body: JSON.stringify({ points: scan.body.points }),
  });
  assert.equal(dist.body.data.length, 41);
  assert.ok('alphaHA' in dist.body.data[0]);
});

test('list endpoints paginate and unknown ids 404', async () => {
  const list = await api('/solutions?limit=2&offset=0');
  assert.equal(list.status, 200);
  assert.ok(list.body.total >= 2);
  assert.equal(list.body.data.length, 2);
  const missing = await api('/solutions/99999/equilibrium');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'SOLUTION_NOT_FOUND');
});
