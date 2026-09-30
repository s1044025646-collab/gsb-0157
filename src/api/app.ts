import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  LOGH_TOL,
  MAX_BISECTION_ITERS,
  MODEL_ASSUMPTIONS,
  ModelDomainError,
  validateEquilibriumInput,
} from '../chemistry/model.ts';
import { distributionRows, findMaxSlope } from '../chemistry/titration.ts';
import type { Repository } from '../db/repository.ts';
import { TitrationService } from '../service.ts';
import { num, optNum, optStr, pageParams, str } from '../util/validate.ts';

const NUMERICAL_EXPORT = {
  logHTolerance: LOGH_TOL,
  maxBisectionIterations: MAX_BISECTION_ITERS,
  note:
    'Root found by bisection in log10([H+]); max slope is a discrete central-difference estimate, not an exact equivalence volume.',
};

interface Context {
  repo: Repository;
  service: TitrationService;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) {
        reject(new ModelDomainError('PAYLOAD_TOO_LARGE', 'Request body exceeds 1 MB'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (data.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new ModelDomainError('INVALID_JSON', 'Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

type Handler = (
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  query: URLSearchParams,
  body: any,
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$',
  );
  return { method, pattern, keys, handler };
}

const routes: Route[] = [
  route('GET', '/health', (_c, _q, res) => send(res, 200, { status: 'ok' })),
  route('GET', '/assumptions', (_c, _q, res) =>
    send(res, 200, {
      assumptions: MODEL_ASSUMPTIONS_EXPORT,
      numerical: NUMERICAL_EXPORT,
    }),
  ),

  route('POST', '/revisions', (c, _q, res, _p, _u, b) => {
    const ka = num(b.ka, 'ka');
    const kw = num(b.kw, 'kw');
    validateEquilibriumInput({ ct: 0, strongAcid: 0, strongBase: 0, ka, kw });
    const rev = c.repo.createRevision({
      revisionCode: str(b.revisionCode ?? b.revision_code, 'revisionCode'),
      ka,
      kw,
      note: optStr(b.note),
      supersedesId: b.supersedesId ?? b.supersedes_id ?? null,
    });
    send(res, 201, { revision: rev });
  }),
  route('GET', '/revisions', (c, _q, res, _p, query) => {
    const { limit, offset } = pageParams({
      limit: query.get('limit'),
      offset: query.get('offset'),
    });
    const { rows, total } = c.repo.listRevisions(limit, offset);
    send(res, 200, { data: rows, total, limit, offset });
  }),
  route('GET', '/revisions/:id', (c, _q, res, p) =>
    send(res, 200, { revision: c.repo.getRevision(Number(p.id)) }),
  ),

  route('POST', '/reagents', (c, _q, res, _p, _u, b) => {
    const row = c.repo.createReagent({
      revisionId: num(b.revisionId ?? b.revision_id, 'revisionId'),
      name: str(b.name, 'name'),
      acidMoietyConc: optNum(b.acidMoietyConc ?? b.acid_moiety_conc, 'acidMoietyConc'),
      strongAcidConc: optNum(b.strongAcidConc ?? b.strong_acid_conc, 'strongAcidConc'),
      strongBaseConc: optNum(b.strongBaseConc ?? b.strong_base_conc, 'strongBaseConc'),
    });
    send(res, 201, { reagent: row });
  }),
  route('GET', '/reagents', (c, _q, res, _p, query) => {
    const { limit, offset } = pageParams({
      limit: query.get('limit'),
      offset: query.get('offset'),
    });
    const { rows, total } = c.repo.listReagents(limit, offset);
    send(res, 200, { data: rows, total, limit, offset });
  }),

  route('POST', '/solutions', (c, _q, res, _p, _u, b) => {
    const { row, replayed } = c.repo.createSolution({
      revisionId: num(b.revisionId ?? b.revision_id, 'revisionId'),
      name: str(b.name, 'name'),
      nAcid: optNum(b.nAcid ?? b.n_acid, 'nAcid'),
      nStrongAcid: optNum(b.nStrongAcid ?? b.n_strong_acid, 'nStrongAcid'),
      nStrongBase: optNum(b.nStrongBase ?? b.n_strong_base, 'nStrongBase'),
      volumeL: num(b.volumeL ?? b.volume_l, 'volumeL'),
      idempotencyKey: optStr(b.idempotencyKey ?? b.idempotency_key, undefined) || undefined,
    });
    send(res, replayed ? 200 : 201, { solution: row, replayed });
  }),
  route('GET', '/solutions', (c, _q, res, _p, query) => {
    const { limit, offset } = pageParams({
      limit: query.get('limit'),
      offset: query.get('offset'),
    });
    const { rows, total } = c.repo.listSolutions(limit, offset);
    send(res, 200, { data: rows, total, limit, offset });
  }),
  route('GET', '/solutions/:id', (c, _q, res, p) =>
    send(res, 200, { solution: c.repo.getSolution(Number(p.id)) }),
  ),
  route('GET', '/solutions/:id/equilibrium', (c, _q, res, p) =>
    send(res, 200, c.service.equilibrium(Number(p.id))),
  ),
  route('GET', '/solutions/:id/steps', (c, _q, res, p) =>
    send(res, 200, { data: c.repo.listSteps(Number(p.id)) }),
  ),
  route('POST', '/solutions/:id/titrate', (c, req, res, p, _u, b) => {
    const reagentId =
      b.reagentId === null || b.reagent_id === null
        ? null
        : num(b.reagentId ?? b.reagent_id, 'reagentId');
    const added = num(b.volumeL ?? b.volume_l, 'volumeL');
    const out = c.service.addTitrant(Number(p.id), reagentId, added);
    send(res, 201, out);
  }),

  route('POST', '/solutions/:id/scan', (c, _q, res, p, _u, b) => {
    const reagentId =
      b.reagentId === null || b.reagent_id === null
        ? null
        : num(b.reagentId ?? b.reagent_id, 'reagentId');
    const total = num(b.totalTitrantL ?? b.total_titrant_l, 'totalTitrantL');
    const steps = num(b.steps, 'steps');
    if (!Number.isInteger(steps) || steps < 2) {
      throw new ModelDomainError('BAD_STEP_COUNT', 'steps must be an integer >= 2');
    }
    const key = optStr(b.idempotencyKey ?? b.idempotency_key, undefined) || undefined;
    const out = c.service.scan(Number(p.id), reagentId, total, steps, key);
    send(res, out.replayed ? 200 : 201, { runId: out.runId, replayed: out.replayed, points: out.points });
  }),
  route('POST', '/analyze/max-slope', (_c, _q, res, _p, _u, b) => {
    const points = b.points;
    if (!Array.isArray(points)) {
      throw new ModelDomainError('INVALID_POINTS', 'points must be an array of curve points');
    }
    send(res, 200, { maxSlope: findMaxSlope(points) });
  }),
  route('POST', '/solutions/:id/refine', (c, _q, res, p, _u, b) => {
    const reagentId =
      b.reagentId === null || b.reagent_id === null
        ? null
        : num(b.reagentId ?? b.reagent_id, 'reagentId');
    const window = { vLeft: num(b.vLeft ?? b.v_left, 'vLeft'), vRight: num(b.vRight ?? b.v_right, 'vRight') };
    const subSteps = Number.isInteger(b.subSteps ?? b.sub_steps) ? Number(b.subSteps ?? b.sub_steps) : 20;
    const out = c.service.refine(Number(p.id), reagentId, window, subSteps);
    send(res, 200, { maxSlope: out.result, points: out.points });
  }),
  route('POST', '/solutions/:id/compare', (c, _q, res, p, _u, b) => {
    const out = c.service.compare(
      Number(p.id),
      num(b.kaA ?? b.ka_a, 'kaA'),
      num(b.kwA ?? b.kw_a, 'kwA'),
      num(b.kaB ?? b.ka_b, 'kaB'),
      num(b.kwB ?? b.kw_b, 'kwB'),
    );
    send(res, 200, out);
  }),
  route('POST', '/export/distribution', (_c, _q, res, _p, _u, b) => {
    if (!Array.isArray(b.points)) {
      throw new ModelDomainError('INVALID_POINTS', 'points must be an array');
    }
    send(res, 200, { data: distributionRows(b.points) });
  }),
  route('GET', '/runs/:id/points', (c, _q, res, p, query) => {
    const { limit, offset } = pageParams({
      limit: query.get('limit'),
      offset: query.get('offset'),
    });
    const out = c.repo.getScanPoints(Number(p.id), limit, offset);
    send(res, 200, { ...out, limit, offset });
  }),
];

const MODEL_ASSUMPTIONS_EXPORT = MODEL_ASSUMPTIONS;

export function buildApp(repo: Repository): Server {
  const ctx: Context = { repo, service: new TitrationService(repo) };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let body: any = {};
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        body = await readJson(req);
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
        await r.handler(ctx, req, res, params, url.searchParams, body);
        return;
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${url.pathname}` } });
    } catch (err: any) {
      if (err instanceof ModelDomainError) {
        const status =
          err.code.endsWith('_NOT_FOUND') || err.code === 'NO_REVISION'
            ? 404
            : err.code === 'PAYLOAD_TOO_LARGE'
              ? 413
              : 422;
        send(res, status, { error: { code: err.code, message: err.message } });
        return;
      }
      send(res, 500, { error: { code: 'INTERNAL', message: String(err?.message ?? err) } });
    }
  });
}

export function listenLocal(server: Server, host = '127.0.0.1'): Promise<{ port: number; host: string }> {
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, host });
    });
  });
}
