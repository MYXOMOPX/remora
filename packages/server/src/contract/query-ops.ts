import { limitProp, opSchema, when, type JsonSchema } from './common.js';

export type QueryOpName =
  | 'get_entity'
  | 'find_entities'
  | 'property_at'
  | 'property_history'
  | 'relation_history'
  | 'neighbors'
  | 'list_relation_types'
  | 'find_relation_types'
  | 'list_property_types'
  | 'find_property_types'
  | 'list_evidence_sources'
  | 'get_evidence'
  | 'get_event'
  | 'search_events'
  | 'entity_events'
  | 'list_event_roles'
  | 'list_time_axes';

const text = (what: string): JsonSchema => ({ type: 'string', description: what });

const strings = (what: string, minItems?: number): JsonSchema => ({
  type: 'array',
  items: { type: 'string' },
  ...(minItems === undefined ? {} : { minItems }),
  description: what,
});

const direction: JsonSchema = {
  enum: ['out', 'in', 'both'],
  description: 'Edge direction relative to the entity; ignored for symmetric relation types.',
};

const includeRetracted: JsonSchema = {
  type: 'boolean',
  description: 'Also return retracted versions (marked with retracted_at). Default false.',
};

const entityParam = (what: string): JsonSchema => ({ type: 'string', description: what });

const idParam = (what: string): JsonSchema => ({ type: 'integer', minimum: 1, description: `Id of the ${what}.` });

const noArgs = (name: QueryOpName, description: string): JsonSchema => opSchema(name, description, { op: name }, {});

