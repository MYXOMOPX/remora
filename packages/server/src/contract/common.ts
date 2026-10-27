/** A JSON Schema document (draft-07 keywords only, inlined, no $ref; R33). */
export type JsonSchema = Record<string, unknown>;

export const axisName: JsonSchema = {
  type: 'string',
  minLength: 1,
  description: 'Name of a time axis (see list_time_axes).',
};

/** Axis values are validated by the axis plugin, so the contract does not constrain them (R33/R34). */
const timeValue = (what: string): JsonSchema => ({
  description: `${what} A value valid for the axis (see value_schema and example in list_time_axes). Never null: omit the key for an unbounded side.`,
});

export const entityRef: JsonSchema = {
  type: 'string',
  description: 'Entity key, or a $name reference to a create_entity op declared with "as" earlier in the same batch.',
};

export const evidenceRef: JsonSchema = {
  type: ['number', 'string'],
  description:
    'Evidence for this change: the numeric id of an existing evidence record, or a $name reference to an add_evidence op declared with "as" earlier in the same batch.',
};

export const asName: JsonSchema = {
  type: 'string',
  minLength: 1,
  pattern: '^[^$]',
  description: 'Optional local name for the result of this op; later ops of the same batch refer to it as "$name".',
};

const spanItem: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['axis'],
  properties: {
    axis: axisName,
    from: timeValue('Inclusive start.'),
    to: timeValue('Exclusive end.'),
  },
};

/** Validity interval(s) of a fact: one {axis, from?, to?} or a non-empty list (one entry per axis). */
export const spanTime: JsonSchema = {
  description:
    'Validity interval on a time axis: {axis, from?, to?} (from inclusive, to exclusive, omitted side = unbounded), or a non-empty list with one such object per axis. Omit time for a timeless fact.',
  oneOf: [spanItem, { type: 'array', minItems: 1, items: spanItem }],
};

/** A single point in time: {axis, at}. */
export const momentTime: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['axis', 'at'],
  description: 'A moment on a time axis: {axis, at}.',
  properties: { axis: axisName, at: timeValue('The moment.') },
};

const eventItem: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['axis', 'at'],
      properties: { axis: axisName, at: timeValue('The instant at which the event happened.') },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['axis'],
      properties: {
        axis: axisName,
        from: timeValue('Inclusive start of the period.'),
        to: timeValue('Exclusive end of the period.'),
      },
    },
  ],
};

/** When an event happened: {axis, at} (instant) or {axis, from?, to?} (period); one object or a non-empty list. */
export const eventTime: JsonSchema = {
  description:
    'When the event happened: {axis, at} for an instant, or {axis, from?, to?} for a period (omitted side = unbounded); give one object or a non-empty list with one object per axis.',
  oneOf: [eventItem, { type: 'array', minItems: 1, items: eventItem }],
};

/** Optional time filter of read ops. */
export const when: JsonSchema = {
  description:
    'Optional time filter. {axis, at}: facts valid at that moment. {axis, during: [from, to]}: facts overlapping the period (from < to). Omit for no time filter: every version is returned, each with its own time. Timeless facts match any filter.',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['axis', 'at'],
      properties: { axis: axisName, at: timeValue('The moment.') },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['axis', 'during'],
      properties: {
        axis: axisName,
        during: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: timeValue('Period bound.'),
          description: '[from, to] with from < to.',
        },
      },
    },
  ],
};

/** The `relation_id` or `{type, from, to}` selector shared by end_relation and retract_relation. */
export const relationSelectorProps: Record<string, JsonSchema> = {
  relation_id: { type: 'integer', description: 'Id of the relation (relation_id from a result or relation_history).' },
  type: { type: 'string', description: 'Relation type name (selector; give together with from and to).' },
  from: { ...entityRef, description: 'Source entity (selector; give together with type and to).' },
  to: { ...entityRef, description: 'Target entity (selector; give together with type and from).' },
};

/** Exactly one of: relation_id, or all of type/from/to. */
export const relationSelectorOneOf: JsonSchema[] = [
  { required: ['relation_id'], properties: { relation_id: true, type: false, from: false, to: false } },
  { required: ['type', 'from', 'to'], properties: { relation_id: false, type: true, from: true, to: true } },
];

export const eventEntity: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['entity'],
  properties: {
    entity: entityRef,
    role: {
      type: 'string',
      description: 'Optional role of the entity in the event (e.g. "actor", "witness"); see list_event_roles.',
    },
  },
};

export const limitProp = (what: string): JsonSchema => ({
  type: 'integer',
  minimum: 1,
  description: `Maximum number of ${what} to return (default 50; values above 200 are clamped to 200).`,
});

/** Builds an op schema; keeps the shape identical across all ops. */
export function opSchema(
  name: string,
  description: string,
  example: Record<string, unknown>,
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  extra: JsonSchema = {},
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    description,
    examples: [example],
    required: ['op', ...required],
    properties: { op: { const: name }, ...properties },
    ...extra,
  };
}
