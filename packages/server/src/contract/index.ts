import { ERROR_CODES } from '@remora/sdk';
import { APPLY_OPS } from './apply-ops.js';
import type { JsonSchema } from './common.js';
import { QUERY_OPS } from './query-ops.js';
import {
  APPLY_RESULTS,
  QUERY_RESULTS,
  apiErrorSchema,
  applyResponseSchema,
  queryResponseSchema,
} from './responses.js';
import { applyRequestSchema, queryRequestSchema } from './validate.js';

export { MAX_OPS } from '../api/limits.js';
export { validateApplyRequest, validateQueryRequest } from './validate.js';
export { APPLY_OPS, QUERY_OPS, APPLY_RESULTS, QUERY_RESULTS };
export { apiErrorSchema, applyResponseSchema, queryResponseSchema };

/** The machine-readable API contract (spec 10, R33): request schemas, response schemas, error codes. */
export interface Contract {
  version: string;
  apply: JsonSchema;
  query: JsonSchema;
  responses: {
    apply: JsonSchema;
    query: JsonSchema;
    results: { apply: Record<string, JsonSchema>; query: Record<string, JsonSchema> };
  };
  error: JsonSchema;
  error_codes: readonly string[];
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value === 'object' && value !== null && !seen.has(value)) {
    seen.add(value);
    for (const v of Object.values(value)) deepFreeze(v, seen);
    Object.freeze(value);
  }
  return value;
}

const contract: Contract = {
  version: '1.0.0',
  apply: applyRequestSchema,
  query: queryRequestSchema,
  responses: {
    apply: applyResponseSchema,
    query: queryResponseSchema,
    results: { apply: APPLY_RESULTS, query: QUERY_RESULTS },
  },
  error: apiErrorSchema,
  error_codes: [...ERROR_CODES],
};
// the object is shared by every caller (schema route, MCP tool list, validators): nobody may change it
deepFreeze(contract);

/** The same object on every call. */
export function getContract(): Contract {
  return contract;
}
