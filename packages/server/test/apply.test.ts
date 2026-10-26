import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { apply, mapPgError, type ApplyResponse } from '../src/api/apply.js';
import { runMigrations } from '../src/db/migrate.js';
import type { PluginRegistry } from '../src/plugins/registry.js';
import { seedAxes } from './helpers/axes.js';
import { seedBasics } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

interface Ctx {
  pool: pg.Pool;
  reg: PluginRegistry;
  run: (...ops: unknown[]) => Promise<ApplyResponse>;
}

async function withDb(fn: (c: Ctx) => Promise<void>): Promise<void> {
  const { pool, drop } = await createTestDb();
  try {
    await runMigrations(pool);
    const seeded = await seedBasics(pool);
    const reg = await seedAxes(pool, seeded);
    await fn({ pool, reg, run: (...ops) => apply(pool, reg, { ops }) });
  } finally {
    await drop();
  }
}

function okResults(r: ApplyResponse): Record<string, unknown>[] {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.results as Record<string, unknown>[];
}

function errOf(r: ApplyResponse): { op_index: number; code: string; details?: Record<string, unknown> } {
  if (r.ok) throw new Error('expected error');
  return r.error;
}

const gd = (at: number) => ({ axis: 'game_day', at });

describe('apply', () => {
  it('runs the spec example batch', async () => {
    await withDb(async ({ run }) => {
      const r = await run(
        { op: 'create_entity', key: 'bob' },
        { op: 'create_entity', key: 'google' },
        { op: 'create_relation_type', name: 'works_at', description: 'Employment.', directed: true },
        { op: 'replace_property', entity: 'bob', property: 'job_title', value: 'Junior', time: gd(292) },
        { op: 'add_relation', type: 'works_at', from: 'bob', to: 'google', time: { axis: 'game_day', from: 292 } },
      );
      const res = okResults(r);
      expect(res).toHaveLength(5);
      expect(res[0]).toEqual({ key: 'bob', created: false });
      expect(res[1]).toEqual({ key: 'google', created: true });
      expect(res[2]).toMatchObject({ name: 'works_at', directed: true });
      expect(typeof res[2]!.id).toBe('number');
      expect(res[3]).toEqual({ closed: [], retracted: [], ids: [expect.any(Number)] });
      expect(typeof res[4]!.relation_id).toBe('number');
      expect(res[4]!.ids).toHaveLength(1);
    });
  });

  describe('local names', () => {
    it('binds and resolves $name; result carries as', async () => {
      await withDb(async ({ run }) => {
        const res = okResults(
          await run(
            { op: 'create_entity', key: 'carl', as: 'c' },
            { op: 'add_property', entity: '$c', property: 'nickname', value: 'C' },
          ),
        );
        expect(res[0]).toEqual({ key: 'carl', created: true, as: 'c' });
        expect(res[1]!.ids).toHaveLength(1);
      });
    });

    it('unknown / later-declared reference -> unknown_ref at the referencing op', async () => {
      await withDb(async ({ run }) => {
        const e1 = errOf(await run({ op: 'add_property', entity: '$missing', property: 'nickname', value: 'x' }));
        expect(e1).toMatchObject({ op_index: 0, code: 'unknown_ref' });
        const e2 = errOf(
          await run(
            { op: 'create_entity', key: 'a' },
            { op: 'add_property', entity: '$later', property: 'nickname', value: 'x' },
            { op: 'create_entity', key: 'b', as: 'later' },
          ),
        );
        expect(e2).toMatchObject({ op_index: 1, code: 'unknown_ref' });
      });
    });

    it('duplicate as -> invalid_param at the second op', async () => {
      await withDb(async ({ run }) => {
        const e = errOf(
          await run(
            { op: 'create_entity', key: 'a', as: 'x' },
            { op: 'create_entity', key: 'b', as: 'x' },
          ),
        );
        expect(e).toMatchObject({ op_index: 1, code: 'invalid_param' });
      });
    });

    it('evidence references and shapes', async () => {
      await withDb(async ({ run }) => {
        const base = { op: 'add_property', entity: 'bob', property: 'nickname', value: 'x' };
        expect(
          errOf(await run({ op: 'create_entity', key: 'c', as: 'c' }, { ...base, evidence: '$c' })),
        ).toMatchObject({ op_index: 1, code: 'unknown_ref' });
        expect(errOf(await run({ ...base, evidence: 999 }))).toMatchObject({ code: 'unknown_ref' });
        expect(errOf(await run({ ...base, evidence: 'x' }))).toMatchObject({ code: 'invalid_param' });
      });
    });

    it('entity key starting with $ -> invalid_name', async () => {
      await withDb(async ({ run }) => {
        expect(errOf(await run({ op: 'create_entity', key: '$x' }))).toMatchObject({ code: 'invalid_name' });
      });
    });
  });

  it('stores evidence ids on add and retract', async () => {
    await withDb(async ({ pool, run }) => {
      await pool.query(
        `INSERT INTO evidence_source (name, plugin_id, description, payload_schema)
         VALUES ('src', (SELECT id FROM plugin WHERE name = 'test'), 'd', '{}')`,
      );
      const ev = await pool.query<{ id: string }>(
        `INSERT INTO evidence_log (source_id, payload) VALUES ((SELECT id FROM evidence_source WHERE name='src'), '{}') RETURNING id`,
      );
      const evId = Number(ev.rows[0]!.id);
      const [add] = okResults(
        await run({ op: 'add_property', entity: 'bob', property: 'nickname', value: 'B', evidence: evId }),
      );
      const id = (add!.ids as number[])[0]!;
      const row1 = await pool.query<{ evidence_id: string }>('SELECT evidence_id FROM property_version WHERE id = $1', [id]);
      expect(Number(row1.rows[0]!.evidence_id)).toBe(evId);
      okResults(await run({ op: 'retract_property', id, evidence: evId }));
      const row2 = await pool.query<{ r: string }>(
        'SELECT retracted_evidence_id AS r FROM property_version WHERE id = $1',
        [id],
      );
      expect(Number(row2.rows[0]!.r)).toBe(evId);
    });
  });

  it('rolls back the whole batch when op N fails', async () => {
    await withDb(async ({ pool, run }) => {
      const e = errOf(
        await run(
          { op: 'create_entity', key: 'x' },
          { op: 'add_property', entity: 'x', property: 'nope', value: 1 },
        ),
      );
      expect(e).toMatchObject({ op_index: 1, code: 'unknown_type' });
      const r = await pool.query("SELECT 1 FROM entity WHERE key = 'x'");
      expect(r.rows).toHaveLength(0);
    });
  });

  it('later ops see earlier ops', async () => {
    await withDb(async ({ run }) => {
      const res = okResults(
        await run(
          { op: 'replace_property', entity: 'bob', property: 'job_title', value: 'Junior', time: gd(292) },
          { op: 'end_property', entity: 'bob', property: 'job_title', time: gd(300) },
        ),
      );
      expect(res[1]!.closed).toEqual(res[0]!.ids);
    });
  });

  it('correction in one batch: retract + add the same span', async () => {
    await withDb(async ({ run }) => {
      const [first] = okResults(
        await run({ op: 'add_property', entity: 'bob', property: 'job_title', value: 'A', time: { axis: 'game_day', from: 1, to: 5 } }),
      );
      const id = (first!.ids as number[])[0]!;
      okResults(
        await run(
          { op: 'retract_property', id },
          { op: 'add_property', entity: 'bob', property: 'job_title', value: 'B', time: { axis: 'game_day', from: 1, to: 5 } },
        ),
      );
    });
  });

  describe('invalid_param', () => {
    it('per-op shapes', async () => {
      await withDb(async ({ run }) => {
        const e = errOf(await run({ op: 'frobnicate' }));
        expect(e).toMatchObject({ op_index: 0, code: 'invalid_param', details: { op: 'frobnicate' } });
        expect(errOf(await run({ op: 'add_evidence' }))).toMatchObject({ code: 'invalid_param' });
        expect(errOf(await run({ op: 'add_property', property: 'nickname', value: 'x' }))).toMatchObject({
          code: 'invalid_param',
        });
        expect(
          errOf(await run({ op: 'add_property', entity: 'bob', property: 'nickname' })),
        ).toMatchObject({ code: 'invalid_param' });
        expect(
          errOf(await run({ op: 'create_relation_type', name: 'r1', description: 'd', directed: 'yes' })),
        ).toMatchObject({ code: 'invalid_param' });
        expect(
          errOf(await run({ op: 'end_relation', relation_id: 1, type: 't', from: 'a', to: 'b', time: gd(1) })),
        ).toMatchObject({ code: 'invalid_param' });
        expect(errOf(await run({ op: 'end_relation', time: gd(1) }))).toMatchObject({ code: 'invalid_param' });
        expect(errOf(await run({ op: 'end_relation', type: 't', from: 'a', time: gd(1) }))).toMatchObject({
          code: 'invalid_param',
        });
      });
    });

    it('request shapes use op_index -1', async () => {
      await withDb(async ({ pool, reg }) => {
        for (const body of [{ ops: [] }, { ops: 'x' }, null, 5, {}]) {
          expect(errOf(await apply(pool, reg, body))).toMatchObject({ op_index: -1, code: 'invalid_param' });
        }
      });
    });
  });

  it('mapPgError', () => {
    expect(mapPgError({ code: '23P01' })?.code).toBe('single_valued_conflict');
    expect(mapPgError({ code: '40P01' })?.code).toBe('concurrent_update');
    expect(mapPgError({ code: '40001' })?.code).toBe('concurrent_update');
    expect(mapPgError({ code: '23503' })?.code).toBe('invalid_param');
    expect(mapPgError({ code: '42P01' })).toBeNull();
    expect(mapPgError(new Error('x'))).toBeNull();
  });

  it('invalid_time details are decoded numbers, not raw strings', async () => {
    await withDb(async ({ run }) => {
      okResults(await run({ op: 'replace_property', entity: 'bob', property: 'job_title', value: 'J', time: gd(292) }));
      const e = errOf(await run({ op: 'end_property', entity: 'bob', property: 'job_title', time: gd(292) }));
      expect(e.code).toBe('invalid_time');
      expect(e.details).toMatchObject({ from: 292, at: 292, axis: 'game_day' });
      expect(typeof e.details!.id).toBe('number');
    });
  });

  it('concurrent replace_property: no raw DB error, one open row', async () => {
    await withDb(async ({ pool, run }) => {
      okResults(await run({ op: 'replace_property', entity: 'bob', property: 'job_title', value: 'Junior', time: gd(292) }));
      const [a, b] = await Promise.all([
        run({ op: 'replace_property', entity: 'bob', property: 'job_title', value: 'Mid', time: gd(300) }),
        run({ op: 'replace_property', entity: 'bob', property: 'job_title', value: 'Senior', time: gd(301) }),
      ]);
      for (const r of [a, b]) {
        if (!r.ok) expect(r.error.code).toBe('invalid_time');
      }
      expect(a.ok || b.ok).toBe(true);
      const open = await pool.query(
        `SELECT 1 FROM property_version
          WHERE retracted_at IS NULL AND upper(time_span) IS NULL AND time_axis IS NOT NULL
            AND property_type_id = (SELECT id FROM property_type WHERE name = 'job_title')`,
      );
      expect(open.rows).toHaveLength(1);
    });
  });

  it('parallel end_relation on one relation: one ok, the other not_found', async () => {
    await withDb(async ({ run }) => {
      const res = okResults(
        await run(
          { op: 'create_entity', key: 'google' },
          { op: 'create_relation_type', name: 'works_at', description: 'Employment.', directed: true },
          { op: 'add_relation', type: 'works_at', from: 'bob', to: 'google', time: { axis: 'game_day', from: 1 } },
        ),
      );
      const relationId = res[2]!.relation_id as number;
      const end = (at: number) => run({ op: 'end_relation', relation_id: relationId, time: gd(at) });
      const rs = await Promise.all([end(10), end(11)]);
      expect(rs.filter((r) => r.ok)).toHaveLength(1);
      const failed = rs.find((r) => !r.ok)!;
      expect(errOf(failed)).toMatchObject({ code: 'not_found' });
    });
  });

  it('retract_relation via reverse endpoints of an undirected type', async () => {
    await withDb(async ({ run }) => {
      okResults(
        await run(
          { op: 'create_entity', key: 'google' },
          { op: 'create_relation_type', name: 'friend_of', description: 'Friends.', directed: false },
          { op: 'add_relation', type: 'friend_of', from: 'bob', to: 'google' },
        ),
      );
      const [r] = okResults(await run({ op: 'retract_relation', type: 'friend_of', from: 'google', to: 'bob' }));
      expect(r!.retracted).toHaveLength(1);
    });
  });

  it('is idempotent for create_entity replay', async () => {
    await withDb(async ({ run }) => {
      const first = okResults(await run({ op: 'create_entity', key: 'carl' }));
      const second = okResults(await run({ op: 'create_entity', key: 'carl' }));
      expect(first[0]!.created).toBe(true);
      expect(second[0]!.created).toBe(false);
    });
  });
  describe('review fixes', () => {
    it('$name bound to a non-evidence op is not evidence; non-create_entity is not an entity', async () => {
      await withDb(async ({ run }) => {
        const pt = { op: 'create_property_type', name: 'shoe', description: 'd', value_type: 'number', single_valued: true, as: 'p' };
        expect(
          errOf(await run(pt, { op: 'add_property', entity: 'bob', property: 'nickname', value: 'x', evidence: '$p' })),
        ).toMatchObject({ op_index: 1, code: 'unknown_ref' });
        expect(
          errOf(await run(pt, { op: 'add_property', entity: '$p', property: 'nickname', value: 'x' })),
        ).toMatchObject({ op_index: 1, code: 'unknown_ref' });
      });
    });

    it('numeric evidence: non-integer / <=0 / absent -> unknown_ref; other types -> invalid_param', async () => {
      await withDb(async ({ run }) => {
        const base = { op: 'add_property', entity: 'bob', property: 'nickname', value: 'x' };
        for (const evidence of [1.5, 0, -3, 999]) {
          expect(errOf(await run({ ...base, evidence }))).toMatchObject({ code: 'unknown_ref' });
        }
        for (const evidence of [true, {}, null, []]) {
          expect(errOf(await run({ ...base, evidence }))).toMatchObject({ code: 'invalid_param' });
        }
      });
    });

    it('error details are snake_case', async () => {
      await withDb(async ({ run }) => {
        const e = errOf(await run({ op: 'add_property', entity: 'bob', property: 'height', value: 'tall' }));
        expect(e.code).toBe('value_type_mismatch');
        expect(e.details).toBeDefined();
        expect(Object.keys(e.details!).every((k) => !/[A-Z]/.test(k))).toBe(true);
        expect(e.details).toHaveProperty('value_type');
      });
    });

    it('a mapped DB-level conflict rolls back earlier ops', async () => {
      await withDb(async ({ pool, run }) => {
        const e = errOf(
          await run(
            { op: 'create_entity', key: 'y' },
            { op: 'add_property', entity: 'y', property: 'job_title', value: 'A' },
            { op: 'add_property', entity: 'y', property: 'job_title', value: 'B' },
          ),
        );
        expect(e).toMatchObject({ op_index: 2, code: 'single_valued_conflict' });
        expect((await pool.query("SELECT 1 FROM entity WHERE key = 'y'")).rows).toHaveLength(0);
      });
    });

    function stubPool(failOn: (sql: string) => unknown) {
      const calls: string[] = [];
      const released: unknown[] = [];
      const client = {
        query: (sql: string) => {
          calls.push(sql);
          const err = failOn(sql);
          return err ? Promise.reject(err) : Promise.resolve({ rows: [], rowCount: 0 });
        },
        release: (err?: unknown) => released.push(err),
      };
      return { pool: { connect: async () => client } as unknown as pg.Pool, calls, released };
    }

    it('pg error mapped via mapPgError -> concurrent_update, ROLLBACK issued', async () => {
      await withDb(async ({ reg }) => {
        const s = stubPool((sql) => (sql.includes('INSERT INTO entity') ? { code: '40P01' } : null));
        const r = await apply(s.pool, reg, { ops: [{ op: 'create_entity', key: 'z' }] });
        expect(errOf(r)).toMatchObject({ op_index: 0, code: 'concurrent_update' });
        expect(s.calls).toContain('ROLLBACK');
        expect(s.released).toEqual([undefined]);
      });
    });

    it('failed ROLLBACK destroys the client but keeps the original error', async () => {
      await withDb(async ({ reg }) => {
        const boom = new Error('rollback failed');
        const s = stubPool((sql) => (sql === 'ROLLBACK' ? boom : null));
        const r = await apply(s.pool, reg, { ops: [{ op: 'frobnicate' }] });
        expect(errOf(r)).toMatchObject({ op_index: 0, code: 'invalid_param' });
        expect(s.released).toEqual([boom]);
      });
    });
  });
});
