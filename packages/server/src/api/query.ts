import { RemoraError } from '@remora/sdk';
import type pg from 'pg';
import type { Queryable } from '../db/types.js';
import type { PluginRegistry } from '../plugins/registry.js';
import {
  findPropertyTypes,
  findRelationTypes,
  listPropertyTypes,
  listRelationTypes,
  listTimeAxes,
  type PropertyType,
  type RelationType,
} from '../services/dictionaries.js';
import { findEntities, requireEntity } from '../services/entities.js';
import { entityEvents, getEvent, listEventRoles, searchEvents, type EventRow } from '../services/events-read.js';
import { getEvidence, listEvidenceSources } from '../services/evidence.js';
import {
  propertyAt,
  propertyHistory,
  relationHistory,
  type PropertyRow,
  type RelationRow,
} from '../services/facts-read.js';
import { neighbors, type NeighborRow } from '../services/neighbors.js';
import { parseWhen } from '../services/time.js';
import { int, isObj, optBool, optInt, optStr, optStrArr, str, type Obj } from './args.js';
import { failure, mapPgError, rollback, type ApiError } from './apply.js';
import { MAX_OPS } from './limits.js';

export type QueryResponse = { ok: true; results: unknown[] } | { ok: false; error: ApiError };

interface Env {
  db: Queryable;
  registry: PluginRegistry;
}

type Handler = (env: Env, o: Obj) => Promise<unknown>;

// Rows are converted field by field: `value`, `time` and axis schemas are plugin/user data
// and must not go through the key-renaming toApi.
function withMeta(base: Obj, r: PropertyRow | RelationRow): Obj {
  const out: Obj = {
    ...base,
    time: r.time,
    evidence_id: r.evidenceId === null ? null : Number(r.evidenceId),
    recorded_at: r.recordedAt.toISOString(),
  };
  if (r.retractedAt !== null) out.retracted_at = r.retractedAt.toISOString();
  return out;
}

const propertyRow = (r: PropertyRow): Obj => withMeta({ id: Number(r.id), value: r.value }, r);

const relationRow = (r: RelationRow): Obj =>
  withMeta(
    { id: Number(r.id), relation_id: Number(r.relationId), type: r.type, from: r.from, to: r.to },
    r,
  );

const relationType = (t: RelationType): Obj => ({
  id: t.id,
  name: t.name,
  description: t.description,
  directed: t.directed,
});

const propertyType = (t: PropertyType): Obj => ({
  id: t.id,
  name: t.name,
  description: t.description,
  value_type: t.valueType,
  single_valued: t.singleValued,
});

function neighborRow(r: NeighborRow): Obj {
  const out: Obj = { entity: r.entity, depth: r.depth };
  if (r.via) {
    out.via = {
      relation: r.via.relation,
      from: r.via.from,
      relation_id: Number(r.via.relationId),
      time: r.via.time,
    };
  }
  if (r.viaCount !== undefined) out.via_count = r.viaCount;
  if (r.paths !== undefined) {
    out.paths = r.paths.map((p) =>
      p.map((s) => ({
        relation: s.relation,
        from: s.from,
        to: s.to,
        relation_id: Number(s.relationId),
        time: s.time,
      })),
    );
  }
  if (r.properties !== undefined) out.properties = r.properties;
  return out;
}

function eventRow(r: EventRow): Obj {
  const out: Obj = {
    id: Number(r.id),
    summary: r.summary,
    details: r.details,
    keywords: r.keywords,
    time: r.time,
    entities: r.entities.map((e) => ({ entity: e.entity, role: e.role })),
    evidence_id: r.evidenceId === null ? null : Number(r.evidenceId),
    recorded_at: r.recordedAt.toISOString(),
    updated_at: r.updatedAt === null ? null : r.updatedAt.toISOString(),
  };
  if (r.retractedAt !== null) out.retracted_at = r.retractedAt.toISOString();
  return out;
}

function invalid(message: string, field: string): RemoraError {
  return new RemoraError('invalid_param', message, { field });
}

