import { ModelDomainError } from '../chemistry/model.ts';

export function num(v: unknown, field: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  throw new ModelDomainError('INVALID_NUMBER', `Field ${field} must be a finite number`);
}

export function optNum(v: unknown, field: string, dflt = 0): number {
  if (v === undefined || v === null) return dflt;
  return num(v, field);
}

export function str(v: unknown, field: string): string {
  if (typeof v === 'string' && v.length > 0) return v;
  throw new ModelDomainError('INVALID_STRING', `Field ${field} must be a non-empty string`);
}

export function optStr(v: unknown, dflt = ''): string {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'string') {
    throw new ModelDomainError('INVALID_STRING', `Optional field must be a string`);
  }
  return v;
}

export interface Page {
  limit: number;
  offset: number;
}

export function pageParams(query: {
  limit?: unknown;
  offset?: unknown;
}): Page {
  let limit = Number(query.limit ?? 50);
  let offset = Number(query.offset ?? 0);
  if (!Number.isInteger(limit) || limit <= 0) limit = 50;
  if (limit > 500) limit = 500;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  return { limit, offset };
}