export const QUERY_OPS: Record<QueryOpName, JsonSchema> = {
  get_entity: opSchema(
    'get_entity',
    'Check that an entity exists and return its key. Errors: unknown_entity.',
    { op: 'get_entity', key: 'bob' },
    { key: entityParam('Entity key.') },
    ['key'],
  ),
  find_entities: opSchema(
    'find_entities',
    'Find entities whose key contains the words of the query (substring match, no ranking). Returns {rows: [{key}], total, truncated}; when truncated, narrow the query.',
    { op: 'find_entities', query: 'bob', limit: 10 },
    { query: text('Words to look for in entity keys.'), limit: limitProp('entities') },
    ['query'],
  ),
  property_at: opSchema(
    'property_at',
    'Values of one property of an entity at a point or period in time. "when" is required: {axis, at} returns the values valid at that moment, {axis, during: [from, to]} the values overlapping the period; timeless values are always included. Single-valued properties return at most one row, multi-valued ones several, each with its version id and time. Errors: unknown_entity, unknown_type, unknown_axis, invalid_time.',
    { op: 'property_at', entity: 'bob', property: 'job_title', when: { axis: 'game_day', at: 300 } },
    {
      entity: entityParam('Entity key.'),
      property: text('Property type name.'),
      when,
    },
    ['entity', 'property', 'when'],
  ),
  property_history: opSchema(
    'property_history',
    'Every recorded version of one property of an entity, with intervals, version ids and evidence ids. Optionally restrict to the versions on one axis, or include retracted versions. Errors: unknown_entity, unknown_type, unknown_axis.',
    { op: 'property_history', entity: 'bob', property: 'job_title' },
    {
      entity: entityParam('Entity key.'),
      property: text('Property type name.'),
      axis: text('Only versions on this axis.'),
      include_retracted: includeRetracted,
    },
    ['entity', 'property'],
  ),
  relation_history: opSchema(
    'relation_history',
    'Relations of an entity with their time versions and relation_id. Filter by relation type names, direction (default both) and "when" (omitted: all versions). Returns {rows, total, truncated}; when truncated, narrow the query. Errors: unknown_entity, unknown_type, invalid_time.',
    { op: 'relation_history', entity: 'bob', relation_types: ['works_at'], direction: 'out' },
    {
      entity: entityParam('Entity key.'),
      relation_types: strings('Relation type names to include (non-empty when given).', 1),
      direction,
      when,
      include_retracted: includeRetracted,
      limit: limitProp('relation versions'),
    },
    ['entity'],
  ),
  neighbors: opSchema(
    'neighbors',
    'Walk the graph from an entity up to "depth" hops (1-6) and return each reachable entity once, with its minimum depth and the edge it was reached by ("via", plus "via_count" when several parallel edges exist). "include" pulls property values of the reached entities into each row; "order_by" sorts the rows by a property and "limit" (default 50, max 200) applies to entities. "when" filters every step by time. With paths true the full chains of relations are returned instead of "via" (at most 10000 paths, otherwise too_many_paths). Returns {rows, total, truncated}; when truncated, narrow the query. Example: the tallest friend of Bob is depth 1, include ["height"], order_by {property: "height", dir: "desc"}, limit 1. Errors: unknown_entity, unknown_type, too_many_paths.',
    {
      op: 'neighbors',
      entity: 'bob',
      relation_types: ['friend_of'],
      depth: 1,
      include: ['height'],
      order_by: { property: 'height', dir: 'desc' },
      limit: 1,
    },
    {
      entity: entityParam('Start entity key.'),
      relation_types: strings('Relation type names to follow (non-empty when given; default all).', 1),
      direction,
      depth: { type: 'integer', minimum: 1, maximum: 6, description: 'Number of hops, 1 to 6 (default 1).' },
      when,
      include: strings('Property type names to attach to each row.'),
      order_by: {
        type: 'object',
        additionalProperties: false,
        required: ['property'],
        description: 'Sort rows by a property value.',
        properties: {
          property: text('Property type name.'),
          dir: { enum: ['asc', 'desc'], description: 'Sort direction (default asc).' },
        },
      },
      limit: limitProp('entities'),
      paths: { type: 'boolean', description: 'Return full paths instead of one edge per entity. Default false.' },
    },
    ['entity'],
  ),
  list_relation_types: noArgs(
    'list_relation_types',
    'List all relation types with their descriptions and whether they are directed. Call this before creating a relation type.',
  ),
  find_relation_types: opSchema(
    'find_relation_types',
    'Find relation types whose name or description contains the words of the query (substring match, no similarity scores).',
    { op: 'find_relation_types', query: 'employment' },
    { query: text('Words to look for.') },
    ['query'],
  ),
  list_property_types: noArgs(
    'list_property_types',
    'List all property types with descriptions, value types and whether they are single-valued. Call this before creating a property type.',
  ),
  find_property_types: opSchema(
    'find_property_types',
    'Find property types whose name or description contains the words of the query (substring match, no similarity scores).',
    { op: 'find_property_types', query: 'job' },
    { query: text('Words to look for.') },
    ['query'],
  ),
  list_evidence_sources: noArgs(
    'list_evidence_sources',
    'List the evidence sources with their descriptions and payload schemas; use it to build the "payload" of add_evidence.',
  ),
  get_evidence: opSchema(
    'get_evidence',
    'Fetch one evidence record by id: source, payload, creation time, whether its payload was purged and whether it is pinned. Errors: not_found.',
    { op: 'get_evidence', id: 7 },
    { id: idParam('evidence record') },
    ['id'],
  ),
  get_event: opSchema(
    'get_event',
    'Fetch one event by id with its summary, details, keywords, times and linked entities. Errors: not_found.',
    { op: 'get_event', id: 12 },
    { id: idParam('event') },
    ['id'],
  ),
  search_events: opSchema(
    'search_events',
    'Search events. All given filters are combined with AND: "text" (every word must appear in the summary or details), "keywords" (any of them, or all with match "all"), "entities" (events linked to the listed entities), and "when" (events overlapping the moment or period). Retracted events are never returned. Returns {rows, total, truncated}; when truncated, narrow the query. Errors: unknown_entity, invalid_time.',
    { op: 'search_events', keywords: ['party'], match: 'any', when: { axis: 'game_day', during: [290, 310] } },
    {
      text: text('Words that must all appear in the summary or details.'),
      keywords: strings('Keywords to match (non-empty when given).', 1),
      match: { enum: ['any', 'all'], description: 'Whether any or all keywords must match (default any).' },
      entities: strings('Entity keys the event must involve (non-empty when given).', 1),
      when,
      limit: limitProp('events'),
    },
  ),
  entity_events: opSchema(
    'entity_events',
    'Events linked to one entity, optionally filtered by "when". Returns {rows, total, truncated}; when truncated, narrow the query. Errors: unknown_entity, invalid_time.',
    { op: 'entity_events', entity: 'bob', when: { axis: 'game_day', at: 292 } },
    { entity: entityParam('Entity key.'), when, limit: limitProp('events') },
    ['entity'],
  ),
  list_event_roles: noArgs(
    'list_event_roles',
    'List the roles already used to link entities to events, so new events reuse the same vocabulary.',
  ),
  list_time_axes: noArgs(
    'list_time_axes',
    'List the available time axes with a description, the JSON Schema of their values ("value_schema") and an "example" value. Time values in apply and query ops must follow these schemas.',
  ),
};
