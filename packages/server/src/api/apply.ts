import { RemoraError, type ErrorCode } from '@remora/sdk';
import type pg from 'pg';
import type { Queryable } from '../db/types.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { createPropertyType, createRelationType, type ValueType } from '../services/dictionaries.js';
import { createEntity } from '../services/entities.js';
import { addEvent, retractEvent, updateEvent, type EventEntityIn } from '../services/events.js';
import { addEvidence } from '../services/evidence.js';
import { addProperty, endProperty, replaceProperty, retractProperty } from '../services/properties.js';
import { addRelation, endRelation, retractRelation, type RelationRef } from '../services/relations.js';
import { parseEventTimes, parseMoment, parseSpans } from '../services/time.js';
import { bool, int, isObj, optStr, optStrArr, str, type Obj } from './args.js';
import { MAX_OPS } from './limits.js';

export type ApiError = {
  op_index: number;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
};
export type ApplyResponse = { ok: true; results: unknown[] } | { ok: false; error: ApiError };

/** Maps DB-level errors that are part of the API contract; anything else is null. */
export function mapPgError(e: unknown): RemoraError | null {
  if (typeof e !== 'object' || e === null) return null;
  const sqlstate = (e as { code?: unknown }).code;
  // Class 22 (data exception): NUL in text (22021), \u0000 in jsonb (22P05), bad representation, ...
  if (typeof sqlstate === 'string' && sqlstate.startsWith('22')) {
    return new RemoraError('invalid_param', 'a parameter contains a value the database cannot store');
  }
  switch (sqlstate) {
    case '23P01':
      return new RemoraError('single_valued_conflict', 'single-valued property conflict');
    case '40001':
    case '40P01':
      return new RemoraError('concurrent_update', 'concurrent update, retry the batch');
    case '57014':
      return new RemoraError('timeout', 'statement timeout exceeded; the batch was rolled back, narrow the request');
    case '54001': // statement too complex (stack depth), e.g. a hostile deeply nested value
      return new RemoraError('invalid_param', 'a parameter is too deeply nested for the database');
    case '23503':
      return new RemoraError('invalid_param', 'referenced row does not exist');
    default:
      return null;
  }
}

interface Env {
  db: Queryable;
  registry: PluginRegistry;
  bindings: Map<string, Binding>;
}

interface Binding {
  op: string;
  result: Obj;
}

/** Ops whose result carries an evidence `id`. */
const EVIDENCE_OPS: ReadonlySet<string> = new Set(['add_evidence']);

function unknownRef(ref: string): RemoraError {
  return new RemoraError('unknown_ref', `unknown reference ${ref}`, { ref });
}

/** R4: entity key or `$name` reference. */
function entityArg(env: Env, o: Obj, key: string): string {
  const v = str(o, key);
  if (!v.startsWith('$')) return v;
  const b = env.bindings.get(v.slice(1));
  const k = b?.op === 'create_entity' ? b.result.key : undefined;
  if (typeof k !== 'string') throw unknownRef(v);
  return k;
}

/** R4: evidence id (positive integer present in evidence_log) or `$name` reference. */
async function evidenceArg(env: Env, o: Obj): Promise<bigint | undefined> {
  const v = o.evidence;
  if (v === undefined) return undefined;
  const badType = (): RemoraError =>
    new RemoraError('invalid_param', 'evidence must be a number or a $reference', { field: 'evidence' });
  let id: number;
  if (typeof v === 'string') {
    if (!v.startsWith('$')) throw badType();
    const b = env.bindings.get(v.slice(1));
    const bid = b && EVIDENCE_OPS.has(b.op) ? b.result.id : undefined;
    if (typeof bid !== 'number') throw unknownRef(v);
    id = bid;
  } else if (typeof v === 'number') {
    id = v;
  } else {
    throw badType();
  }
  const r =
    Number.isSafeInteger(id) && id > 0
      ? await env.db.query('SELECT 1 FROM evidence_log WHERE id = $1', [id])
      : null;
  if (!r || r.rows.length === 0) {
    throw new RemoraError('unknown_ref', `unknown evidence ${id}`, { ref: id });
  }
  return BigInt(id);
}

function requireValue(o: Obj): unknown {
  if (o.value === undefined) {
    throw new RemoraError('invalid_param', 'value is required', { field: 'value' });
  }
  return o.value;
}

