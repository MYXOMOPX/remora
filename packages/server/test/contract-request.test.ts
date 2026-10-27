import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { APPLY_OP_NAMES } from '../src/api/apply.js';
import { QUERY_OP_NAMES } from '../src/api/query.js';
import { MAX_OPS } from '../src/api/limits.js';
import { APPLY_OPS } from '../src/contract/apply-ops.js';
import { QUERY_OPS } from '../src/contract/query-ops.js';
import {
  applyRequestSchema,
  queryRequestSchema,
  validateApplyRequest,
  validateQueryRequest,
} from '../src/contract/validate.js';

type Schema = Record<string, unknown>;

const apply = (...ops: unknown[]) => validateApplyRequest({ ops });
const query = (...ops: unknown[]) => validateQueryRequest({ ops });

describe('op tables', () => {
  it('schema keys equal the handler tables', () => {
    expect(Object.keys(APPLY_OPS).sort()).toEqual([...APPLY_OP_NAMES].sort());
    expect(Object.keys(QUERY_OPS).sort()).toEqual([...QUERY_OP_NAMES].sort());
    expect(APPLY_OP_NAMES).toHaveLength(14);
    expect(QUERY_OP_NAMES).toHaveLength(17);
  });

  it('MAX_OPS is 1000', () => expect(MAX_OPS).toBe(1000));

  for (const [name, schema] of Object.entries(APPLY_OPS) as [string, Schema][]) {
    it(`apply ${name}: description and a valid example`, () => {
      expect(typeof schema.description === 'string' && schema.description.length > 20).toBe(true);
      const ex = (schema.examples as unknown[])[0];
      expect((ex as { op: string }).op).toBe(name);
      expect(apply(ex)).toBeNull();
    });
  }

  for (const [name, schema] of Object.entries(QUERY_OPS) as [string, Schema][]) {
    it(`query ${name}: description and a valid example`, () => {
      expect(typeof schema.description === 'string' && schema.description.length > 20).toBe(true);
      const ex = (schema.examples as unknown[])[0];
      expect((ex as { op: string }).op).toBe(name);
      expect(query(ex)).toBeNull();
    });
  }

  it('request schemas have a description and compile under strict ajv', () => {
    for (const s of [applyRequestSchema, queryRequestSchema] as Schema[]) {
      expect(typeof s.description).toBe('string');
      const ajv = new Ajv({ strict: true, allowUnionTypes: true, allErrors: true });
      expect(() => ajv.compile(s)).not.toThrow();
    }
    const items = (applyRequestSchema.properties as { ops: { items: { oneOf: unknown[] }; maxItems: number } }).ops;
    expect(items.items.oneOf).toHaveLength(14);
    expect(items.maxItems).toBe(MAX_OPS);
  });
});

