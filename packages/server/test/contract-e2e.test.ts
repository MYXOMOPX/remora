import corePlugin from '@remora/core-plugin';
import { ERROR_CODES } from '@remora/sdk';
import { Ajv, type ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';
import { startRemora, type RemoraApp } from '../src/app.js';
import { APPLY_OPS } from '../src/contract/apply-ops.js';
import { QUERY_OPS } from '../src/contract/query-ops.js';
import { getContract, validateApplyRequest, validateQueryRequest } from '../src/index.js';
import type { Importer } from '../src/plugins/registry.js';
import { createTestDb } from './helpers/testDb.js';

const importer: Importer = async (spec) => {
  if (spec === '@remora/core-plugin') return corePlugin;
  throw new Error(`cannot import ${spec}`);
};

const ajv = new Ajv({ strict: false, allErrors: true });
const compiled = new Map<object, ValidateFunction>();
function check(schema: object, value: unknown, what: string): void {
  let v = compiled.get(schema);
  if (!v) {
    v = ajv.compile(schema);
    compiled.set(schema, v);
  }
  if (!v(value)) {
    throw new Error(`${what} does not match its schema: ${JSON.stringify(v.errors)}\n${JSON.stringify(value)}`);
  }
}

const gd = (at: number) => ({ axis: 'game_day', at });

describe('response contract conformance (startRemora + core plugin)', () => {
  it('every apply and query op: request valid, envelope valid, each result valid', async () => {
    const c = getContract();
    const { url, drop } = await createTestDb();
    let app: RemoraApp | undefined;
    try {
      app = await startRemora({ databaseUrl: url, importer });
      const a = app;
      const appliedOps = new Set<string>();
      const queriedOps = new Set<string>();

      const write = async (...ops: Record<string, unknown>[]): Promise<Record<string, unknown>[]> => {
        const req = { ops };
        expect(validateApplyRequest(req)).toBeNull();
        const r = await a.apply(req);
        check(c.responses.apply, r, 'apply response');
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        r.results.forEach((res, i) => {
          const name = String(ops[i]!.op);
          check(c.responses.results.apply[name]!, res, `apply result ${name}`);
          appliedOps.add(name);
        });
        return r.results as Record<string, unknown>[];
      };
      const read = async (...ops: Record<string, unknown>[]): Promise<Record<string, unknown>[]> => {
        const req = { ops };
        expect(validateQueryRequest(req)).toBeNull();
        const r = await a.query(req);
        check(c.responses.query, r, 'query response');
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        r.results.forEach((res, i) => {
          const name = String(ops[i]!.op);
          check(c.responses.results.query[name]!, res, `query result ${name}`);
          queriedOps.add(name);
        });
        return r.results as Record<string, unknown>[];
      };

      // dictionaries, then the spec 10.1 batch
      await write(
        { op: 'create_entity', key: 'bob' },
        { op: 'create_entity', key: 'carl' },
        { op: 'create_entity', key: 'google' },
        { op: 'create_property_type', name: 'job_title', description: 'Job title.', value_type: 'text', single_valued: true },
        { op: 'create_property_type', name: 'nickname', description: 'Nickname.', value_type: 'text', single_valued: false },
        { op: 'create_relation_type', name: 'works_at', description: 'Employment.', directed: true },
        { op: 'create_relation_type', name: 'friend_of', description: 'Friendship.', directed: false },
      );
      await write(
        { op: 'add_evidence', as: 'e1', source: 'chat_message', payload: { text: 'Bob is now senior' } },
        { op: 'add_property', entity: 'bob', property: 'job_title', value: 'Junior', time: { axis: 'game_day', from: 1 }, evidence: '$e1' },
        { op: 'replace_property', entity: 'bob', property: 'job_title', value: 'Senior', time: gd(292), evidence: '$e1' },
        { op: 'add_relation', type: 'works_at', from: 'bob', to: 'google', time: { axis: 'game_day', from: 292 }, evidence: '$e1' },
        {
          op: 'add_event',
          as: 'ev',
          summary: 'Bob promoted',
          details: 'At the party',
          keywords: ['promotion'],
          time: gd(292),
          entities: [{ entity: 'bob', role: 'actor' }],
          evidence: '$e1',
        },
      );
      const [nick, friend] = await write(
        { op: 'add_property', entity: 'bob', property: 'nickname', value: 'Bobby' },
        { op: 'add_relation', type: 'friend_of', from: 'bob', to: 'carl' },
      );
      await write({ op: 'end_property', entity: 'bob', property: 'job_title', time: gd(310) });
      await write({ op: 'end_relation', type: 'works_at', from: 'bob', to: 'google', time: gd(310) });
      const [ev] = await write({ op: 'add_event', summary: 'Party', time: { axis: 'game_day', from: 5, to: 6 } });
      await write({ op: 'update_event', id: ev!.id, summary: 'Big party', details: null });
      await write({ op: 'retract_event', id: ev!.id });
      await write({ op: 'retract_property', id: (nick!.ids as number[])[0] });
      await write({ op: 'retract_relation', relation_id: friend!.relation_id });
      const [rel] = await write({ op: 'add_relation', type: 'works_at', from: 'carl', to: 'google', time: { axis: 'game_day', from: 1 } });
      await write({ op: 'end_relation', relation_id: rel!.relation_id, time: gd(3) });

      await read(
        { op: 'get_entity', key: 'bob' },
        { op: 'find_entities', query: 'b' },
        { op: 'property_at', entity: 'bob', property: 'job_title', when: { axis: 'game_day', at: 300 } },
        { op: 'property_history', entity: 'bob', property: 'job_title', include_retracted: true },
        { op: 'property_history', entity: 'bob', property: 'nickname', include_retracted: true },
        { op: 'relation_history', entity: 'bob', include_retracted: true, when: { axis: 'game_day', during: [1, 400] } },
        { op: 'neighbors', entity: 'bob', depth: 2, include: ['job_title'], order_by: { property: 'job_title' } },
        { op: 'neighbors', entity: 'bob', depth: 2, paths: true },
        { op: 'list_relation_types' },
        { op: 'find_relation_types', query: 'work' },
        { op: 'list_property_types' },
        { op: 'find_property_types', query: 'job' },
        { op: 'list_evidence_sources' },
        { op: 'get_evidence', id: 1 },
        { op: 'get_event', id: ev!.id },
        { op: 'get_event', id: 1 },
        { op: 'search_events', text: 'promoted', keywords: ['promotion'], entities: ['bob'], when: { axis: 'game_day', at: 292 } },
        { op: 'entity_events', entity: 'bob' },
        { op: 'list_event_roles' },
        { op: 'list_time_axes' },
      );

      expect([...appliedOps].sort()).toEqual(Object.keys(APPLY_OPS).sort());
      expect([...queriedOps].sort()).toEqual(Object.keys(QUERY_OPS).sort());

      const bad = await a.apply({
        ops: [{ op: 'create_entity', key: 'x' }, { op: 'add_property', entity: 'nobody', property: 'job_title', value: 'x' }],
      });
      expect(bad.ok).toBe(false);
      check(c.responses.apply, bad, 'error response');
      if (!bad.ok) {
        expect(bad.error.code).toBe('unknown_entity');
        check(c.error, bad.error, 'error');
      }
      const badQ = await a.query({ ops: [{ op: 'get_entity', key: 'nobody' }] });
      check(c.responses.query, badQ, 'error query response');
    } finally {
      await app?.close();
      await drop();
    }
  });

  it('getContract is stable, JSON-serialisable and lists the error codes', () => {
    const c = getContract();
    expect(getContract()).toBe(c);
    expect(c.version).toBe('1.0.0');
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    expect(c.error_codes).toEqual(ERROR_CODES);
    expect(Object.keys(c.responses.results.apply).sort()).toEqual(Object.keys(APPLY_OPS).sort());
    expect(Object.keys(c.responses.results.query).sort()).toEqual(Object.keys(QUERY_OPS).sort());
  });

  it('envelope schemas reject malformed shapes', () => {
    const c = getContract();
    const v = ajv.compile(c.responses.apply);
    expect(v({ ok: false, error: { op_index: -2, code: 'unknown_entity', message: 'm' } })).toBe(false);
    expect(v({ ok: false, error: { op_index: 0, code: 'nope', message: 'm' } })).toBe(false);
    expect(v({ ok: true })).toBe(false);
    expect(v({ ok: true, results: [] })).toBe(true);
  });
});
