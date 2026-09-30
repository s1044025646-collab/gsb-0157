# HTTP API

Local only. The server binds `127.0.0.1` on an OS-assigned free port; the
chosen port is written to `data/server.json`. All bodies are JSON.

## Errors

Errors use the shape `{ "error": { "code", "message" } }` with status:

| Status | Meaning |
| --- | --- |
| 404 | `*_NOT_FOUND`, `NO_REVISION` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | validation / model-domain errors (codes below) |
| 500 | `INTERNAL` |

Common 422 codes: `NON_POSITIVE_KA`, `NON_POSITIVE_KW`, `KA_OUT_OF_RANGE`,
`KW_OUT_OF_RANGE`, `CONCENTRATION_TOO_HIGH`, `IONIC_STRENGTH_TOO_HIGH`,
`NEGATIVE_CONCENTRATION`, `NON_FINITE_PARAMETER`, `BAD_STEP_COUNT`,
`EMPTY_VOLUME`, `NEGATIVE_VOLUME`, `VOLUME_TOO_SMALL`, `ROOT_BRACKET_FAILED`,
`NON_FINITE_RESIDUAL`, `REVISION_CODE_EXISTS`, `REVISION_MISMATCH`,
`INVALID_JSON`, `INVALID_NUMBER`, `INVALID_STRING`, `INVALID_POINTS`.

## Endpoints

- `GET /health` → liveness.
- `GET /assumptions` → model assumptions and numerical precision notes.
- `POST /revisions` `{revisionCode, ka, kw, note?, supersedesId?}` → frozen revision.
- `GET /revisions?limit&offset`, `GET /revisions/:id`.
- `POST /reagents` `{revisionId, name, acidMoietyConc, strongAcidConc, strongBaseConc}`.
- `GET /reagents?limit&offset`.
- `POST /solutions` `{revisionId, name, nAcid, nStrongAcid, nStrongBase, volumeL, idempotencyKey?}`.
- `GET /solutions?limit&offset`, `GET /solutions/:id`.
- `GET /solutions/:id/equilibrium` → full equilibrium + residual/convergence.
- `GET /solutions/:id/steps` → titration history.
- `POST /solutions/:id/titrate` `{reagentId|null, volumeL}` → before/after state.
- `POST /solutions/:id/scan` `{reagentId|null, totalTitrantL, steps, idempotencyKey?}` → curve.
- `POST /analyze/max-slope` `{points:[...]}` → discrete max-slope interval (with disclaimer).
- `POST /solutions/:id/refine` `{reagentId|null, vLeft, vRight, subSteps?}`.
- `POST /solutions/:id/compare` `{kaA, kwA, kaB, kwB}`.
- `POST /export/distribution` `{points:[...]}` → HA/A-/α rows.
- `GET /runs/:id/points?limit&offset` → paginated persisted scan points.

All list endpoints return `{data, total, limit, offset}`. Repeated
`POST /solutions` and `POST /.../scan` with the same `idempotencyKey` return
the original record (`replayed: true`).