describe('validateApplyRequest', () => {
  it('accepts the spec 10.1 example batch', () => {
    expect(
      apply(
        { op: 'add_evidence', as: 'e1', source: 'chat_message', payload: { text: '...' } },
        { op: 'create_entity', key: 'carl' },
        {
          op: 'replace_property',
          entity: 'bob',
          property: 'job_title',
          time: { axis: 'game_day', at: 292 },
          value: 'Senior',
          evidence: '$e1',
        },
        {
          op: 'add_relation',
          type: 'works_at',
          from: 'bob',
          to: 'google',
          time: { axis: 'game_day', from: 292 },
          evidence: '$e1',
        },
      ),
    ).toBeNull();
  });

  it('missing / empty / non-array / oversized ops', () => {
    expect(validateApplyRequest({})).toMatchObject({ op_index: -1, code: 'invalid_param', details: { field: 'ops' } });
    expect(validateApplyRequest(null)).toMatchObject({ op_index: -1, details: { field: 'ops' } });
    expect(validateApplyRequest([])).toMatchObject({ op_index: -1, details: { field: 'ops' } });
    expect(validateApplyRequest({ ops: [] })).toMatchObject({ op_index: -1, details: { field: 'ops' } });
    expect(validateApplyRequest({ ops: 'x' })).toMatchObject({ op_index: -1, details: { field: 'ops' } });
    const many = Array.from({ length: MAX_OPS + 1 }, (_, i) => ({ op: 'create_entity', key: 'e' + i }));
    expect(validateApplyRequest({ ops: many })).toMatchObject({
      op_index: -1,
      code: 'invalid_param',
      details: { field: 'ops', limit: MAX_OPS },
    });
    expect(validateApplyRequest({ ops: many.slice(0, MAX_OPS) })).toBeNull();
  });

  it('extra top-level keys are rejected', () => {
    expect(validateApplyRequest({ ops: [{ op: 'create_entity', key: 'a' }], extra: 1 })).toMatchObject({
      op_index: -1,
      code: 'invalid_param',
    });
  });

  it('unknown op', () => {
    expect(apply({ op: 'frobnicate' })).toMatchObject({
      op_index: 0,
      code: 'invalid_param',
      details: { op: 'frobnicate' },
    });
    expect(apply({ op: 'constructor' })).toMatchObject({ op_index: 0, details: { op: 'constructor' } });
    expect(apply({ op: 'get_entity', key: 'bob' })).toMatchObject({ op_index: 0, details: { op: 'get_entity' } });
  });

  it('non-object op and missing / non-string op name', () => {
    expect(apply(5)).toMatchObject({ op_index: 0, code: 'invalid_param' });
    expect(apply([])).toMatchObject({ op_index: 0, code: 'invalid_param' });
    expect(apply({ key: 'a' })).toMatchObject({ op_index: 0, code: 'invalid_param', details: { field: 'op' } });
    expect(apply({ op: 5 })).toMatchObject({ op_index: 0, code: 'invalid_param', details: { field: 'op' } });
  });

  it('reports op_index and the deepest field', () => {
    const e = apply(
      { op: 'create_entity', key: 'bob' },
      { op: 'add_property', entity: 'bob', property: 'x', value: 1, time: { axis: 5 } },
    );
    expect(e).toMatchObject({ op_index: 1, code: 'invalid_param', details: { field: 'time.axis' } });
    expect(typeof e?.message).toBe('string');
    expect(typeof e?.details?.reason).toBe('string');
  });

  it('names a missing required field', () => {
    expect(apply({ op: 'create_entity' })).toMatchObject({ op_index: 0, details: { field: 'key' } });
    expect(apply({ op: 'add_property', entity: 'bob', property: 'x' })).toMatchObject({
      details: { field: 'value' },
    });
  });

  it('names an unknown key in reason', () => {
    const e = apply({ op: 'create_entity', key: 'bob', entity_key: 'x' });
    expect(e).toMatchObject({ op_index: 0, code: 'invalid_param' });
    expect(String(e?.details?.reason)).toContain('entity_key');
  });

  it('nested additionalProperties are rejected', () => {
    const e = apply({
      op: 'add_event',
      summary: 's',
      time: { axis: 'game_day', at: 1, extra: true },
    });
    expect(e).toMatchObject({ op_index: 0, code: 'invalid_param' });
    expect(apply({ op: 'add_event', summary: 's', time: { axis: 'g', at: 1 }, entities: [{ entity: 'a', who: 1 }] }))
      .toMatchObject({ code: 'invalid_param' });
  });

  it('end_relation: relation_id xor type/from/to', () => {
    const t = { axis: 'game_day', at: 5 };
    expect(apply({ op: 'end_relation', relation_id: 1, time: t })).toBeNull();
    expect(apply({ op: 'end_relation', type: 'works_at', from: 'a', to: 'b', time: t })).toBeNull();
    expect(apply({ op: 'end_relation', time: t })).toMatchObject({ code: 'invalid_param' });
    expect(apply({ op: 'end_relation', type: 'works_at', from: 'a', time: t })).toMatchObject({
      code: 'invalid_param',
    });
    expect(apply({ op: 'end_relation', relation_id: 1, type: 'w', from: 'a', to: 'b', time: t })).toMatchObject({
      code: 'invalid_param',
    });
    expect(apply({ op: 'retract_relation', relation_id: 1 })).toBeNull();
    expect(apply({ op: 'retract_relation', type: 'w', from: 'a', to: 'b', axis: 'game_day' })).toBeNull();
  });

  it('event time shapes: at xor from/to, object or array', () => {
    expect(apply({ op: 'add_event', summary: 's', time: { axis: 'g', at: 1 } })).toBeNull();
    expect(apply({ op: 'add_event', summary: 's', time: { axis: 'g', from: 1, to: 2 } })).toBeNull();
    expect(apply({ op: 'add_event', summary: 's', time: [{ axis: 'g', at: 1 }, { axis: 'h' }] })).toBeNull();
    expect(apply({ op: 'add_event', summary: 's', time: { axis: 'g', at: 1, from: 1 } })).toMatchObject({
      code: 'invalid_param',
    });
    expect(apply({ op: 'add_event', summary: 's', time: [] })).toMatchObject({ code: 'invalid_param' });
    expect(apply({ op: 'add_event', summary: 's' })).toMatchObject({ details: { field: 'time' } });
  });

  it('update_event keywords and details', () => {
    expect(apply({ op: 'update_event', id: 1, details: null })).toBeNull();
    expect(apply({ op: 'update_event', id: 1, keywords: { set: ['a'] } })).toBeNull();
    expect(apply({ op: 'update_event', id: 1, keywords: { add: ['a'], remove: ['b'] } })).toBeNull();
    expect(apply({ op: 'update_event', id: 1, entities: { add: [{ entity: 'a', role: 'who' }] } })).toBeNull();
    expect(apply({ op: 'update_event', id: 1, keywords: ['a'] })).toMatchObject({ code: 'invalid_param' });
    expect(apply({ op: 'update_event', id: 1, entities: { drop: [] } })).toMatchObject({ code: 'invalid_param' });
  });

  it('create_property_type value_type enum', () => {
    const base = { op: 'create_property_type', name: 'n', description: 'd', single_valued: true };
    expect(apply({ ...base, value_type: 'text' })).toBeNull();
    expect(apply({ ...base, value_type: 'blob' })).toMatchObject({ details: { field: 'value_type' } });
  });

  it('as must be a non-empty name without $', () => {
    expect(apply({ op: 'create_entity', key: 'a', as: 'x' })).toBeNull();
    expect(apply({ op: 'create_entity', key: 'a', as: '' })).toMatchObject({ details: { field: 'as' } });
    expect(apply({ op: 'create_entity', key: 'a', as: '$x' })).toMatchObject({ details: { field: 'as' } });
  });

  it('equivalence (R33): inputs the handlers map to other codes pass the schema', () => {
    const t = { axis: 'game_day' };
    expect(apply({ op: 'create_entity', key: '$x' })).toBeNull();
    expect(apply({ op: 'create_relation_type', name: '', description: 'd', directed: true })).toBeNull();
    expect(apply({ op: 'add_property', entity: 'bob', property: 'x', value: 1, evidence: 0 })).toBeNull();
    expect(apply({ op: 'add_property', entity: 'bob', property: 'x', value: 1, evidence: 1.5 })).toBeNull();
    expect(
      apply({ op: 'add_property', entity: 'bob', property: 'x', value: 1, time: { ...t, from: null } }),
    ).toBeNull();
    expect(apply({ op: 'add_property', entity: 'bob', property: 'nick', value: null })).toBeNull();
    expect(
      apply({ op: 'end_property', entity: 'bob', property: 'x', time: { ...t, at: null } }),
    ).toBeNull();
    expect(apply({ op: 'add_property', entity: 'bob', property: 'x', value: { any: ['thing'] } })).toBeNull();
  });
});

