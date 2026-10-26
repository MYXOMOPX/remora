import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { apply } from '../src/api/apply.js';
import { query, type QueryResponse } from '../src/api/query.js';
import { runMigrations } from '../src/db/migrate.js';
import type { PluginRegistry } from '../src/plugins/registry.js';
import { seedAxes } from './helpers/axes.js';
import { seedBasics } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

interface Ctx {
  pool: pg.Pool;
  reg: PluginRegistry;
  write: (...ops: unknown[]) => Promise<void>;
  q: (...ops: unknown[]) => Promise<QueryResponse>;
}

async function withDb(fn: (c: Ctx) => Promise<void>): Promise<void> {
  const { pool, drop } = await createTestDb();
  try {
    await runMigrations(pool);
    const seeded = await seedBasics(pool);
    const reg = await seedAxes(pool, seeded);
    await fn({
      pool,
      reg,
      write: async (...ops) => {
        const r = await apply(pool, reg, { ops });
        if (!r.ok) throw new Error(`setup failed: ${JSON.stringify(r.error)}`);
      },
      q: (...ops) => query(pool, reg, { ops }),
    });
  } finally {
    await drop();
  }
}

type Rows = { rows: Record<string, unknown>[]; total?: number; truncated?: boolean };

function ok(r: QueryResponse): Rows[] {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.results as Rows[];
}

function err(r: QueryResponse): { op_index: number; code: string } {
  if (r.ok) throw new Error('expected error');
  return r.error;
}

const gd = (at: number) => ({ axis: 'game_day', at });

