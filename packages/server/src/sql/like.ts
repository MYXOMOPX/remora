import { RemoraError } from '@remora/sdk';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Escapes LIKE metacharacters (backslash, %, _) for use with the default backslash escape. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** One `%word%` pattern per whitespace-separated word; empty query gives []. */
export function wordPatterns(query: string): string[] {
  return query
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `%${escapeLike(w)}%`);
}

export function clampLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RemoraError('invalid_param', 'limit must be an integer >= 1', { limit });
  }
  return Math.min(limit, MAX_LIMIT);
}
