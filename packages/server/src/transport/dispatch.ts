import type { RemoraApp } from '../app.js';
import type { ApplyResponse } from '../api/apply.js';
import type { QueryResponse } from '../api/query.js';
import { validateApplyRequest, validateQueryRequest } from '../contract/index.js';

/** Validates at the transport boundary (R33); an invalid request never reaches the database. */
export async function runApply(app: RemoraApp, body: unknown): Promise<ApplyResponse> {
  const error = validateApplyRequest(body);
  if (error) return { ok: false, error };
  return app.apply(body);
}

export async function runQuery(app: RemoraApp, body: unknown): Promise<QueryResponse> {
  const error = validateQueryRequest(body);
  if (error) return { ok: false, error };
  return app.query(body);
}