describe('query', () => {
  it('get_entity and find_entities', async () => {
    await withDb(async ({ write, q }) => {
      await write({ op: 'create_entity', key: 'google' });
      const res = ok(await q({ op: 'get_entity', key: 'bob' }, { op: 'find_entities', query: 'o' }));
      expect(res[0]).toEqual({ key: 'bob' });
      expect(res[1]).toEqual({
        rows: [{ key: 'bob' }, { key: 'google' }],
        total: 2,
        truncated: false,
      });
      expect(err(await q({ op: 'get_entity', key: 'nobody' })).code).toBe('unknown_entity');
    });
  });

  it('find_entities clamps limit, rejects 0', async () => {
    await withDb(async ({ q }) => {
      const res = ok(await q({ op: 'find_entities', query: 'b', limit: 500 }));
      expect(res[0]!.rows.length).toBeLessThanOrEqual(200);
      expect(err(await q({ op: 'find_entities', query: 'b', limit: 0 })).code).toBe('invalid_param');
    });
  });

  it('property_at and property_history row shapes', async () => {
    await withDb(async ({ write, q }) => {
      await write(
        { op: 'replace_property', entity: 'bob', property: 'job_title', value: 'Junior', time: gd(292) },
        { op: 'replace_property', entity: 'bob', property: 'job_title', value: 'Senior', time: gd(300) },
      );
      const at = ok(await q({ op: 'property_at', entity: 'bob', property: 'job_title', when: gd(295) }))[0]!;
      expect(at.rows).toHaveLength(1);
      expect(at.rows[0]).toMatchObject({
        value: 'Junior',
        time: { axis: 'game_day', from: 292, to: 300 },
        evidence_id: null,
      });
      expect(typeof at.rows[0]!.id).toBe('number');
      expect(typeof at.rows[0]!.recorded_at).toBe('string');
      expect(new Date(at.rows[0]!.recorded_at as string).toISOString()).toBe(at.rows[0]!.recorded_at);
      expect('retracted_at' in at.rows[0]!).toBe(false);

      const hist = ok(await q({ op: 'property_history', entity: 'bob', property: 'job_title', axis: 'game_day' }))[0]!;
      expect(hist.rows.map((r) => r.value)).toEqual(['Junior', 'Senior']);
      const id = hist.rows[0]!.id;
      await write({ op: 'retract_property', id });
      const plain = ok(await q({ op: 'property_history', entity: 'bob', property: 'job_title' }))[0]!;
      expect(plain.rows).toHaveLength(1);
      const all = ok(
        await q({ op: 'property_history', entity: 'bob', property: 'job_title', include_retracted: true }),
      )[0]!;
      expect(all.rows).toHaveLength(2);
      const retracted = all.rows.find((r) => r.id === id)!;
      expect(typeof retracted.retracted_at).toBe('string');
    });
  });

  it('property_at argument errors', async () => {
    await withDb(async ({ q }) => {
      const base = { op: 'property_at', entity: 'bob', property: 'job_title' };
      expect(err(await q(base)).code).toBe('invalid_param');
      expect(err(await q({ ...base, when: { axis: 'nope', at: 1 } })).code).toBe('unknown_axis');
      expect(err(await q({ ...base, when: { axis: 'game_day', at: -1 } })).code).toBe('invalid_time');
      expect(err(await q({ ...base, when: { axis: 'game_day' } })).code).toBe('invalid_param');
    });
  });

  it('relation_history row shape, direction, undirected', async () => {
    await withDb(async ({ write, q }) => {
      await write(
        { op: 'create_entity', key: 'google' },
        { op: 'create_entity', key: 'carl' },
        { op: 'create_relation_type', name: 'works_at', description: 'Employment.', directed: true },
        { op: 'create_relation_type', name: 'friend_of', description: 'Friendship.', directed: false },
        { op: 'add_relation', type: 'works_at', from: 'bob', to: 'google', time: { axis: 'game_day', from: 292 } },
        { op: 'add_relation', type: 'friend_of', from: 'bob', to: 'carl' },
      );
      const r = ok(await q({ op: 'relation_history', entity: 'bob' }))[0]!;
      expect(r.total).toBe(2);
      expect(r.truncated).toBe(false);
      const works = r.rows.find((x) => x.type === 'works_at')!;
      expect(works).toMatchObject({
        from: 'bob',
        to: 'google',
        time: { axis: 'game_day', from: 292 },
        evidence_id: null,
      });
      expect(typeof works.relation_id).toBe('number');
      expect(r.rows.find((x) => x.type === 'friend_of')!.time).toBeNull();

      const inc = ok(
        await q({ op: 'relation_history', entity: 'google', direction: 'in', relation_types: ['works_at'] }),
      )[0]!;
      expect(inc.rows).toHaveLength(1);
      const fromCarl = ok(await q({ op: 'relation_history', entity: 'carl', direction: 'out' }))[0]!;
      expect(fromCarl.rows.map((x) => x.type)).toEqual(['friend_of']);

      expect(err(await q({ op: 'relation_history', entity: 'bob', direction: 'sideways' })).code).toBe(
        'invalid_param',
      );
      expect(err(await q({ op: 'relation_history', entity: 'bob', relation_types: [] })).code).toBe('invalid_param');
    });
  });

  it('dictionary ops', async () => {
    await withDb(async ({ write, q }) => {
      await write({ op: 'create_relation_type', name: 'works_at', description: 'Employment.', directed: true });
      const res = ok(
        await q(
          { op: 'list_relation_types' },
          { op: 'find_relation_types', query: 'employ' },
          { op: 'list_property_types' },
          { op: 'find_property_types', query: 'nick' },
          { op: 'list_time_axes' },
        ),
      );
      expect(res[0]!.rows).toEqual([
        { id: expect.any(Number), name: 'works_at', description: 'Employment.', directed: true },
      ]);
      expect(res[1]!.rows).toHaveLength(1);
      expect(res[2]!.rows.map((r) => r.name)).toEqual(['height', 'job_title', 'nickname']);
      expect(res[3]!.rows[0]).toMatchObject({ name: 'nickname', value_type: 'text', single_valued: false });
      expect(res[4]!.rows.map((r) => r.name)).toEqual(['game_day', 'real', 'big']);
      expect(res[4]!.rows[0]).toEqual({
        name: 'game_day',
        description: expect.any(String),
        value_schema: expect.anything(),
        example: expect.anything(),
      });
    });
  });

  it('axis values beyond 2^53 round-trip exactly (big axis)', async () => {
    await withDb(async ({ write, q }) => {
      const v = '9007199254740993';
      await write({
        op: 'add_property',
        entity: 'bob',
        property: 'height',
        value: 180,
        time: { axis: 'big', from: { v } },
      });
      const rows = ok(await q({ op: 'property_history', entity: 'bob', property: 'height' }))[0]!.rows;
      expect(rows[0]!.time).toEqual({ axis: 'big', from: { v } });
      const at = ok(
        await q({
          op: 'property_at',
          entity: 'bob',
          property: 'height',
          when: { axis: 'big', at: { v: '9007199254740994' } },
        }),
      )[0]!;
      expect(at.rows).toHaveLength(1);
    });
  });

  it('unknown and deferred ops are invalid_param; failing second op reports op_index 1', async () => {
    await withDb(async ({ q }) => {
      const names = [
        'get_event',
        'search_events',
        'entity_events',
        'list_event_roles',
        'frobnicate',
      ];
      for (const op of names) {
        expect(err(await q({ op }))).toMatchObject({ op_index: 0, code: 'invalid_param' });
      }
      expect(err(await q({ op: 'get_entity', key: 'bob' }, { op: 'get_entity', key: 'nobody' }))).toMatchObject({
        op_index: 1,
        code: 'unknown_entity',
      });
    });
  });

  it('bad envelope gives op_index -1; writes through query are impossible', async () => {
    await withDb(async ({ pool, reg, q }) => {
      expect(err(await query(pool, reg, null))).toMatchObject({ op_index: -1, code: 'invalid_param' });
      expect(err(await query(pool, reg, { ops: [] }))).toMatchObject({ op_index: -1 });
      expect(err(await query(pool, reg, { ops: 'x' }))).toMatchObject({ op_index: -1 });
      expect(err(await q({ op: 'create_entity', key: 'x' })).code).toBe('invalid_param');
    });
  });

  it('find_entities with a NUL in the query -> invalid_param', async () => {
    await withDb(async ({ q }) => {
      expect(err(await q({ op: 'find_entities', query: 'a b' })).code).toBe('invalid_param');
    });
  });

  it('relation_history limit reports total and truncated', async () => {
    await withDb(async ({ write, q }) => {
      await write(
        { op: 'create_entity', key: 'google' },
        { op: 'create_relation_type', name: 'works_at', description: 'Employment.', directed: true },
        { op: 'add_relation', type: 'works_at', from: 'bob', to: 'google' },
        { op: 'add_relation', type: 'works_at', from: 'bob', to: 'google' },
        { op: 'add_relation', type: 'works_at', from: 'bob', to: 'google' },
      );
      const [h] = ok(await q({ op: 'relation_history', entity: 'bob', limit: 2 }));
      expect(h!.rows).toHaveLength(2);
      expect(h!.total).toBe(3);
      expect(h!.truncated).toBe(true);
    });
  });
});
