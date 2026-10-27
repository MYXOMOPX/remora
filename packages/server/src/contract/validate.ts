import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { ApiError } from '../api/apply.js';
import { MAX_OPS } from '../api/limits.js';
import { APPLY_OPS } from './apply-ops.js';
import type { JsonSchema } from './common.js';
import { QUERY_OPS } from './query-ops.js';

function requestSchema(ops: Record<string, JsonSchema>, what: string, description: string): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['ops'],
    description,
    properties: {
      ops: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_OPS,
        description: `The ${what} ops, executed in order. At most ${MAX_OPS}.`,
        items: { oneOf: Object.values(ops) },
      },
    },
  };
}

/** R27: the `apply` tool / request schema. */
export const applyRequestSchema: JsonSchema = requestSchema(
  APPLY_OPS,
  'write',
  'Write to the memory: a list of ops executed in order in ONE transaction. Each op sees the results of the previous ones; any error rolls the whole batch back and reports the op_index and a typed code. An op can declare "as": "name" and later ops refer to its result as "$name" (entities and evidence). Returns {ok: true, results: [...]} with one result per op, or {ok: false, error: {op_index, code, message, details?}}.',
);

/** R27: the `query` tool / request schema. */
export const queryRequestSchema: JsonSchema = requestSchema(
  QUERY_OPS,
  'read',
  'Read from the memory: a list of read-only ops executed in order against one consistent snapshot. Returns {ok: true, results: [...]} with one result per op, or {ok: false, error: {op_index, code, message, details?}}. Time-dependent ops take an optional "when": {axis, at} or {axis, during: [from, to]}.',
);

// Dedicated strict instance (the service-wide one in services/ajv.ts is deliberately lenient).
const ajv = new Ajv({ strict: true, allowUnionTypes: true, allErrors: true });

function compileAll(ops: Record<string, JsonSchema>): Map<string, ValidateFunction> {
  return new Map(Object.entries(ops).map(([name, schema]) => [name, ajv.compile(schema)]));
}

const applyValidators = compileAll(APPLY_OPS);
const queryValidators = compileAll(QUERY_OPS);

const invalid = (op_index: number, message: string, details: Record<string, unknown>): ApiError => ({
  op_index,
  code: 'invalid_param',
  message,
  details,
});

function pathSegments(instancePath: string): string[] {
  return instancePath === '' ? [] : instancePath.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Dotted path of the offending field, including the missing / extra property named by the error. */
function fieldOf(e: ErrorObject): string[] {
  const segs = pathSegments(e.instancePath);
  if (e.keyword === 'required') segs.push(String((e.params as { missingProperty: string }).missingProperty));
  if (e.keyword === 'additionalProperties') segs.push(String((e.params as { additionalProperty: string }).additionalProperty));
  return segs;
}

/** R33: the deepest error wins; oneOf/anyOf wrapper errors only when nothing else is left. */
function pickError(errors: ErrorObject[]): ErrorObject {
  const specific = errors.filter((e) => e.keyword !== 'oneOf' && e.keyword !== 'anyOf');
  const pool = specific.length > 0 ? specific : errors;
  let best = pool[0]!;
  let bestDepth = fieldOf(best).length;
  for (const e of pool) {
    const d = fieldOf(e).length;
    if (d > bestDepth) {
      best = e;
      bestDepth = d;
    }
  }
  return best;
}

function opError(index: number, errors: ErrorObject[]): ApiError {
  const e = pickError(errors);
  const field = fieldOf(e).join('.');
  let reason = e.message ?? 'is invalid';
  if (e.keyword === 'additionalProperties') {
    reason = `${reason}: ${(e.params as { additionalProperty: string }).additionalProperty}`;
  }
  return invalid(index, `${field} ${reason}`, { field, reason });
}

function validateRequest(body: unknown, validators: Map<string, ValidateFunction>): ApiError | null {
  const ops = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { ops?: unknown }).ops : undefined;
  const bad = (reason: string, extra: Record<string, unknown> = {}): ApiError =>
    invalid(-1, `ops ${reason}`, { field: 'ops', reason, ...extra });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalid(-1, 'request must be an object {ops: [...]}', { field: 'ops', reason: 'request must be an object' });
  }
  const extra = Object.keys(body).find((k) => k !== 'ops');
  if (extra !== undefined) {
    return invalid(-1, `unknown request key ${extra}`, { field: extra, reason: `must NOT have additional property: ${extra}` });
  }
  if (!Array.isArray(ops)) return bad('must be an array');
  if (ops.length === 0) return bad('must be a non-empty array');
  if (ops.length > MAX_OPS) return bad(`must have at most ${MAX_OPS} items`, { limit: MAX_OPS });

  for (let i = 0; i < ops.length; i++) {
    const op: unknown = ops[i];
    if (typeof op !== 'object' || op === null || Array.isArray(op)) {
      return invalid(i, 'op must be an object', { field: 'op', reason: 'must be an object' });
    }
    const name = (op as { op?: unknown }).op;
    if (name === undefined) {
      return invalid(i, 'op must have required property op', { field: 'op', reason: "must have required property 'op'" });
    }
    if (typeof name !== 'string') {
      return invalid(i, 'op must be a string', { field: 'op', reason: 'must be string' });
    }
    const validate = validators.get(name);
    if (!validate) return invalid(i, `unknown op: ${name}`, { op: name });
    if (!validate(op)) return opError(i, validate.errors ?? []);
  }
  return null;
}

/** R33: transport-boundary validation of an `apply` request; null when valid. */
export function validateApplyRequest(body: unknown): ApiError | null {
  return validateRequest(body, applyValidators);
}

/** R33: transport-boundary validation of a `query` request; null when valid. */
export function validateQueryRequest(body: unknown): ApiError | null {
  return validateRequest(body, queryValidators);
}
