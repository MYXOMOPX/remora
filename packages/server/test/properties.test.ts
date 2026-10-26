import { RemoraError } from '@remora/sdk';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  addProperty,
  endProperty,
  replaceProperty,
  retractProperty,
} from '../src/services/properties.js';
import { parseMoment, parseSpans, type Moment, type Span } from '../src/services/time.js';
import { seedAxes } from './helpers/axes.js';
import { seedBasics } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

async function inTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

interface Ctx {
  pool: pg.Pool;
  sp: (raw: unknown) => Span[];
  mo: (axis: string, at: number) => Moment;
}

async function withDb(fn: (c: Ctx) => Promise<void>): Promise<void> {
  const { pool, drop } = await createTestDb();
  try {
    await runMigrations(pool);
    const s = await seedBasics(pool);
    const reg = await seedAxes(pool, s);
    await fn({
      pool,
      sp: (raw) => parseSpans(reg, raw),
      mo: (axis, at) => parseMoment(reg, { axis, at }),
    });
  } finally {
    await drop();
  }
}

const gd = (from?: number, to?: number): unknown => ({ axis: 'game_day', from, to });

async function rows(
  pool: pg.Pool,
): Promise<{ id: string; lo: string | null; hi: string | null; value: unknown }[]> {
  const r = await pool.query(
    `SELECT id, lower(time_span) AS lo, upper(time_span) AS hi, value FROM property_version ORDER BY id`,
  );
  return r.rows;
}

const job = (value: string) => ({ entity: 'bob', property: 'job_title', value });

