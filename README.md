# Weak-Acid Titration Equilibrium & pH-Curve Backend

Local, dependency-light backend for equilibrium and titration-curve analysis
of **one monoprotic weak acid / conjugate-base pair** in an **ideal dilute
aqueous solution**. Strong acid or strong base may be present. It provides an
HTTP API, a CLI, fictional teaching examples, and automated tests. It does
**not** provide a web UI, chemical-equation balancing, or instrument control.

## Chemistry model

The solver never applies Henderson–Hasselbalch universally. It combines:

- **mass balance**: total acid moiety `Ct = [HA] + [A-]`;
- **water auto-ionisation**: `[H+][OH-] = Kw`, always retained;
- **charge balance** (strong-acid anion `Ca`, strong-base cation `Cb`):

```
[H+] + Cb = [OH-] + [A-] + Ca,
[A-] = Ct * Ka / (Ka + h),   [OH-] = Kw / h
```

so it solves, by **bisection in `log10([H+])`** over a fixed chemically
meaningful bracket, the monotone physical root of

```
R(h) = h + Cb - Kw/h - Ct*Ka/(Ka+h) - Ca = 0
```

Mixing tracks **moles and total volume**; post-mix concentrations are
recomputed as total moles / total volume (additive volumes). Strong
acid/base spectator ions are included in the charge balance. Results retain
the residual and convergence flag. pH is **never clipped to [0, 14]**.

Stable for zero solute (pure water), extreme dilution, exact equivalence,
and post-equivalence excess. Inputs outside the ideal-dilute domain are
rejected with explicit error codes rather than extrapolated.

**Max slope** is a **discrete central-difference estimate** from sampled
points (with interval refinement). It is reported as such and is **not** an
exact chemical equivalence volume.

Model revisions are immutable: changing `Ka`/`Kw` creates a new revision;
both constants must be positive and are frozen on the revision used by a
report/solution.

## Requirements

- Node.js **>= 22.5** (developed/tested on Node 25). Uses the built-in
  `node:sqlite` and native TypeScript type-stripping — no runtime framework
  dependencies. `@types/node` is the only installed package (types only).

## Setup

```powershell
npm install
```

## Tests

```powershell
npm test
```

Covers pure water, strong acid/base, buffer region, half-equivalence,
equivalence and post-equivalence, several dilution ratios, cross-checks
against analytical limits, total-moles/charge conservation, moles-vs-molar
unit equivalence, slope-interval refinement, old-revision reproduction,
failure paths, transaction rollback, idempotency, and persistence across
restart. Time/UUIDs are injectable; the demo and tests are deterministic.

## Start / stop

```powershell
npm start                 # binds 127.0.0.1 on an auto-assigned free port
                          # writes data/server.json with host/port/pid
npm run clean             # stops only this project's server; removes data/*
```

Startup/shutdown manage only this project's process (matched via
`data/server.json` and the project path) and only files inside `data/`.

## Repeatable end-to-end demo

```powershell
npm run demo              # writes data/demo.sqlite and data/demo-distribution.csv
```

The demo uses fictional teaching solutions in `src/chemistry/fixtures.ts`.

## CLI

```powershell
npm run cli -- --help
npm run cli -- init-db
npm run cli -- revision <code> <ka> <kw> [note]
npm run cli -- reagent <revisionId> <name> <acidMoietyConc> <strongAcidConc> <strongBaseConc>
npm run cli -- solution <revisionId> <name> <nAcid> <nStrongAcid> <nStrongBase> <volumeL> [idempotencyKey]
npm run cli -- equilibrium <solutionId>
npm run cli -- titrate <solutionId> <reagentId|null> <volumeL>
npm run cli -- scan <solutionId> <reagentId|null> <totalTitrantL> <steps>
npm run cli -- max-slope <solutionId> <reagentId|null> <totalTitrantL> <steps>
npm run cli -- refine <solutionId> <reagentId|null> <vLeft> <vRight> [subSteps]
npm run cli -- compare <solutionId> <kaA> <kwA> <kaB> <kwB>
npm run cli -- export <solutionId> <reagentId|null> <totalTitrantL> <steps> <outCsv>
npm run cli -- assumptions
```

Amounts are mol, concentrations mol/L, volumes L. `titrate` prints state
before and after the addition.

## HTTP API

See `docs/API.md` for endpoints, pagination, idempotency keys, and error
codes. Quick example once the server reports its port:

```powershell
$b = 'http://127.0.0.1:<port>'
Invoke-RestMethod "$b/health"
```

## Numerical precision & scope

- Root bracket `log10(h) in [-30, 1]`, log tolerance `1e-12`, up to 240
  bisection iterations; the rightmost (physical) sign crossing is bracketed
  first to avoid the extraneous tiny-`h` root.
- Ideal dilute range: analytical concentration ≤ 1 M and estimated ionic
  strength ≤ 2 M. Beyond this the model refuses to report a pH.
- Activities, temperature dependence, polyprotic species, and non-aqueous
  solvents are out of scope.

## Project layout

```
src/chemistry/  model constants/validation, equilibrium solver, titration engine, fixtures
src/db/          idempotent migrations, SQLite repository (transactions, pagination)
src/api/         local HTTP app + server entry
src/cli/         command-line interface
src/util/        input validation / pagination helpers
scripts/         deterministic demo, stop-and-clean
test/            node:test suites
data/            all local DB/temp artifacts (git-ignored)
```