describe('validateQueryRequest', () => {
  it('accepts a realistic batch', () => {
    expect(
      query(
        { op: 'get_entity', key: 'bob' },
        { op: 'property_at', entity: 'bob', property: 'job_title', when: { axis: 'game_day', at: 300 } },
        {
          op: 'neighbors',
          entity: 'bob',
          depth: 1,
          include: ['height'],
          order_by: { property: 'height', dir: 'desc' },
          limit: 1,
        },
        { op: 'search_events', keywords: ['a'], match: 'all', when: { axis: 'game_day', during: [1, 5] } },
      ),
    ).toBeNull();
  });

  it('request-level errors', () => {
    expect(validateQueryRequest({})).toMatchObject({ op_index: -1, details: { field: 'ops' } });
    expect(validateQueryRequest({ ops: [] })).toMatchObject({ op_index: -1, details: { field: 'ops' } });
    const many = Array.from({ length: MAX_OPS + 1 }, () => ({ op: 'list_time_axes' }));
    expect(validateQueryRequest({ ops: many })).toMatchObject({ op_index: -1, details: { field: 'ops', limit: MAX_OPS } });
  });

  it('unknown op, including apply ops', () => {
    expect(query({ op: 'create_entity', key: 'a' })).toMatchObject({ op_index: 0, details: { op: 'create_entity' } });
  });

  it('wrong type is reported with the field', () => {
    expect(query({ op: 'neighbors', entity: 'bob', depth: '2' })).toMatchObject({
      op_index: 0,
      code: 'invalid_param',
      details: { field: 'depth' },
    });
  });

  it('no as on query ops', () => {
    expect(query({ op: 'get_entity', key: 'bob', as: 'x' })).toMatchObject({ op_index: 0, code: 'invalid_param' });
  });

  it('neighbors bounds and enums', () => {
    const base = { op: 'neighbors', entity: 'bob' };
    expect(query({ ...base, depth: 6 })).toBeNull();
    expect(query({ ...base, depth: 7 })).toMatchObject({ details: { field: 'depth' } });
    expect(query({ ...base, depth: 0 })).toMatchObject({ details: { field: 'depth' } });
    expect(query({ ...base, direction: 'sideways' })).toMatchObject({ details: { field: 'direction' } });
    expect(query({ ...base, order_by: { property: 'h', dir: 'up' } })).toMatchObject({
      details: { field: 'order_by.dir' },
    });
    expect(query({ ...base, relation_types: [] })).toMatchObject({ details: { field: 'relation_types' } });
    expect(query({ ...base, paths: 'yes' })).toMatchObject({ details: { field: 'paths' } });
  });

  it('non-empty arrays and enums on events and relation_history', () => {
    expect(query({ op: 'search_events', keywords: [] })).toMatchObject({ details: { field: 'keywords' } });
    expect(query({ op: 'search_events', entities: [] })).toMatchObject({ details: { field: 'entities' } });
    expect(query({ op: 'search_events', match: 'some' })).toMatchObject({ details: { field: 'match' } });
    expect(query({ op: 'relation_history', entity: 'bob', relation_types: [] })).toMatchObject({
      details: { field: 'relation_types' },
    });
    expect(query({ op: 'relation_history', entity: 'bob', direction: 'up' })).toMatchObject({
      details: { field: 'direction' },
    });
  });

  it('when shapes', () => {
    const p = { op: 'entity_events', entity: 'bob' };
    expect(query({ ...p, when: { axis: 'g', at: 1 } })).toBeNull();
    expect(query({ ...p, when: { axis: 'g', during: [1, 2] } })).toBeNull();
    expect(query({ ...p, when: { axis: 'g', during: [null, 2] } })).toBeNull();
    expect(query({ ...p, when: { axis: 'g', at: 1, during: [1, 2] } })).toMatchObject({ code: 'invalid_param' });
    expect(query({ ...p, when: { axis: 'g', during: [1] } })).toMatchObject({ code: 'invalid_param' });
    expect(query({ ...p, when: { axis: 'g' } })).toMatchObject({ code: 'invalid_param' });
    expect(query({ ...p, when: { axis: 'g', from: 1 } })).toMatchObject({ code: 'invalid_param' });
  });

  it('equivalence (R33): limit above 200 is clamped by the handler, not rejected', () => {
    expect(query({ op: 'find_entities', query: 'b', limit: 500 })).toBeNull();
    expect(query({ op: 'find_entities', query: 'b', limit: 0 })).toMatchObject({ details: { field: 'limit' } });
  });

  it('ids', () => {
    expect(query({ op: 'get_event', id: 0 })).toMatchObject({ details: { field: 'id' } });
    expect(query({ op: 'get_evidence', id: 1.5 })).toMatchObject({ details: { field: 'id' } });
  });
});