function relationRef(env: Env, o: Obj): RelationRef {
  const hasId = o.relation_id !== undefined;
  const sel = ['type', 'from', 'to'].filter((k) => o[k] !== undefined);
  if (hasId && sel.length > 0) {
    throw new RemoraError('invalid_param', 'give either relation_id or type/from/to, not both');
  }
  if (hasId) return { relationId: BigInt(int(o, 'relation_id')) };
  if (sel.length === 0) {
    throw new RemoraError('invalid_param', 'relation_id or type/from/to is required');
  }
  if (sel.length !== 3) {
    throw new RemoraError('invalid_param', 'selector needs all of type, from, to');
  }
  return { type: str(o, 'type'), from: entityArg(env, o, 'from'), to: entityArg(env, o, 'to') };
}

const ev = (id: bigint | undefined): { evidenceId?: bigint } => (id === undefined ? {} : { evidenceId: id });

function optObj(o: Obj, key: string): Obj | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!isObj(v)) throw new RemoraError('invalid_param', `${key} must be an object`, { field: key });
  return v;
}

/** Event entity links: `entity` may be a key or a $name reference (R4); `role` optional. */
function eventEntities(env: Env, raw: unknown, field: string): EventEntityIn[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new RemoraError('invalid_param', `${field} must be an array`, { field });
  }
  return raw.map((x) => {
    if (!isObj(x)) throw new RemoraError('invalid_param', `${field} items must be objects`, { field });
    const role = optStr(x, 'role');
    return { entity: entityArg(env, x, 'entity'), ...(role === undefined ? {} : { role }) };
  });
}

/** keywords on update: {set} or {add?, remove?}. */
function keywordsArg(raw: unknown): EventUpdateKeywords | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) throw new RemoraError('invalid_param', 'keywords must be an object', { field: 'keywords' });
  for (const k of Object.keys(raw)) {
    if (k !== 'set' && k !== 'add' && k !== 'remove') {
      throw new RemoraError('invalid_param', `unknown keywords field ${k}`, { field: 'keywords' });
    }
  }
  const set = optStrArr(raw, 'set');
  const add = optStrArr(raw, 'add');
  const remove = optStrArr(raw, 'remove');
  if (set !== undefined) {
    if (add !== undefined || remove !== undefined) {
      throw new RemoraError('invalid_param', 'keywords: set cannot be combined with add/remove', {
        field: 'keywords',
      });
    }
    return { set };
  }
  return { ...(add ? { add } : {}), ...(remove ? { remove } : {}) };
}

type EventUpdateKeywords = NonNullable<Parameters<typeof updateEvent>[1]['keywords']>;