const HANDLERS: Record<string, Handler> = {
  async get_entity({ db }, o) {
    return { key: (await requireEntity(db, str(o, 'key'))).key };
  },
  async find_entities({ db }, o) {
    const query = str(o, 'query');
    const limit = optInt(o, 'limit');
    const r = await findEntities(db, { query, ...(limit !== undefined ? { limit } : {}) });
    return { rows: r.rows.map((e) => ({ key: e.key })), total: r.total, truncated: r.truncated };
  },
  async property_at({ db, registry }, o) {
    const entity = str(o, 'entity');
    const property = str(o, 'property');
    const when = parseWhen(registry, o.when);
    if (when === undefined) throw invalid('when is required', 'when');
    const rows = await propertyAt(db, registry, { entity, property, when });
    return { rows: rows.map(propertyRow) };
  },
  async property_history({ db, registry }, o) {
    const entity = str(o, 'entity');
    const property = str(o, 'property');
    const axisName = optStr(o, 'axis');
    const includeRetracted = optBool(o, 'include_retracted');
    const rows = await propertyHistory(db, registry, {
      entity,
      property,
      ...(axisName !== undefined ? { axis: registry.getAxis(axisName) } : {}),
      ...(includeRetracted !== undefined ? { includeRetracted } : {}),
    });
    return { rows: rows.map(propertyRow) };
  },
  async relation_history({ db, registry }, o) {
    const entity = str(o, 'entity');
    const relationTypes = optStrArr(o, 'relation_types');
    if (relationTypes !== undefined && relationTypes.length === 0) {
      throw invalid('relation_types must not be empty', 'relation_types');
    }
    const direction = optStr(o, 'direction');
    if (direction !== undefined && direction !== 'out' && direction !== 'in' && direction !== 'both') {
      throw invalid('direction must be out, in or both', 'direction');
    }
    const when = parseWhen(registry, o.when);
    const includeRetracted = optBool(o, 'include_retracted');
    const limit = optInt(o, 'limit');
    const r = await relationHistory(db, registry, {
      entity,
      ...(relationTypes !== undefined ? { relationTypes } : {}),
      ...(direction !== undefined ? { direction } : {}),
      ...(when !== undefined ? { when } : {}),
      ...(includeRetracted !== undefined ? { includeRetracted } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { rows: r.rows.map(relationRow), total: r.total, truncated: r.truncated };
  },
  async neighbors({ db, registry }, o) {
    const entity = str(o, 'entity');
    const relationTypes = optStrArr(o, 'relation_types');
    const direction = optStr(o, 'direction');
    if (direction !== undefined && direction !== 'out' && direction !== 'in' && direction !== 'both') {
      throw invalid('direction must be out, in or both', 'direction');
    }
    const depth = optInt(o, 'depth');
    const when = parseWhen(registry, o.when);
    const include = optStrArr(o, 'include');
    let orderBy: { property: string; dir?: 'asc' | 'desc' } | undefined;
    if (o.order_by !== undefined) {
      if (!isObj(o.order_by)) throw invalid('order_by must be an object {property, dir?}', 'order_by');
      const dir = optStr(o.order_by, 'dir');
      if (dir !== undefined && dir !== 'asc' && dir !== 'desc') {
        throw invalid('order_by.dir must be asc or desc', 'order_by');
      }
      orderBy = { property: str(o.order_by, 'property'), ...(dir !== undefined ? { dir } : {}) };
    }
    const limit = optInt(o, 'limit');
    const paths = optBool(o, 'paths');
    const r = await neighbors(db, registry, {
      entity,
      ...(relationTypes !== undefined ? { relationTypes } : {}),
      ...(direction !== undefined ? { direction } : {}),
      ...(depth !== undefined ? { depth } : {}),
      ...(when !== undefined ? { when } : {}),
      ...(include !== undefined ? { include } : {}),
      ...(orderBy !== undefined ? { orderBy } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(paths !== undefined ? { paths } : {}),
    });
    return { rows: r.rows.map(neighborRow), total: r.total, truncated: r.truncated };
  },
  async list_relation_types({ db }) {
    return { rows: (await listRelationTypes(db)).map(relationType) };
  },
  async find_relation_types({ db }, o) {
    return { rows: (await findRelationTypes(db, str(o, 'query'))).map(relationType) };
  },
  async list_property_types({ db }) {
    return { rows: (await listPropertyTypes(db)).map(propertyType) };
  },
  async find_property_types({ db }, o) {
    return { rows: (await findPropertyTypes(db, str(o, 'query'))).map(propertyType) };
  },
  async list_evidence_sources({ db }) {
    const rows = await listEvidenceSources(db);
    return {
      rows: rows.map((s) => ({ name: s.name, description: s.description, payload_schema: s.payloadSchema })),
    };
  },
  async get_evidence({ db }, o) {
    const id = int(o, 'id');
    if (id < 1) throw invalid('id must be a positive integer', 'id');
    const e = await getEvidence(db, BigInt(id));
    return {
      id: Number(e.id),
      source: e.source,
      payload: e.payload,
      created_at: e.createdAt.toISOString(),
      purged_at: e.purgedAt === null ? null : e.purgedAt.toISOString(),
      pinned: e.pinned,
    };
  },
  async get_event({ db, registry }, o) {
    const id = int(o, 'id');
    if (id < 1) throw invalid('id must be a positive integer', 'id');
    return eventRow(await getEvent(db, registry, BigInt(id)));
  },
  async search_events({ db, registry }, o) {
    const text = optStr(o, 'text');
    const keywords = optStrArr(o, 'keywords');
    const match = optStr(o, 'match') as 'any' | 'all' | undefined; // validated by searchEvents
    const entities = optStrArr(o, 'entities');
    const when = parseWhen(registry, o.when);
    const limit = optInt(o, 'limit');
    const r = await searchEvents(db, registry, {
      ...(text !== undefined ? { text } : {}),
      ...(keywords !== undefined ? { keywords } : {}),
      ...(match !== undefined ? { match } : {}),
      ...(entities !== undefined ? { entities } : {}),
      ...(when !== undefined ? { when } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { rows: r.rows.map(eventRow), total: r.total, truncated: r.truncated };
  },
  async entity_events({ db, registry }, o) {
    const entity = str(o, 'entity');
    const when = parseWhen(registry, o.when);
    const limit = optInt(o, 'limit');
    const r = await entityEvents(db, registry, {
      entity,
      ...(when !== undefined ? { when } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { rows: r.rows.map(eventRow), total: r.total, truncated: r.truncated };
  },
  async list_event_roles({ db }) {
    return { roles: await listEventRoles(db) };
  },
  async list_time_axes({ db }) {
    const axes = await listTimeAxes(db);
    return {
      rows: axes.map((a) => ({
        name: a.name,
        description: a.description,
        value_schema: a.valueSchema,
        example: a.example,
      })),
    };
  },
};

/** Names of the implemented query ops (the contract schemas must cover exactly these). */
export const QUERY_OP_NAMES: readonly string[] = Object.keys(HANDLERS);

export async function query(pool: pg.Pool, registry: PluginRegistry, request: unknown): Promise<QueryResponse> {
  const bad = (message: string): QueryResponse => ({
    ok: false,
    error: { op_index: -1, code: 'invalid_param', message },
  });
  if (!isObj(request)) return bad('request must be an object {ops: [...]}');
  const ops = request.ops;
  if (!Array.isArray(ops) || ops.length === 0) return bad('ops must be a non-empty array');
  if (ops.length > MAX_OPS) {
    return {
      ok: false,
      error: { op_index: -1, code: 'invalid_param', message: `at most ${MAX_OPS} ops per request`, details: { limit: MAX_OPS } },
    };
  }

  const client = await pool.connect();
  let destroy: Error | undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const env: Env = { db: client, registry };
    const results: unknown[] = [];
    for (let i = 0; i < ops.length; i++) {
      const op: unknown = ops[i];
      try {
        if (!isObj(op)) throw new RemoraError('invalid_param', 'op must be an object');
        const name = op.op;
        const handler = typeof name === 'string' && Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
        if (!handler) {
          throw new RemoraError('invalid_param', `unknown op: ${String(name)}`, { op: name });
        }
        results.push(await handler(env, op));
      } catch (e) {
        const mapped = e instanceof RemoraError ? e : mapPgError(e);
        if (!mapped) throw e;
        destroy = await rollback(client);
        return failure(i, mapped, op, registry);
      }
    }
    destroy = await rollback(client);
    if (destroy) throw destroy;
    return { ok: true, results };
  } catch (e) {
    destroy = (await rollback(client)) ?? destroy;
    throw e;
  } finally {
    client.release(destroy);
  }
}
