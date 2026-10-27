import { ERROR_CODES } from '@remora/sdk';
import type { ApplyOpName } from './apply-ops.js';
import type { JsonSchema } from './common.js';
import type { QueryOpName } from './query-ops.js';

// R33: derived from what the handlers return today. additionalProperties stays open (the server may add
// fields in a minor version); user and plugin data (values, payloads, schemas, axis values) are `{}`.

const int: JsonSchema = { type: 'integer' };
const str: JsonSchema = { type: 'string' };
const bool: JsonSchema = { type: 'boolean' };
const nullable = (s: JsonSchema): JsonSchema => ({ oneOf: [s, { type: 'null' }] });
const ints: JsonSchema = { type: 'array', items: int };
const strs: JsonSchema = { type: 'array', items: str };
const timestamp: JsonSchema = { type: 'string', description: 'ISO-8601 timestamp.' };

function obj(properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties)): JsonSchema {
  return { type: 'object', required, properties };
}

const rows = (item: JsonSchema, extra: Record<string, JsonSchema> = {}): JsonSchema =>
  obj({ rows: { type: 'array', items: item }, ...extra });

const page = (item: JsonSchema): JsonSchema =>
  rows(item, { total: int, truncated: { type: 'boolean', description: 'True when more rows exist than were returned.' } });

/** Time of a fact: {axis, from?, to?} (axis values are plugin data), or null for a timeless fact. */
const factTime: JsonSchema = nullable({
  type: 'object',
  required: ['axis'],
  properties: { axis: str, from: {}, to: {} },
});

/** Event time item: {axis, at} for an instant, {axis, from?, to?} for a period. */
const eventTimeItem: JsonSchema = {
  type: 'object',
  required: ['axis'],
  properties: { axis: str, at: {}, from: {}, to: {} },
};

/** Apply results echo the local name of ops that declared `as`. */
const withAs = (properties: Record<string, JsonSchema>): JsonSchema =>
  obj({ ...properties, as: str }, Object.keys(properties));

/** The error object of every failed response. */
export const apiErrorSchema: JsonSchema = {
  type: 'object',
  description:
    'A failed request. op_index is the index of the failing op (-1 when the request itself is invalid); the whole batch is rolled back.',
  required: ['op_index', 'code', 'message'],
  properties: {
    op_index: { type: 'integer', minimum: -1 },
    code: { type: 'string', enum: [...ERROR_CODES] },
    message: str,
    details: { type: 'object' },
  },
};

function envelope(what: string): JsonSchema {
  return {
    description: `Response of ${what}: {ok: true, results: [one result per op, in order]} or {ok: false, error}.`,
    oneOf: [
      { type: 'object', required: ['ok', 'results'], properties: { ok: { const: true }, results: { type: 'array' } } },
      { type: 'object', required: ['ok', 'error'], properties: { ok: { const: false }, error: apiErrorSchema } },
    ],
  };
}

export const applyResponseSchema: JsonSchema = envelope('apply');
export const queryResponseSchema: JsonSchema = envelope('query');

const typeRow = (extra: Record<string, JsonSchema>): JsonSchema =>
  obj({ id: int, name: str, description: str, ...extra });

export const APPLY_RESULTS: Record<ApplyOpName, JsonSchema> = {
  add_evidence: withAs({ id: int }),
  add_event: withAs({ id: int }),
  update_event: withAs({ id: int }),
  retract_event: withAs({ id: int }),
  create_entity: withAs({ key: str, created: bool }),
  add_property: withAs({ ids: ints }),
  replace_property: withAs({ closed: ints, retracted: ints, ids: ints }),
  end_property: withAs({ closed: ints }),
  retract_property: withAs({ id: int }),
  add_relation: withAs({ relation_id: int, ids: ints }),
  end_relation: withAs({ closed: ints }),
  retract_relation: withAs({ retracted: ints }),
  create_relation_type: withAs({ id: int, name: str, description: str, directed: bool }),
  create_property_type: withAs({ id: int, name: str, description: str, value_type: str, single_valued: bool }),
};

const factMeta: Record<string, JsonSchema> = {
  time: factTime,
  evidence_id: nullable(int),
  recorded_at: timestamp,
  retracted_at: timestamp,
};
const factRequired = ['time', 'evidence_id', 'recorded_at'];

const propertyRow: JsonSchema = obj({ id: int, value: {}, ...factMeta }, ['id', 'value', ...factRequired]);
const relationRow: JsonSchema = obj({ id: int, relation_id: int, type: str, from: str, to: str, ...factMeta }, [
  'id',
  'relation_id',
  'type',
  'from',
  'to',
  ...factRequired,
]);

const step = (extra: Record<string, JsonSchema>): JsonSchema =>
  obj({ relation: str, from: str, relation_id: int, time: factTime, ...extra });

const neighborRow: JsonSchema = obj(
  {
    entity: str,
    depth: int,
    via: step({}),
    via_count: int,
    paths: { type: 'array', items: { type: 'array', items: step({ to: str }) } },
    properties: { type: 'object', additionalProperties: { type: 'array' } },
  },
  ['entity', 'depth'],
);

const relationType = typeRow({ directed: bool });
const propertyType = typeRow({ value_type: str, single_valued: bool });

const eventRow: JsonSchema = obj(
  {
    id: int,
    summary: str,
    details: nullable(str),
    keywords: strs,
    time: { type: 'array', items: eventTimeItem },
    entities: { type: 'array', items: obj({ entity: str, role: str }) },
    evidence_id: nullable(int),
    recorded_at: timestamp,
    updated_at: nullable(timestamp),
    retracted_at: timestamp,
  },
  ['id', 'summary', 'details', 'keywords', 'time', 'entities', 'evidence_id', 'recorded_at', 'updated_at'],
);

export const QUERY_RESULTS: Record<QueryOpName, JsonSchema> = {
  get_entity: obj({ key: str }),
  find_entities: page(obj({ key: str })),
  property_at: rows(propertyRow),
  property_history: rows(propertyRow),
  relation_history: page(relationRow),
  neighbors: page(neighborRow),
  list_relation_types: rows(relationType),
  find_relation_types: rows(relationType),
  list_property_types: rows(propertyType),
  find_property_types: rows(propertyType),
  list_evidence_sources: rows(obj({ name: str, description: str, payload_schema: {} })),
  get_evidence: obj({
    id: int,
    source: str,
    payload: {},
    created_at: timestamp,
    purged_at: nullable(timestamp),
    pinned: bool,
  }),
  get_event: eventRow,
  search_events: page(eventRow),
  entity_events: page(eventRow),
  list_event_roles: obj({ roles: strs }),
  list_time_axes: rows(obj({ name: str, description: str, value_schema: {}, example: {} }, ['name', 'description'])),
};