type Handler = (env: Env, o: Obj) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  async create_entity(env, o) {
    const key = str(o, 'key');
    if (key.startsWith('$')) {
      throw new RemoraError('invalid_name', 'entity key must not start with $', { key });
    }
    const r = await createEntity(env.db, key);
    return { key: r.entity.key, created: r.created };
  },
  async create_relation_type(env, o) {
    const r = await createRelationType(env.db, {
      name: str(o, 'name'),
      description: str(o, 'description'),
      directed: bool(o, 'directed'),
    });
    return { id: r.id, name: r.name, description: r.description, directed: r.directed };
  },
  async create_property_type(env, o) {
    const r = await createPropertyType(env.db, {
      name: str(o, 'name'),
      description: str(o, 'description'),
      valueType: str(o, 'value_type') as ValueType,
      singleValued: bool(o, 'single_valued'),
    });
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      value_type: r.valueType,
      single_valued: r.singleValued,
    };
  },
  async add_evidence(env, o) {
    const source = str(o, 'source');
    return addEvidence(env.db, env.registry, { source, payload: o.payload });
  },
  async add_event(env, o) {
    const summary = str(o, 'summary');
    const details = optStr(o, 'details');
    const keywords = optStrArr(o, 'keywords');
    const times = parseEventTimes(env.registry, o.time);
    const entities = eventEntities(env, o.entities, 'entities');
    const evidenceId = await evidenceArg(env, o);
    return addEvent(env.db, {
      summary,
      ...(details === undefined ? {} : { details }),
      ...(keywords ? { keywords } : {}),
      times,
      ...(entities ? { entities } : {}),
      ...ev(evidenceId),
    });
  },
  async update_event(env, o) {
    const id = BigInt(int(o, 'id'));
    const summary = optStr(o, 'summary');
    const keywords = keywordsArg(o.keywords);
    const times = o.time === undefined ? undefined : parseEventTimes(env.registry, o.time);
    const ent = optObj(o, 'entities');
    let entities: { add?: EventEntityIn[]; remove?: EventEntityIn[] } | undefined;
    if (ent) {
      for (const k of Object.keys(ent)) {
        if (k !== 'add' && k !== 'remove') {
          throw new RemoraError('invalid_param', `unknown entities field ${k}`, { field: 'entities' });
        }
      }
      const add = eventEntities(env, ent.add, 'entities.add');
      const remove = eventEntities(env, ent.remove, 'entities.remove');
      entities = { ...(add ? { add } : {}), ...(remove ? { remove } : {}) };
    }
    const evidenceId = await evidenceArg(env, o);
    return updateEvent(env.db, {
      id,
      ...(summary === undefined ? {} : { summary }),
      ...(o.details === undefined ? {} : { details: o.details as string | null }),
      ...(keywords ? { keywords } : {}),
      ...(times ? { times } : {}),
      ...(entities ? { entities } : {}),
      ...ev(evidenceId),
    });
  },
  async retract_event(env, o) {
    const id = BigInt(int(o, 'id'));
    const evidenceId = await evidenceArg(env, o);
    return retractEvent(env.db, { id, ...ev(evidenceId) });
  },
  async add_property(env, o) {
    const entity = entityArg(env, o, 'entity');
    const property = str(o, 'property');
    const value = requireValue(o);
    const spans = parseSpans(env.registry, o.time);
    const evidenceId = await evidenceArg(env, o);
    return addProperty(env.db, { entity, property, value, spans, ...ev(evidenceId) });
  },
  async replace_property(env, o) {
    const entity = entityArg(env, o, 'entity');
    const property = str(o, 'property');
    const value = requireValue(o);
    const moment = o.time === undefined ? undefined : parseMoment(env.registry, o.time);
    const evidenceId = await evidenceArg(env, o);
    return replaceProperty(env.db, { entity, property, value, ...(moment ? { moment } : {}), ...ev(evidenceId) });
  },
  async end_property(env, o) {
    const entity = entityArg(env, o, 'entity');
    const property = str(o, 'property');
    const moment = parseMoment(env.registry, o.time);
    const evidenceId = await evidenceArg(env, o);
    return endProperty(env.db, { entity, property, moment, ...ev(evidenceId) });
  },
  async retract_property(env, o) {
    const id = BigInt(int(o, 'id'));
    const evidenceId = await evidenceArg(env, o);
    return retractProperty(env.db, { id, ...ev(evidenceId) });
  },
  async add_relation(env, o) {
    const type = str(o, 'type');
    const from = entityArg(env, o, 'from');
    const to = entityArg(env, o, 'to');
    const spans = parseSpans(env.registry, o.time);
    const evidenceId = await evidenceArg(env, o);
    return addRelation(env.db, { type, from, to, spans, ...ev(evidenceId) });
  },
  async end_relation(env, o) {
    const ref = relationRef(env, o);
    const moment = parseMoment(env.registry, o.time);
    const evidenceId = await evidenceArg(env, o);
    return endRelation(env.db, { ref, moment, ...ev(evidenceId) });
  },
  async retract_relation(env, o) {
    const ref = relationRef(env, o);
    const axisName = optStr(o, 'axis');
    const axis = axisName === undefined ? undefined : env.registry.getAxis(axisName);
    const evidenceId = await evidenceArg(env, o);
    return retractRelation(env.db, { ref, ...(axis ? { axis } : {}), ...ev(evidenceId) });
  },
};

/** Names of the implemented apply ops (the contract schemas must cover exactly these). */
export const APPLY_OP_NAMES: readonly string[] = Object.keys(HANDLERS);

/** snake_case + JSON-number conversion of service results (bigint -> number). */
export function toApi(x: unknown): unknown {
  if (typeof x === 'bigint') return Number(x);
  if (x instanceof Date) return x.toISOString();
  if (Array.isArray(x)) return x.map(toApi);
  if (isObj(x)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(x)) {
      out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = toApi(v);
    }
    return out;
  }
  return x;
}

