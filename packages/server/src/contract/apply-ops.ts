import {
  asName,
  entityRef,
  evidenceRef,
  eventEntity,
  eventTime,
  momentTime,
  opSchema,
  relationSelectorOneOf,
  relationSelectorProps,
  spanTime,
  type JsonSchema,
} from './common.js';

export type ApplyOpName =
  | 'add_evidence'
  | 'add_event'
  | 'update_event'
  | 'retract_event'
  | 'create_entity'
  | 'add_property'
  | 'replace_property'
  | 'end_property'
  | 'retract_property'
  | 'add_relation'
  | 'end_relation'
  | 'retract_relation'
  | 'create_relation_type'
  | 'create_property_type';

/** Write op: every apply op may carry `as`. */
function write(
  name: ApplyOpName,
  description: string,
  example: Record<string, unknown>,
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  extra: JsonSchema = {},
): JsonSchema {
  return opSchema(name, description, example, { ...properties, as: asName }, required, extra);
}

const idProp = (what: string): JsonSchema => ({ type: 'integer', description: `Id of the ${what}.` });

const text = (what: string): JsonSchema => ({ type: 'string', description: what });

const evidence = evidenceRef;

export const APPLY_OPS: Record<ApplyOpName, JsonSchema> = {
  add_evidence: write(
    'add_evidence',
    'Record raw source material (a chat message, a document, ...) as evidence that later ops can cite. "source" names an evidence source (list_evidence_sources) and "payload" must match that source\'s payload_schema. Returns {id}; declare "as" and pass "$name" in the "evidence" field of later ops of the same batch. One evidence record may back any number of facts. Errors: unknown_source, invalid_payload.',
    { op: 'add_evidence', as: 'e1', source: 'chat_message', payload: { text: 'Bob says he got promoted.' } },
    {
      source: text('Name of the evidence source (see list_evidence_sources).'),
      payload: { description: "Source-specific payload; must match the source's payload_schema." },
    },
    ['source', 'payload'],
  ),
  add_event: write(
    'add_event',
    'Record an observation that does not fit a property or relation ("saw Bob do a backflip yesterday"). "summary" is one or two sentences, which is what search results show; "details" is optional longer text; "keywords" are matched case-insensitively; "entities" links the people and things involved, each with an optional role. "time" is required: an instant {axis, at} or a period {axis, from?, to?}, or a list with one entry per axis. Events are mutable (update_event) and can be retracted. Returns {id}. Errors: invalid_time, unknown_axis, unknown_entity.',
    {
      op: 'add_event',
      summary: 'Bob did a backflip at the party.',
      keywords: ['party', 'backflip'],
      time: { axis: 'game_day', at: 292 },
      entities: [{ entity: 'bob', role: 'actor' }],
    },
    {
      summary: text('One or two sentences describing what happened; must not be empty.'),
      details: text('Optional longer text.'),
      keywords: { type: 'array', items: { type: 'string' }, description: 'Search keywords (normalised to lower case).' },
      time: eventTime,
      entities: { type: 'array', items: eventEntity, description: 'Entities involved, each with an optional role.' },
      evidence,
    },
    ['summary', 'time'],
  ),
  update_event: write(
    'update_event',
    'Change an existing event. Give only the fields to change (at least one besides id): "summary"; "details" (a string, or null to clear); "keywords" as {set: [...]} to replace or {add?, remove?} to adjust; "time" to replace the event\'s times; "entities" as {add?, remove?}. Returns the event. Errors: not_found, invalid_param.',
    { op: 'update_event', id: 12, keywords: { add: ['celebration'] }, entities: { add: [{ entity: 'carl', role: 'witness' }] } },
    {
      id: idProp('event'),
      summary: text('New summary.'),
      details: { type: ['string', 'null'], description: 'New details text, or null to clear it.' },
      keywords: {
        type: 'object',
        additionalProperties: false,
        description: 'Either {set} (replace all) or {add?, remove?} (adjust).',
        properties: {
          set: { type: 'array', items: { type: 'string' } },
          add: { type: 'array', items: { type: 'string' } },
          remove: { type: 'array', items: { type: 'string' } },
        },
      },
      time: eventTime,
      entities: {
        type: 'object',
        additionalProperties: false,
        description: 'Entity links to add or remove.',
        properties: {
          add: { type: 'array', items: eventEntity },
          remove: { type: 'array', items: eventEntity },
        },
      },
      evidence,
    },
    ['id'],
  ),
  retract_event: write(
    'retract_event',
    'Retract an event that was recorded by mistake. The event disappears from search results but stays in the audit trail. Errors: not_found.',
    { op: 'retract_event', id: 12 },
    { id: idProp('event'), evidence },
    ['id'],
  ),
  create_entity: write(
    'create_entity',
    'Create an entity with the given key, or return the existing one (idempotent). Keys are free-form strings and must not start with "$". Entities must exist before properties or relations reference them. Returns {key, created}. Errors: invalid_name.',
    { op: 'create_entity', key: 'bob', as: 'bob' },
    { key: text('Unique entity key; must not start with "$".') },
    ['key'],
  ),
  add_property: write(
    'add_property',
    "Add a value of a property to an entity. For single-valued property types a new value must not overlap an existing one on the same axis (single_valued_conflict); multi-valued types accumulate. \"time\" is the validity interval {axis, from?, to?} (from inclusive, to exclusive), or a list with one entry per axis; omit it for a timeless fact. \"value\" is any JSON value (null is allowed) but must match the property type's value_type. Use replace_property to supersede the current value. Returns {id}. Errors: unknown_entity, unknown_type, value_type_mismatch, single_valued_conflict, timeless_conflict, invalid_time.",
    { op: 'add_property', entity: 'bob', property: 'height', value: 186, time: { axis: 'game_day', from: 100 } },
    {
      entity: entityRef,
      property: text('Property type name (see list_property_types).'),
      value: { description: "The value; its JSON type must match the property type's value_type." },
      time: spanTime,
      evidence,
    },
    ['entity', 'property', 'value'],
  ),
  replace_property: write(
    'replace_property',
    'Supersede the current value: open values of the property are closed at the given moment and the new value starts there. "time" is {axis, at}. Returns {id} of the new version. Errors: unknown_entity, unknown_type, value_type_mismatch, invalid_time.',
    { op: 'replace_property', entity: 'bob', property: 'job_title', value: 'Senior', time: { axis: 'game_day', at: 292 } },
    {
      entity: entityRef,
      property: text('Property type name.'),
      value: { description: 'The new value.' },
      time: momentTime,
      evidence,
    },
    ['entity', 'property', 'value'],
  ),
  end_property: write(
    'end_property',
    'Close the open values of a property at the given moment without adding a new one ("Bob no longer has a job"). "time" {axis, at} is required. Errors: unknown_entity, unknown_type, invalid_time.',
    { op: 'end_property', entity: 'bob', property: 'job_title', time: { axis: 'game_day', at: 300 } },
    { entity: entityRef, property: text('Property type name.'), time: momentTime, evidence },
    ['entity', 'property', 'time'],
  ),
  retract_property: write(
    'retract_property',
    'Retract a property version that was recorded by mistake (by the id from add_property or property_history). It stays in the audit trail but no longer counts as a fact. Errors: not_found.',
    { op: 'retract_property', id: 41 },
    { id: idProp('property version'), evidence },
    ['id'],
  ),
  add_relation: write(
    'add_relation',
    'Connect two entities with a relation of the given type (see list_relation_types). For directed types the relation goes from "from" to "to". "time" is the validity interval {axis, from?, to?} or a list with one entry per axis; omit it for a timeless relation. Returns {relation_id, ...}. Errors: unknown_entity, unknown_type, invalid_time.',
    { op: 'add_relation', type: 'works_at', from: 'bob', to: 'google', time: { axis: 'game_day', from: 292 } },
    {
      type: text('Relation type name.'),
      from: { ...entityRef, description: 'Source entity.' },
      to: { ...entityRef, description: 'Target entity.' },
      time: spanTime,
      evidence,
    },
    ['type', 'from', 'to'],
  ),
  end_relation: write(
    'end_relation',
    'End a relation at the given moment. Identify it by "relation_id", or by the selector type + from + to (all three, not mixed with relation_id). "time" {axis, at} is required. Errors: not_found, unknown_entity, unknown_type, invalid_time.',
    { op: 'end_relation', type: 'works_at', from: 'bob', to: 'google', time: { axis: 'game_day', at: 400 } },
    { ...relationSelectorProps, time: momentTime, evidence },
    ['time'],
    { oneOf: relationSelectorOneOf },
  ),
  retract_relation: write(
    'retract_relation',
    'Retract a relation that was recorded by mistake: all its time versions, or only those on one axis when "axis" is given. Identify it by "relation_id", or by the selector type + from + to (all three, not mixed with relation_id). Errors: not_found, unknown_axis.',
    { op: 'retract_relation', relation_id: 12 },
    {
      ...relationSelectorProps,
      axis: text('Only retract the versions on this axis.'),
      evidence,
    },
    [],
    { oneOf: relationSelectorOneOf },
  ),
  create_relation_type: write(
    'create_relation_type',
    'Define a new relation type. Look through list_relation_types / find_relation_types first and reuse an existing type when one fits. Names are normalised (lower case, spaces to underscores) and must be unique across relation and property types (name_taken). "directed" false makes the relation symmetric. "description" is shown to future readers, so say what the relation means. Returns {id, name, description, directed}. Errors: name_taken, invalid_name.',
    { op: 'create_relation_type', name: 'works_at', description: 'The person is employed at the organisation.', directed: true },
    {
      name: text('Type name.'),
      description: text('What the relation means.'),
      directed: { type: 'boolean', description: 'false for symmetric relations (e.g. friend_of).' },
    },
    ['name', 'description', 'directed'],
  ),
  create_property_type: write(
    'create_property_type',
    'Define a new property type. Look through list_property_types / find_property_types first and reuse an existing type when one fits. "value_type" is one of number, text, date, bool, json. "single_valued" true means at most one value at any moment on an axis (e.g. job_title); false allows several at once (e.g. hobby). Names are normalised and must be unique across relation and property types. Returns {id, name, description, value_type, single_valued}. Errors: name_taken, invalid_name, invalid_param.',
    { op: 'create_property_type', name: 'job_title', description: 'Current job title of a person.', value_type: 'text', single_valued: true },
    {
      name: text('Type name.'),
      description: text('What the property means.'),
      value_type: { enum: ['number', 'text', 'date', 'bool', 'json'], description: 'JSON type of the values.' },
      single_valued: { type: 'boolean', description: 'true: at most one value at a time.' },
    },
    ['name', 'description', 'value_type', 'single_valued'],
  ),
};