describe('property writes', () => {
  it('spec table: replace, replace, end', () =>
    withDb(async ({ pool, mo }) => {
      const a = await inTx(pool, (c) => replaceProperty(c, { ...job('Junior'), moment: mo('game_day', 292) }));
      const b = await inTx(pool, (c) =>
        replaceProperty(c, { entity: 'bob', property: 'Job Title', value: 'Senior', moment: mo('game_day', 300) }),
      );
      expect(b.closed).toEqual(a.ids);
      expect(a.closed).toEqual([]);
      expect(a.retracted).toEqual([]);
      const e = await inTx(pool, (c) =>
        endProperty(c, { entity: 'bob', property: 'job_title', moment: mo('game_day', 310) }),
      );
      expect(e.closed).toEqual(b.ids);
      const rs = await rows(pool);
      expect(rs.map((r) => [r.value, r.lo, r.hi])).toEqual([
        ['Junior', '292', '300'],
        ['Senior', '300', '310'],
      ]);
    }));

  it('multi-valued nickname values coexist', () =>
    withDb(async ({ pool, sp }) => {
      await inTx(pool, (c) => addProperty(c, { entity: 'bob', property: 'nickname', value: 'A', spans: sp(gd(292)) }));
      await inTx(pool, (c) => addProperty(c, { entity: 'bob', property: 'nickname', value: 'B', spans: sp(gd(295)) }));
      expect(await rows(pool)).toHaveLength(2);
    }));

  it('one row per span', () =>
    withDb(async ({ pool, sp }) => {
      const r = await inTx(pool, (c) =>
        addProperty(c, { ...job('X'), spans: sp([gd(1, 2), { axis: 'real', from: 5 }]) }),
      );
      expect(r.ids).toHaveLength(2);
    }));

  it('single-valued overlap conflicts; other axis ok', () =>
    withDb(async ({ pool, sp }) => {
      await inTx(pool, (c) => addProperty(c, { ...job('A'), spans: sp(gd(292)) }));
      await inTx(pool, (c) => addProperty(c, { ...job('B'), spans: sp({ axis: 'real', from: 300 }) }));
      await expect(
        inTx(pool, (c) => addProperty(c, { ...job('C'), spans: sp(gd(300)) })),
      ).rejects.toMatchObject({ code: 'single_valued_conflict' });
    }));

  it('R2: closing before from is invalid_time', () =>
    withDb(async ({ pool, sp, mo }) => {
      await inTx(pool, (c) => addProperty(c, { ...job('A'), spans: sp(gd(292)) }));
      await expect(
        inTx(pool, (c) => replaceProperty(c, { ...job('B'), moment: mo('game_day', 291) })),
      ).rejects.toMatchObject({ code: 'invalid_time' });
      const rs = await rows(pool);
      expect(rs).toHaveLength(1);
      expect([rs[0]!.lo, rs[0]!.hi]).toEqual(['292', null]);
    }));

  it('R2: closing at from is invalid_time', () =>
    withDb(async ({ pool, sp, mo }) => {
      await inTx(pool, (c) => addProperty(c, { ...job('A'), spans: sp(gd(292)) }));
      await expect(
        inTx(pool, (c) => replaceProperty(c, { ...job('B'), moment: mo('game_day', 292) })),
      ).rejects.toMatchObject({ code: 'invalid_time' });
      const rs = await rows(pool);
      expect(rs).toHaveLength(1);
      expect([rs[0]!.lo, rs[0]!.hi]).toEqual(['292', null]);
    }));

  describe('R3', () => {
    it('timeless then timed add', () =>
      withDb(async ({ pool, sp }) => {
        await inTx(pool, (c) => addProperty(c, { ...job('A'), spans: [] }));
        await expect(
          inTx(pool, (c) => addProperty(c, { ...job('B'), spans: sp(gd(1)) })),
        ).rejects.toMatchObject({ code: 'timeless_conflict' });
      }));
    it('timed then timeless add', () =>
      withDb(async ({ pool, sp }) => {
        await inTx(pool, (c) => addProperty(c, { ...job('A'), spans: sp(gd(1)) }));
        await expect(
          inTx(pool, (c) => addProperty(c, { ...job('B'), spans: [] })),
        ).rejects.toMatchObject({ code: 'timeless_conflict' });
      }));
    it('timeless add then timed replace', () =>
      withDb(async ({ pool, mo }) => {
        await inTx(pool, (c) => addProperty(c, { ...job('A'), spans: [] }));
        await expect(
          inTx(pool, (c) => replaceProperty(c, { ...job('B'), moment: mo('game_day', 5) })),
        ).rejects.toMatchObject({ code: 'timeless_conflict' });
      }));
    it('timed add, end, then timeless replace (closed rows count)', () =>
      withDb(async ({ pool, sp, mo }) => {
        await inTx(pool, (c) => addProperty(c, { ...job('A'), spans: sp(gd(1)) }));
        await inTx(pool, (c) => endProperty(c, { entity: 'bob', property: 'job_title', moment: mo('game_day', 5) }));
        await expect(
          inTx(pool, (c) => replaceProperty(c, job('B'))),
        ).rejects.toMatchObject({ code: 'timeless_conflict' });
      }));
    it('two timeless adds', () =>
      withDb(async ({ pool }) => {
        await inTx(pool, (c) => addProperty(c, { ...job('A'), spans: [] }));
        await expect(
          inTx(pool, (c) => addProperty(c, { ...job('B'), spans: [] })),
        ).rejects.toMatchObject({ code: 'single_valued_conflict' });
      }));
    it('timeless replace twice retracts the first', () =>
      withDb(async ({ pool }) => {
        const a = await inTx(pool, (c) => replaceProperty(c, job('A')));
        const b = await inTx(pool, (c) => replaceProperty(c, job('B')));
        expect(b.retracted).toEqual(a.ids);
        expect(b.closed).toEqual([]);
        const r = await pool.query(`SELECT value FROM property_version WHERE retracted_at IS NULL`);
        expect(r.rows).toEqual([{ value: 'B' }]);
      }));
    it('multi-valued: timeless and timed both succeed', () =>
      withDb(async ({ pool, sp }) => {
        await inTx(pool, (c) => addProperty(c, { entity: 'bob', property: 'nickname', value: 'A', spans: [] }));
        await inTx(pool, (c) => addProperty(c, { entity: 'bob', property: 'nickname', value: 'B', spans: sp(gd(1)) }));
        expect(await rows(pool)).toHaveLength(2);
      }));
  });

  it('retraction frees the interval; repeat and unknown id are not_found', () =>
    withDb(async ({ pool, sp }) => {
      const a = await inTx(pool, (c) => addProperty(c, { ...job('A'), spans: sp(gd(292)) }));
      await inTx(pool, (c) => retractProperty(c, { id: a.ids[0]! }));
      await inTx(pool, (c) => addProperty(c, { ...job('B'), spans: sp(gd(300)) }));
      await expect(inTx(pool, (c) => retractProperty(c, { id: a.ids[0]! }))).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(inTx(pool, (c) => retractProperty(c, { id: 999999n }))).rejects.toMatchObject({
        code: 'not_found',
      });
    }));

  it('end with nothing open is not_found', () =>
    withDb(async ({ pool, mo }) => {
      await expect(
        inTx(pool, (c) => endProperty(c, { entity: 'bob', property: 'job_title', moment: mo('game_day', 5) })),
      ).rejects.toMatchObject({ code: 'not_found' });
    }));

  it('unknown property type', () =>
    withDb(async ({ pool }) => {
      await expect(
        inTx(pool, (c) => addProperty(c, { entity: 'bob', property: 'nope', value: 'x', spans: [] })),
      ).rejects.toMatchObject({ code: 'unknown_type', details: { name: 'nope' } });
    }));

  it('unknown entity', () =>
    withDb(async ({ pool }) => {
      await expect(
        inTx(pool, (c) => addProperty(c, { entity: 'nobody', property: 'job_title', value: 'x', spans: [] })),
      ).rejects.toMatchObject({ code: 'unknown_entity' });
    }));

  it('value of wrong type', () =>
    withDb(async ({ pool }) => {
      await expect(
        inTx(pool, (c) => addProperty(c, { entity: 'bob', property: 'job_title', value: 5, spans: [] })),
      ).rejects.toMatchObject({ code: 'value_type_mismatch' });
    }));

  it('json value that does not serialise is value_type_mismatch', () =>
    withDb(async ({ pool }) => {
      await pool.query(
        `INSERT INTO property_type (name, description, value_type, single_valued) VALUES ('blob','d','json',false)`,
      );
      await expect(
        inTx(pool, (c) => addProperty(c, { entity: 'bob', property: 'blob', value: { a: 1n }, spans: [] })),
      ).rejects.toMatchObject({ code: 'value_type_mismatch' });
      await expect(
        inTx(pool, (c) => addProperty(c, { entity: 'bob', property: 'blob', value: () => 1, spans: [] })),
      ).rejects.toMatchObject({ code: 'value_type_mismatch' });
      await inTx(pool, (c) => addProperty(c, { entity: 'bob', property: 'blob', value: [1, 'a'], spans: [] }));
      const r = await pool.query(`SELECT value FROM property_version`);
      expect(r.rows[0].value).toEqual([1, 'a']);
    }));

  it('string value stored as jsonb string', () =>
    withDb(async ({ pool }) => {
      await inTx(pool, (c) => addProperty(c, { entity: 'bob', property: 'nickname', value: 'Bobby', spans: [] }));
      const r = await pool.query(`SELECT value, jsonb_typeof(value) AS t FROM property_version`);
      expect(r.rows[0]).toEqual({ value: 'Bobby', t: 'string' });
    }));

  it('concurrent replaces: success or invalid_time, one open row remains', () =>
    withDb(async ({ pool, sp, mo }) => {
      await inTx(pool, (c) => addProperty(c, { ...job('Junior'), spans: sp(gd(292)) }));
      const run = (at: number, v: string): Promise<string> =>
        inTx(pool, (c) => replaceProperty(c, { ...job(v), moment: mo('game_day', at) })).then(
          () => 'ok',
          (e: unknown) => {
            if (e instanceof RemoraError) return e.code;
            throw e;
          },
        );
      const out = await Promise.all([run(300, 'A'), run(301, 'B')]);
      for (const o of out) expect(['ok', 'invalid_time']).toContain(o);
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM property_version WHERE retracted_at IS NULL AND upper(time_span) IS NULL`,
      );
      expect(r.rows[0].n).toBe(1);
    }));
});