/** Services report encoded axis values in invalid_time details; present them decoded (or drop them). */
function normaliseDetails(
  e: RemoraError,
  op: unknown,
  registry: PluginRegistry,
): Record<string, unknown> | undefined {
  if (!e.details) return undefined;
  if (e.code !== 'invalid_time' || !('from' in e.details || 'at' in e.details)) {
    return toApi(e.details) as Record<string, unknown>;
  }
  const { from, at, ...rest } = e.details;
  const out = toApi(rest) as Record<string, unknown>;
  const axisName = isObj(op) && isObj(op.time) ? op.time.axis : undefined;
  if (typeof axisName === 'string') {
    try {
      const axis = registry.getAxis(axisName);
      out.axis = axis.name;
      if (typeof from === 'string' || typeof from === 'bigint') out.from = axis.def.decode(BigInt(from));
      if (typeof at === 'string' || typeof at === 'bigint') out.at = axis.def.decode(BigInt(at));
    } catch {
      // no decodable axis: raw values stay out of the response
    }
  }
  return out;
}

export function failure(index: number, e: RemoraError, op: unknown, registry: PluginRegistry): ApplyResponse {
  const details = normaliseDetails(e, op, registry);
  const error: ApiError = { op_index: index, code: e.code, message: e.message };
  if (details !== undefined) error.details = details;
  return { ok: false, error };
}

/** Returns an Error when ROLLBACK failed, so the client (unknown tx state) is destroyed on release. */
export async function rollback(client: pg.PoolClient): Promise<Error | undefined> {
  try {
    await client.query('ROLLBACK');
    return undefined;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

export async function apply(pool: pg.Pool, registry: PluginRegistry, request: unknown): Promise<ApplyResponse> {
  const invalid = (message: string): ApplyResponse => ({
    ok: false,
    error: { op_index: -1, code: 'invalid_param', message },
  });
  if (!isObj(request)) return invalid('request must be an object {ops: [...]}');
  const ops = request.ops;
  if (!Array.isArray(ops) || ops.length === 0) return invalid('ops must be a non-empty array');
  if (ops.length > MAX_OPS) {
    return {
      ok: false,
      error: { op_index: -1, code: 'invalid_param', message: `at most ${MAX_OPS} ops per request`, details: { limit: MAX_OPS } },
    };
  }

  const client = await pool.connect();
  let destroy: Error | undefined;
  try {
    await client.query('BEGIN');
    const env: Env = { db: client, registry, bindings: new Map() };
    const results: unknown[] = [];
    for (let i = 0; i < ops.length; i++) {
      const op: unknown = ops[i];
      try {
        if (!isObj(op)) throw new RemoraError('invalid_param', 'op must be an object');
        const name = op.op;
        const handler =
          typeof name === 'string' && Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
        if (!handler) {
          throw new RemoraError('invalid_param', `unknown op: ${String(name)}`, { op: name });
        }
        let as: string | undefined;
        if (op.as !== undefined) {
          if (typeof op.as !== 'string' || op.as === '' || op.as.startsWith('$')) {
            throw new RemoraError('invalid_param', 'as must be a non-empty string not starting with $', {
              field: 'as',
            });
          }
          if (env.bindings.has(op.as)) {
            throw new RemoraError('invalid_param', `duplicate name ${op.as}`, { field: 'as' });
          }
          as = op.as;
        }
        const result = toApi(await handler(env, op)) as Obj;
        if (as !== undefined) {
          result.as = as;
          env.bindings.set(as, { op: String(op.op), result });
        }
        results.push(result);
      } catch (e) {
        const mapped = e instanceof RemoraError ? e : mapPgError(e);
        if (!mapped) throw e;
        destroy = await rollback(client);
        return failure(i, mapped, op, registry);
      }
    }
    try {
      await client.query('COMMIT');
    } catch (e) {
      const mapped = mapPgError(e);
      if (!mapped) throw e;
      destroy = await rollback(client);
      // not tied to a single op: batch-level failure
      return failure(-1, mapped, undefined, registry);
    }
    return { ok: true, results };
  } catch (e) {
    destroy = (await rollback(client)) ?? destroy;
    throw e;
  } finally {
    client.release(destroy);
  }
}
